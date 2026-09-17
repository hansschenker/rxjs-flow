import { vi } from 'vitest';
import { createProgram, type Transition } from './program';

describe('createProgram()', () => {
	it('is inert until its single start, including subscriptions and early dispatch', () => {
		const initialState = vi.fn(() => 0);
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState, reduce });
		const states: number[] = [];
		const transitions: Transition<number, number>[] = [];
		program.state$.subscribe(state => states.push(state));
		program.transitions$.subscribe(transition => transitions.push(transition));
		expect(program.closed).toBe(false);
		expect(program.dispatch(10)).toBe(false);
		expect(initialState).not.toHaveBeenCalled();
		expect(reduce).not.toHaveBeenCalled();
		expect(states).toEqual([]);
		program.start();
		program.start();
		expect(initialState).toHaveBeenCalledOnce();
		expect(states).toEqual([0]);
		expect(transitions).toEqual([]);
		expect('next' in program.state$).toBe(false);
		expect('next' in program.transitions$).toBe(false);
		program.dispose();
	});

	it('queues initial-state feedback until all consumers and the input subscription are ready', () => {
		const program = createProgram({ initialState: () => 0, reduce: (state, message: number) => state + message });
		const events: string[] = [];
		program.state$.subscribe(state => {
			events.push(`first:${state}`);
			if (state === 0) {
				expect(program.dispatch(1)).toBe(true);
				program.start();
			}
		});
		program.state$.subscribe(state => events.push(`second:${state}`));
		program.transitions$.subscribe(({ message, previous, state }) => events.push(`${message}:${previous}->${state}`));
		program.start();
		expect(events).toEqual(['first:0', 'second:0', 'first:1', 'second:1', '1:0->1']);
		program.dispose();
	});

	it('publishes each complete state and transition before reducing synchronous feedback', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce });
		const events: string[] = [];
		program.state$.subscribe(state => {
			events.push(`state-a:${state}`);
			if (state === 1) program.dispatch(2);
		});
		program.state$.subscribe(state => events.push(`state-b:${state}`));
		program.transitions$.subscribe(({ state }) => {
			events.push(`transition-a:${state}`);
			if (state === 1) program.dispatch(4);
		});
		program.transitions$.subscribe(({ state }) => events.push(`transition-b:${state}`));
		program.start();
		program.dispatch(1);
		expect(events).toEqual([
			'state-a:0', 'state-b:0',
			'state-a:1', 'state-b:1', 'transition-a:1', 'transition-b:1',
			'state-a:3', 'state-b:3', 'transition-a:3', 'transition-b:3',
			'state-a:7', 'state-b:7', 'transition-a:7', 'transition-b:7',
		]);
		expect(reduce.mock.calls).toEqual([[0, 1], [1, 2], [3, 4]]);
		program.dispose();
	});

	it('pairs the accepted message with the exact prior and next reducer snapshots', () => {
		const initial = { count: 1 };
		const firstMessage = { add: 2 };
		const secondMessage = { add: 0 };
		const program = createProgram({
			initialState: () => initial,
			reduce: (state, message: { add: number }) => message.add === 0 ? state : { count: state.count + message.add },
		});
		const states: typeof initial[] = [];
		const transitions: Transition<typeof initial, typeof firstMessage>[] = [];
		program.state$.subscribe(state => states.push(state));
		program.transitions$.subscribe(transition => transitions.push(transition));
		program.start();
		program.dispatch(firstMessage);
		program.dispatch(secondMessage);
		expect(transitions).toEqual([
			{ message: firstMessage, previous: initial, state: { count: 3 } },
			{ message: secondMessage, previous: { count: 3 }, state: { count: 3 } },
		]);
		expect(transitions[0].message).toBe(firstMessage);
		expect(transitions[0].previous).toBe(initial);
		expect(transitions[0].state).toBe(states[1]);
		expect(transitions[1].previous).toBe(states[1]);
		expect(transitions[1].state).toBe(states[1]);
		program.dispose();
	});

	it('replays only current state to a late consumer and never replays transitions', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce });
		program.start();
		program.dispatch(1);
		program.dispatch(2);
		const states: number[] = [];
		const transitions: Transition<number, number>[] = [];
		program.state$.subscribe(state => states.push(state));
		program.transitions$.subscribe(transition => transitions.push(transition));
		expect(states).toEqual([3]);
		expect(transitions).toEqual([]);
		expect(reduce).toHaveBeenCalledTimes(2);
		program.dispatch(4);
		expect(states).toEqual([3, 7]);
		expect(transitions).toEqual([{ message: 4, previous: 3, state: 7 }]);
		expect(reduce).toHaveBeenCalledTimes(3);
		program.dispose();
	});

	it('keeps one root accumulation through a gap with no consumers', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce });
		const first = program.state$.subscribe();
		program.start();
		program.dispatch(1);
		first.unsubscribe();
		program.dispatch(2);
		program.dispatch(3);
		const resumed: number[] = [];
		program.state$.subscribe(state => resumed.push(state));
		expect(resumed).toEqual([6]);
		expect(reduce.mock.calls).toEqual([[0, 1], [1, 2], [3, 3]]);
		program.dispose();
	});

	it('isolates instances and initializes a fresh instance after disposal', () => {
		const initialState = vi.fn(() => ({ count: 0 }));
		const options = { initialState, reduce: (state: { count: number }, message: number) => ({ count: state.count + message }) };
		const first = createProgram(options);
		const second = createProgram(options);
		const firstStates: { count: number }[] = [];
		const secondStates: { count: number }[] = [];
		first.state$.subscribe(state => firstStates.push(state));
		second.state$.subscribe(state => secondStates.push(state));
		first.start();
		second.start();
		first.dispatch(2);
		expect(secondStates).toEqual([{ count: 0 }]);
		expect(firstStates[0]).not.toBe(secondStates[0]);
		first.dispose();
		second.dispatch(3);
		const fresh = createProgram(options);
		const freshStates: { count: number }[] = [];
		fresh.state$.subscribe(state => freshStates.push(state));
		fresh.start();
		expect(freshStates).toEqual([{ count: 0 }]);
		expect(secondStates).toEqual([{ count: 0 }, { count: 3 }]);
		expect(initialState).toHaveBeenCalledTimes(3);
		second.dispose();
		fresh.dispose();
	});

	it('disposes before start without initializing and completes existing and later consumers', () => {
		const initialState = vi.fn(() => 0);
		const program = createProgram({ initialState, reduce: (state, message: number) => state + message });
		const completed = vi.fn();
		const received = vi.fn();
		program.state$.subscribe({ next: received, complete: completed });
		program.transitions$.subscribe({ next: received, complete: completed });
		program.dispose();
		program.dispose();
		program.start();
		expect(program.dispatch(1)).toBe(false);
		program.state$.subscribe({ next: received, complete: completed });
		program.transitions$.subscribe({ next: received, complete: completed });
		expect(program.closed).toBe(true);
		expect(initialState).not.toHaveBeenCalled();
		expect(received).not.toHaveBeenCalled();
		expect(completed).toHaveBeenCalledTimes(4);
	});

	it('drops queued startup feedback when an initial consumer disposes the program', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce });
		const first: number[] = [];
		const second = vi.fn();
		const transitioned = vi.fn();
		program.state$.subscribe(state => {
			first.push(state);
			program.dispatch(1);
			program.dispose();
		});
		const secondSubscription = program.state$.subscribe(second);
		program.transitions$.subscribe(transitioned);
		program.start();
		expect(first).toEqual([0]);
		expect(second).not.toHaveBeenCalled();
		expect(transitioned).not.toHaveBeenCalled();
		expect(secondSubscription.closed).toBe(true);
		expect(reduce).not.toHaveBeenCalled();
		expect(program.dispatch(2)).toBe(false);
	});

	it('stops publication and clears feedback when a state consumer disposes during a transition', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce });
		const second: number[] = [];
		const transitioned = vi.fn();
		program.state$.subscribe(state => {
			if (state === 1) {
				program.dispatch(2);
				program.dispose();
			}
		});
		program.state$.subscribe(state => second.push(state));
		program.transitions$.subscribe(transitioned);
		program.start();
		program.dispatch(1);
		expect(second).toEqual([0]);
		expect(transitioned).not.toHaveBeenCalled();
		expect(reduce).toHaveBeenCalledExactlyOnceWith(0, 1);
		expect(program.dispatch(3)).toBe(false);
	});

	it('clears queued feedback when a transition consumer disposes', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce });
		const second = vi.fn();
		program.transitions$.subscribe(() => {
			program.dispatch(2);
			program.dispose();
		});
		program.transitions$.subscribe(second);
		program.start();
		program.dispatch(1);
		expect(second).not.toHaveBeenCalled();
		expect(reduce).toHaveBeenCalledExactlyOnceWith(0, 1);
	});

	it('does not publish a reducer result after synchronous disposal', () => {
		const program = createProgram({
			initialState: () => 0,
			reduce: (state, message: number) => {
				program.dispose();
				return state + message;
			},
		});
		const states: number[] = [];
		const transitioned = vi.fn();
		program.state$.subscribe(state => states.push(state));
		program.transitions$.subscribe(transitioned);
		program.start();
		program.dispatch(1);
		expect(states).toEqual([0]);
		expect(transitioned).not.toHaveBeenCalled();
		expect(program.closed).toBe(true);
	});

	it('reports an initializer fault to consumers and closes the program', () => {
		const error = new Error('initial state failed');
		const initialState = vi.fn((): number => { throw error; });
		const program = createProgram({ initialState, reduce: (state, message: number) => state + message });
		const stateError = vi.fn();
		const transitionError = vi.fn();
		program.state$.subscribe({ error: stateError });
		program.transitions$.subscribe({ error: transitionError });
		program.start();
		program.start();
		expect(initialState).toHaveBeenCalledOnce();
		expect(stateError).toHaveBeenCalledExactlyOnceWith(error);
		expect(transitionError).toHaveBeenCalledExactlyOnceWith(error);
		expect(program.closed).toBe(true);
		expect(program.dispatch(1)).toBe(false);
	});

	it('reports a reducer fault, drops queued input, and releases its current state', () => {
		const error = new Error('reduction failed');
		const reduce = vi.fn((state: number, message: number) => {
			if (message === 2) throw error;
			return state + message;
		});
		const program = createProgram({ initialState: () => 0, reduce });
		const states: number[] = [];
		const stateError = vi.fn();
		const transitionError = vi.fn();
		program.state$.subscribe({ next: state => {
			states.push(state);
			if (state === 1) {
				program.dispatch(2);
				program.dispatch(3);
			}
		}, error: stateError });
		program.transitions$.subscribe({ error: transitionError });
		program.start();
		program.dispatch(1);
		program.state$.subscribe(state => states.push(state));
		expect(states).toEqual([0, 1]);
		expect(reduce.mock.calls).toEqual([[0, 1], [1, 2]]);
		expect(stateError).toHaveBeenCalledExactlyOnceWith(error);
		expect(transitionError).toHaveBeenCalledExactlyOnceWith(error);
		expect(program.closed).toBe(true);
		expect(program.dispatch(4)).toBe(false);
	});

	it('never replays disposed state or restarts, even from a completion callback', () => {
		const initialState = vi.fn(() => ({ retained: 'old state' }));
		const program = createProgram({ initialState, reduce: state => state });
		const late = vi.fn();
		const completed = vi.fn();
		program.state$.subscribe({ complete: () => {
			program.state$.subscribe({ next: late, complete: completed });
			expect(program.dispatch(undefined)).toBe(false);
			program.start();
		} });
		program.start();
		program.dispose();
		program.dispose();
		program.state$.subscribe({ next: late, complete: completed });
		program.transitions$.subscribe({ next: late, complete: completed });
		expect(late).not.toHaveBeenCalled();
		expect(completed).toHaveBeenCalledTimes(3);
		expect(initialState).toHaveBeenCalledOnce();
	});

	it('drains a long synchronous feedback chain without nesting or repeated reductions', () => {
		const reduce = vi.fn((state: number, _message: undefined) => state + 1);
		const program = createProgram({ initialState: () => 0, reduce });
		let published = 0;
		let last = 0;
		program.state$.subscribe(state => {
			if (state < 10_000) program.dispatch(undefined);
		});
		program.state$.subscribe(state => { last = state; published += 1; });
		program.start();
		expect(last).toBe(10_000);
		expect(published).toBe(10_001);
		expect(reduce).toHaveBeenCalledTimes(10_000);
		program.dispose();
	});
});
