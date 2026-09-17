import { describe, expect, it, vi } from 'vitest';
import { EMPTY, NEVER, Observable, Subject, of, take, throwError } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { createRequestFailure } from '../shared/http-error';
import type { Todo } from '../shared/types';
import type { Transition } from './runtime/program';
import { todoEffects$ } from './todo.effects';
import { createTodoModel } from './todo.model';
import type { TodoService } from './todo.service';
import { createInitialState, type Action, type State } from './todo.state';

const first: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };
const second: Todo = { ...first, id: '2', title: 'Second' };
const populated: State = { ...createInitialState(), todos: [first, second] };
const load: Action = { type: 'LOAD_REQUESTED' };
const create: Action = { type: 'CREATE_REQUESTED', title: 'Created' };
const update: Action = { type: 'TOGGLE_REQUESTED', id: '1', completed: true };
const remove: Action = { type: 'DELETE_REQUESTED', id: '2' };

function transition(message: Action, state = populated): Transition<State, Action> {
	return { message, previous: state, state };
}

function service(overrides: Partial<TodoService> = {}): TodoService {
	return {
		getAll$: vi.fn(() => of([first, second])),
		create$: vi.fn(body => of({ ...first, id: '3', title: body.title })),
		update$: vi.fn((id, body) => of({ ...first, id, ...body })),
		remove$: vi.fn(() => of(undefined)),
		...overrides,
	};
}

function scheduler(): TestScheduler {
	return new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
}

function terminal(actions: Action[]): Action[] {
	return actions.filter(action => action.type.endsWith('_SUCCEEDED') || action.type === 'OPERATION_FAILED');
}

describe('Todo effect temporal policies', () => {
	it('switches to the latest read, cancels its predecessor before the next start and blocks stale success', () => {
		const clock = scheduler();
		clock.run(({ cold, hot, expectSubscriptions, flush }) => {
			const oldRead = cold('-----x|', { x: [first] });
			const newRead = cold('--y|', { y: [second] });
			const getAll$ = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(newRead);
			const events: Array<[number, Action]> = [];
			todoEffects$(hot('a--b------|', { a: transition(load), b: transition(load) }), service({ getAll$ }))
				.subscribe(action => events.push([clock.frame, action]));
			expectSubscriptions(oldRead.subscriptions).toBe('^--!');
			expectSubscriptions(newRead.subscriptions).toBe('---^-!');
			flush();
			expect(events).toEqual([
				[0, { type: 'OPERATION_STARTED', operation: { id: '1', kind: 'load' } }],
				[3, { type: 'OPERATION_CANCELLED', operationId: '1' }],
				[3, { type: 'OPERATION_STARTED', operation: { id: '2', kind: 'load' } }],
				[5, { type: 'LOAD_SUCCEEDED', operationId: '2', todos: [second] }],
			]);
			expect(getAll$).toHaveBeenCalledTimes(2);
		});
	});

	it('serializes update, delete and create together and continues in order after a failed write', () => {
		const clock = scheduler();
		clock.run(({ cold, hot, expectSubscriptions, flush }) => {
			const updateResult = cold('----x|', { x: { ...first, completed: true } });
			const deleteResult = cold<void>('--#', {}, new Error('Delete refused'));
			const createResult = cold('-y|', { y: { ...first, id: '3', title: 'Created' } });
			const events: Array<[number, Action]> = [];
			todoEffects$(hot('a-b-c-------|', { a: transition(update), b: transition(remove), c: transition(create) }), service({
				update$: () => updateResult, remove$: () => deleteResult, create$: () => createResult,
			})).subscribe(action => events.push([clock.frame, action]));
			expectSubscriptions(updateResult.subscriptions).toBe('^---!');
			expectSubscriptions(deleteResult.subscriptions).toBe('----^-!');
			expectSubscriptions(createResult.subscriptions).toBe('------^!');
			flush();
			expect(events.filter(([, action]) => action.type === 'OPERATION_QUEUED').map(([time]) => time)).toEqual([0, 2, 4]);
			expect(events.filter(([, action]) => action.type === 'OPERATION_STARTED').map(([time, action]) =>
				[time, action.type === 'OPERATION_STARTED' && action.operation.kind])).toEqual([[0, 'update'], [4, 'delete'], [6, 'create']]);
			expect(terminal(events.map(([, action]) => action)).map(action => action.type)).toEqual([
				'UPDATE_SUCCEEDED', 'OPERATION_FAILED', 'CREATE_SUCCEEDED',
			]);
		});
	});

	it('holds create exhaustion while its captured title waits behind another mutation', () => {
		const clock = scheduler();
		clock.run(({ cold, hot, expectSubscriptions, flush }) => {
			const updateResult = cold('------u|', { u: first });
			const createResult = cold('---c|', { c: { ...first, id: '3' } });
			const create$ = vi.fn(() => createResult);
			const events: Action[] = [];
			todoEffects$(hot('ab-c------d----|', {
				a: transition(update), b: transition({ type: 'CREATE_REQUESTED', title: '  Captured  ' }),
				c: transition({ type: 'CREATE_REQUESTED', title: 'Ignored' }),
				d: transition({ type: 'CREATE_REQUESTED', title: 'Next' }),
			}), service({ update$: () => updateResult, create$ })).subscribe(action => events.push(action));
			expectSubscriptions(updateResult.subscriptions).toBe('^-----!');
			expectSubscriptions(createResult.subscriptions).toBe(['------^--!', '----------^--!']);
			flush();
			expect(create$.mock.calls).toEqual([[{ title: 'Captured' }], [{ title: 'Next' }]]);
			expect(events.filter(action => action.type === 'OPERATION_QUEUED')).toEqual([
				{ type: 'OPERATION_QUEUED', operation: { id: '1', kind: 'update', todoId: '1' } },
				{ type: 'OPERATION_QUEUED', operation: { id: '2', kind: 'create', title: 'Captured' } },
				{ type: 'OPERATION_QUEUED', operation: { id: '3', kind: 'create', title: 'Next' } },
			]);
		});
	});

	it('bounds active plus waiting writes, visibly rejects overflow and releases rejected create admission', () => {
		const clock = scheduler();
		clock.run(({ cold, hot, expectSubscriptions, flush }) => {
			const updateResult = cold('-----u|', { u: first });
			const deleteResult = cold('--d|', { d: undefined });
			const createResult = cold('-c|', { c: { ...first, id: '3' } });
			const create$ = vi.fn(() => createResult);
			const events: Array<[number, Action]> = [];
			todoEffects$(hot('abcd--e-----|', {
				a: transition(update), b: transition(remove), c: transition(create),
				d: transition(create), e: transition(create),
			}), service({ update$: () => updateResult, remove$: () => deleteResult, create$ }), { mutationCapacity: 2 })
				.subscribe(action => events.push([clock.frame, action]));
			expectSubscriptions(updateResult.subscriptions).toBe('^----!');
			expectSubscriptions(deleteResult.subscriptions).toBe('-----^-!');
			expectSubscriptions(createResult.subscriptions).toBe('-------^!');
			flush();
			expect(events.filter(([, action]) => action.type === 'MUTATION_REJECTED').map(([time]) => time)).toEqual([2, 3]);
			expect(events.filter(([, action]) => action.type === 'OPERATION_QUEUED').map(([time]) => time)).toEqual([0, 1, 6]);
			expect(create$).toHaveBeenCalledTimes(1);
			expect(events.filter(([, action]) => action.type === 'MUTATION_REJECTED')[0]?.[1]).toMatchObject({ message: expect.stringContaining('capacity 2') });
		});
	});

	it('uses a default capacity of 32 without activating rejected work', () => {
		const source = new Subject<Transition<State, Action>>();
		const adapter = service({ update$: vi.fn(() => NEVER) });
		const events: Action[] = [];
		const run = todoEffects$(source, adapter).subscribe(action => events.push(action));
		for (let index = 0; index < 33; index++) source.next(transition(update));
		expect(events.filter(action => action.type === 'OPERATION_QUEUED')).toHaveLength(32);
		expect(events.filter(action => action.type === 'MUTATION_REJECTED')).toHaveLength(1);
		expect(adapter.update$).toHaveBeenCalledTimes(1);
		run.unsubscribe();
	});

	it('never lets a replacement read cancel an accepted mutation', () => {
		const clock = scheduler();
		clock.run(({ cold, hot, expectSubscriptions }) => {
			const write = cold('------x|', { x: first });
			const read = cold('----x|', { x: [first] });
			todoEffects$(hot('abc-----|', { a: transition(update), b: transition(load), c: transition(load) }),
				service({ update$: () => write, getAll$: () => read })).subscribe();
			expectSubscriptions(write.subscriptions).toBe('^-----!');
			expectSubscriptions(read.subscriptions).toBe(['-^!', '--^---!']);
		});
	});

	it('unsubscription cancels active reads and writes and never starts queued mutations', () => {
		const clock = scheduler();
		clock.run(({ cold, hot, expectSubscriptions, flush }) => {
			const read = cold('--------x|', { x: [first] });
			const write = cold('--------x|', { x: first });
			const adapter = service({ getAll$: () => read, update$: () => write });
			const events: Action[] = [];
			const run = todoEffects$(hot('abcd-----|', {
				a: transition(load), b: transition(update), c: transition(remove), d: transition(create),
			}), adapter).subscribe(action => events.push(action));
			clock.schedule(() => run.unsubscribe(), 4);
			expectSubscriptions(read.subscriptions).toBe('^---!');
			expectSubscriptions(write.subscriptions).toBe('-^--!');
			flush();
			expect(adapter.remove$).not.toHaveBeenCalled();
			expect(adapter.create$).not.toHaveBeenCalled();
			expect(events.some(action => action.type === 'OPERATION_CANCELLED')).toBe(false);
			expect(terminal(events)).toEqual([]);
		});
	});
});

describe('Todo effect finite outcomes and fault boundaries', () => {
	it.each([
		['load', load, 'getAll$'], ['create', create, 'create$'],
		['update', update, 'update$'], ['delete', remove, 'remove$'],
	] as const)('makes an empty %s operation a recoverable correlated failure', (_kind, message, method) => {
		const source = new Subject<Transition<State, Action>>();
		const adapter = service({ [method]: vi.fn().mockReturnValueOnce(EMPTY).mockImplementation(() => of(
			method === 'getAll$' ? [first] : method === 'remove$' ? undefined : first,
		)) });
		const events: Action[] = [];
		const run = todoEffects$(source, adapter).subscribe(action => events.push(action));
		source.next(transition(message));
		source.next(transition(message));
		expect(terminal(events)[0]).toMatchObject({ type: 'OPERATION_FAILED', operationId: '1', failure: { kind: 'decode' } });
		expect(terminal(events)[1]?.type).toBe(`${_kind.toUpperCase()}_SUCCEEDED`);
		expect(run.closed).toBe(false);
		run.unsubscribe();
	});

	it('preserves a structured failure and accepts another create after failure without retrying', () => {
		const failure = createRequestFailure({ kind: 'http', status: 409, message: 'Conflict', details: { field: 'title' } });
		const adapter = service({ create$: vi.fn().mockReturnValueOnce(throwError(() => failure)).mockReturnValueOnce(of(first)) });
		const events: Action[] = [];
		todoEffects$(of(transition(create), transition(create)), adapter).subscribe(action => events.push(action));
		expect(terminal(events)).toEqual([
			{ type: 'OPERATION_FAILED', operationId: '1', message: 'Conflict', failure },
			{ type: 'CREATE_SUCCEEDED', operationId: '2', todo: first },
		]);
		expect(terminal(events)[0]).toHaveProperty('failure', failure);
		expect(adapter.create$).toHaveBeenCalledTimes(2);
	});

	it('contains synchronous service construction errors and runs the next queued intent', () => {
		const adapter = service({ update$: vi.fn(() => { throw new Error('Construction failed'); }) });
		const events: Action[] = [];
		todoEffects$(of(transition(update), transition(remove)), adapter).subscribe(action => events.push(action));
		expect(terminal(events)).toEqual([
			expect.objectContaining({ type: 'OPERATION_FAILED', message: 'Construction failed', failure: expect.objectContaining({ kind: 'network' }) }),
			{ type: 'DELETE_SUCCEEDED', operationId: '2', id: '2' },
		]);
		expect(adapter.update$).toHaveBeenCalledTimes(1);
		expect(adapter.remove$).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed or mismatched service data without storing it and stays alive', () => {
		const adapter = service({ update$: vi.fn().mockReturnValueOnce(of({ broken: true })).mockReturnValueOnce(of(second)).mockReturnValueOnce(of(first)) });
		const events: Action[] = [];
		todoEffects$(of(transition(update), transition(update), transition(update)), adapter).subscribe(action => events.push(action));
		expect(terminal(events).map(action => action.type)).toEqual(['OPERATION_FAILED', 'OPERATION_FAILED', 'UPDATE_SUCCEEDED']);
		expect(terminal(events)[0]).toMatchObject({ failure: { kind: 'decode' } });
		expect(terminal(events)[1]).toMatchObject({ failure: { kind: 'decode', details: { expectedId: '1', actualId: '2' } } });
	});

	it('settles on the first finite result and immediately unsubscribes a noncompleting source', () => {
		const source = new Subject<Todo>();
		const finalized = vi.fn();
		const adapter = service({ create$: () => new Observable(subscriber => {
			const run = source.subscribe(subscriber);
			return () => { run.unsubscribe(); finalized(); };
		}) });
		const events: Action[] = [];
		const run = todoEffects$(of(transition(create)), adapter).subscribe(action => events.push(action));
		source.next(first);
		expect(finalized).toHaveBeenCalledTimes(1);
		expect(run.closed).toBe(true);
		source.next(second);
		expect(terminal(events)).toEqual([{ type: 'CREATE_SUCCEEDED', operationId: '1', todo: first }]);
	});

	it('reports outer input faults and tears down every owned request and queue', () => {
		const source = new Subject<Transition<State, Action>>();
		const disposed = vi.fn();
		const adapter = service({ update$: () => new Observable(() => disposed) });
		const error = new Error('Broken transition source');
		const errors: unknown[] = [];
		const run = todoEffects$(source, adapter).subscribe({ error: failure => errors.push(failure) });
		source.next(transition(update));
		source.next(transition(remove));
		source.error(error);
		expect(errors).toEqual([error]);
		expect(run.closed).toBe(true);
		expect(disposed).toHaveBeenCalledTimes(1);
		expect(adapter.remove$).not.toHaveBeenCalled();
	});

	it('does not disguise unexpected intent or result projection faults as recoverable request errors', () => {
		const error = new Error('Invalid internal getter');
		const invalidMessage = { type: 'CREATE_REQUESTED', get title(): string { throw error; } } as const;
		const invalidTodo = { ...first, get title(): string { throw error; } };
		for (const [input, adapter] of [
			[of(transition(invalidMessage)), service()],
			[of(transition(load)), service({ getAll$: () => of([invalidTodo]) })],
		] as const) {
			const errors: unknown[] = [];
			const events: Action[] = [];
			const run = todoEffects$(input, adapter).subscribe({ next: action => events.push(action), error: failure => errors.push(failure) });
			expect(errors).toEqual([error]);
			expect(run.closed).toBe(true);
			expect(events.some(action => action.type === 'OPERATION_FAILED')).toBe(false);
		}
	});

	it.each([0, -1, 1.5, Infinity, NaN])('reports invalid capacity %s through the host error channel', mutationCapacity => {
		const adapter = service();
		const errors: unknown[] = [];
		todoEffects$(of(transition(create)), adapter, { mutationCapacity }).subscribe({ error: error => errors.push(error) });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(RangeError);
		expect(adapter.create$).not.toHaveBeenCalled();
	});
});

describe('Todo effect graph ownership', () => {
	it('reserves FIFO order before a queued fact can synchronously admit another mutation', () => {
		const input = new Subject<Transition<State, Action>>();
		const adapter = service();
		const events: Array<[string, string]> = [];
		const run = todoEffects$(input, adapter).subscribe(action => {
			if (action.type === 'OPERATION_QUEUED' || action.type === 'OPERATION_STARTED') {
				events.push([action.type, action.operation.id]);
				if (action.type === 'OPERATION_QUEUED' && action.operation.id === '1') input.next(transition(remove));
			} else if ('operationId' in action) events.push([action.type, action.operationId]);
		});
		input.next(transition(update));
		expect(events).toEqual([
			['OPERATION_QUEUED', '1'], ['OPERATION_QUEUED', '2'],
			['OPERATION_STARTED', '1'], ['UPDATE_SUCCEEDED', '1'],
			['OPERATION_STARTED', '2'], ['DELETE_SUCCEEDED', '2'],
		]);
		run.unsubscribe();
	});

	it.each([create, load])('stops a synchronous input producer when its first $type fact disposes the graph', message => {
		let produced = 0;
		const teardown = vi.fn();
		const input = new Observable<Transition<State, Action>>(subscriber => {
			for (const item of [message, load, create]) {
				if (subscriber.closed) break;
				produced++;
				subscriber.next(transition(item));
			}
			return teardown;
		});
		const adapter = service();
		todoEffects$(input, adapter).pipe(take(1)).subscribe();
		expect(produced).toBe(1);
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(adapter.getAll$).not.toHaveBeenCalled();
		expect(adapter.create$).not.toHaveBeenCalled();
	});

	it('is inert and creates isolated admission/operation identity for each run', () => {
		const adapter = service({ create$: vi.fn(() => NEVER) });
		const source = new Subject<Transition<State, Action>>();
		const graph = todoEffects$(source, adapter);
		expect(adapter.create$).not.toHaveBeenCalled();
		const left: Action[] = [];
		const right: Action[] = [];
		const leftRun = graph.subscribe(action => left.push(action));
		const rightRun = graph.subscribe(action => right.push(action));
		source.next(transition(create));
		expect(adapter.create$).toHaveBeenCalledTimes(2);
		expect(left).toEqual(right);
		leftRun.unsubscribe();
		source.next(transition(create));
		expect(adapter.create$).toHaveBeenCalledTimes(2);
		expect(rightRun.closed).toBe(false);
		rightRun.unsubscribe();
	});

	it('feeds synchronous results after their input with one execution despite extra state/view/trace consumers', () => {
		const model = createTodoModel();
		const adapter = service();
		const messages: string[] = [];
		const states: State[] = [];
		model.transitions$.subscribe(({ message }) => messages.push(message.type));
		const run = todoEffects$(model.transitions$, adapter).subscribe(action => model.dispatch(action));
		model.transitions$.subscribe();
		model.state$.subscribe(state => states.push(state));
		model.state$.subscribe();
		model.viewModel$.subscribe();
		model.viewModel$.subscribe();
		model.start();
		model.dispatch(create);
		expect(messages).toEqual(['CREATE_REQUESTED', 'OPERATION_QUEUED', 'OPERATION_STARTED', 'CREATE_SUCCEEDED']);
		expect(adapter.create$).toHaveBeenCalledTimes(1);
		expect(states.at(-1)).toMatchObject({ todos: [{ ...first, id: '3', title: 'Created' }], pending: [] });
		run.unsubscribe();
		model.dispose();
	});
});
