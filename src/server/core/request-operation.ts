import {
	asyncScheduler,
	ReplaySubject,
	Subscriber,
	Subscription,
	timer,
	type Observable,
	type SchedulerLike,
} from 'rxjs';
import { errorResponse, HttpError } from './errors';

export type RequestOutcome<T> =
	| { kind: 'success'; value: T }
	| { kind: 'failure'; status: number; body: { error: string; details?: unknown } };

export interface RequestOperationOptions<T> {
	signal: AbortSignal;
	execute: (signal: AbortSignal) => Observable<T>;
	deadlineMs?: number;
	scheduler?: SchedulerLike;
	onFault?: (error: unknown) => void;
}

export interface RequestOperation<T> {
	result$: Observable<RequestOutcome<T>>;
	start: () => void;
	dispose: () => void;
}

const failure = (status: number, error: string): RequestOutcome<never> => ({
	kind: 'failure', status, body: { error },
});

/**
 * One explicit owner executes the finite operation, independently of its result
 * observers. A response is valid only after exactly one value AND completion.
 * The absolute deadline covers construction, decoding and execution; emitting a
 * value does not restart it. A streaming descriptor is a value here: its body
 * must have its own owner and is never subscribed by this operation.
 */
export const createRequestOperation = <T>(
	options: RequestOperationOptions<T>,
): RequestOperation<T> => {
	const results = new ReplaySubject<RequestOutcome<T>>(1);
	const owner = new Subscription();
	const controller = new AbortController();
	let started = false;
	let settled = false;
	let count = 0;
	let candidate: T | undefined;
	const scheduler = options.scheduler ?? asyncScheduler;
	let expiresAt = Infinity;

	const reportFault = (error: unknown): void => {
		try {
			if (options.onFault) options.onFault(error);
			else console.error(error);
		} catch {
			// Reporting must not escape into another request or prevent cleanup.
		}
	};

	const release = (): void => {
		try {
			owner.unsubscribe();
		} catch (error) {
			reportFault(error);
		}
	};

	const settle = (outcome: RequestOutcome<T>): void => {
		if (settled) return;
		settled = true;
		candidate = undefined;
		// Close the registered subscribers first so abort-related emissions cannot
		// replace the terminal outcome. Subscription runs all registered finalizers
		// even when one throws; release catches its aggregated teardown error.
		release();
		if (outcome.kind === 'failure') {
			try {
				controller.abort(outcome.body.error);
			} catch (error) {
				reportFault(error);
			}
		}
		results.next(outcome);
		results.complete();
	};

	const fail = (error: unknown): void => {
		if (settled) {
			// A synchronous initializer may return a throwing teardown after it has
			// already completed. Its outcome stays settled, but its fault is reported.
			reportFault(error);
			return;
		}
		if (error instanceof HttpError) {
			const response = errorResponse(error);
			settle({
				kind: 'failure',
				status: response.status!,
				body: response.body as { error: string; details?: unknown },
			});
			return;
		}
		settle(failure(500, 'Internal server error'));
		reportFault(error);
	};

	const cancel = (): void => settle(failure(499, 'Request canceled'));
	const expire = (): void => settle(failure(504, 'Request deadline exceeded'));
	const ignoreCompletion = (): void => {};
	const expired = (): boolean => {
		if (scheduler.now() < expiresAt) return false;
		expire();
		return true;
	};

	const acceptValue = (value: T): void => {
		if (expired()) return;
		if (count !== 0) {
			settle(failure(500, 'Finite operation emitted multiple responses'));
			return;
		}
		count = 1;
		candidate = value;
	};

	const acceptCompletion = (): void => {
		if (expired()) return;
		if (count === 0) settle(failure(500, 'Finite operation completed without a response'));
		else settle({ kind: 'success', value: candidate as T });
	};

	const start = (): void => {
		if (started || settled) return;
		started = true;
		if (options.signal.aborted) {
			cancel();
			return;
		}

		try {
			const deadlineMs = options.deadlineMs ?? 10_000;
			if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
				throw new RangeError('Request deadline must be a finite nonnegative duration');
			}
			expiresAt = scheduler.now() + deadlineMs;
			options.signal.addEventListener('abort', cancel, { once: true });
			owner.add(() => options.signal.removeEventListener('abort', cancel));
			if (options.signal.aborted) {
				cancel();
				return;
			}

			const deadline = new Subscriber<number>({
				next: expire, error: fail, complete: ignoreCompletion,
			});
			owner.add(deadline);
			timer(deadlineMs, scheduler).subscribe(deadline);
			if (settled || expired()) return;

			// Register before both construction and subscription: either may
			// synchronously reenter dispose(), complete(), error(), or abort().
			const execution = new Subscriber<T>({
				next: acceptValue, error: fail, complete: acceptCompletion,
			});
			owner.add(execution);
			const operation$ = options.execute(controller.signal);
			// A blocking initializer can delay a timer callback. JavaScript cannot
			// preempt it, but a result past the absolute deadline is still rejected.
			if (!settled && !expired()) operation$.subscribe(execution);
		} catch (error) {
			fail(error);
		}
	};

	return { result$: results.asObservable(), start, dispose: cancel };
};
