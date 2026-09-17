import { Observable, ReplaySubject, Subject, scan, startWith } from 'rxjs';
import { createScope } from './scope';

export interface Transition<State, Message> {
	readonly message: Message;
	readonly previous: State;
	readonly state: State;
}

export interface Program<State, Message> {
	readonly state$: Observable<State>;
	readonly transitions$: Observable<Transition<State, Message>>;
	readonly closed: boolean;
	start(): void;
	dispose(): void;
	/** True means accepted; reentrant input waits for the current publication. */
	dispatch(message: Message): boolean;
}

export interface ProgramOptions<State, Message> {
	readonly initialState: () => State;
	readonly reduce: (state: State, message: Message) => State;
}

interface Frame<State, Message> {
	readonly state: State;
	readonly transition?: Transition<State, Message>;
}

/** One inert state machine; its root owns accumulation until explicit disposal. */
export function createProgram<State, Message>(options: ProgramOptions<State, Message>): Program<State, Message> {
	const scope = createScope();
	const input = new Subject<Message>();
	let states = new ReplaySubject<State>(1);
	const transitions = new Subject<Transition<State, Message>>();
	const queue: Message[] = [];
	let started = false;
	let starting = false;
	let draining = false;
	let closed = false;

	// Indirection also lets disposal release the old replay buffer while callers
	// retain this program or either public Observable. Subjects stay private.
	const state$ = new Observable<State>(subscriber => states.subscribe(subscriber));
	const transitions$ = new Observable<Transition<State, Message>>(subscriber => transitions.subscribe(subscriber));

	function finish(failure?: { readonly error: unknown }): void {
		if (closed) return;
		closed = true;
		queue.length = 0;
		const previousStates = states;
		states = new ReplaySubject<State>(1);
		states.complete();
		// Replace before notifying completion, so a reentrant late subscription
		// cannot replay disposed state. Completing a ReplaySubject alone retains it.
		if (failure) {
			previousStates.error(failure.error);
			transitions.error(failure.error);
		} else {
			previousStates.complete();
			transitions.complete();
		}
		input.complete();
		scope.dispose();
	}

	function drain(): void {
		if (starting || draining || closed) return;
		draining = true;
		let next = 0;
		try {
			// Cursor-based FIFO avoids both recursive feedback and repeated shifting.
			// A dispatch from any observer waits until state AND transition publish.
			while (!closed && next < queue.length) input.next(queue[next++]);
		} finally {
			queue.length = 0;
			draining = false;
		}
	}

	function start(): void {
		if (started || closed) return;
		started = true;
		starting = true;
		try {
			const initial: Frame<State, Message> = { state: options.initialState() };
			if (closed) return;
			const accumulation = input.pipe(
				scan<Message, Frame<State, Message>>((previous, message) => {
					const state = options.reduce(previous.state, message);
					return { state, transition: { message, previous: previous.state, state } };
				}, initial),
				startWith(initial),
			);
			// Own the subscriber before startWith can synchronously publish initial.
			scope.subscribe(accumulation, {
				next: frame => {
					if (closed) return;
					states.next(frame.state);
					if (!closed && frame.transition) transitions.next(frame.transition);
				},
				error: error => finish({ error }),
			});
		} catch (error) {
			finish({ error });
		} finally {
			starting = false;
		}
		// startWith emits before subscribing to input; startup feedback must wait
		// until that subscription has returned, even with synchronous consumers.
		drain();
	}

	return {
		state$,
		transitions$,
		get closed() { return closed; },
		start,
		dispose: () => finish(),
		dispatch(message) {
			if (!started || closed) return false;
			queue.push(message);
			drain();
			return true;
		},
	};
}
