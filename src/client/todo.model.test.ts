import { afterEach, describe, expect, it } from 'vitest';
import { Subject } from 'rxjs';
import type { Todo } from '../shared/types';
import { createTodoModel, type TodoModel } from './todo.model';
import type { Action, State } from './todo.state';
import type { ViewModel } from './todo.selectors';

const first: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };
const second: Todo = { id: '2', title: 'Second', completed: true, createdAt: '2026-01-02T00:00:00.000Z' };
const models: TodoModel[] = [];

function model(): TodoModel {
	const instance = createTodoModel();
	models.push(instance);
	return instance;
}

afterEach(() => {
	models.splice(0).forEach(instance => instance.dispose());
});

describe('Todo model ownership', () => {
	it('is inert before start and exposes only Observables', () => {
		const instance = model();
		const states: State[] = [];
		const views: ViewModel[] = [];
		instance.state$.subscribe(state => states.push(state));
		instance.viewModel$.subscribe(view => views.push(view));
		expect(instance.state$).not.toBeInstanceOf(Subject);
		expect(instance.transitions$).not.toBeInstanceOf(Subject);
		expect(instance.viewModel$).not.toBeInstanceOf(Subject);
		expect(instance.dispatch({ type: 'DRAFT_CHANGED', value: 'Before start' })).toBe(false);
		expect(states).toEqual([]);
		expect(views).toEqual([]);
		instance.start();
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({ draft: '', loadStatus: 'idle' });
		expect(views[0]).toMatchObject({ loading: true, empty: false, total: 0 });
		instance.start();
		expect(states).toHaveLength(1);
	});

	it('keeps simultaneously active models independent', () => {
		const left = model();
		const right = model();
		const leftStates: State[] = [];
		const rightStates: State[] = [];
		left.state$.subscribe(state => leftStates.push(state));
		right.state$.subscribe(state => rightStates.push(state));
		left.start();
		right.start();
		expect(leftStates[0]).not.toBe(rightStates[0]);
		left.dispatch({ type: 'SERVER_SNAPSHOT', todos: [first] });
		left.dispatch({ type: 'DRAFT_CHANGED', value: 'Left draft' });
		expect(leftStates.at(-1)).toMatchObject({ todos: [first], draft: 'Left draft' });
		expect(rightStates).toHaveLength(1);
		expect(rightStates[0]).toMatchObject({ todos: [], draft: '' });
		left.dispose();
		expect(left.closed).toBe(true);
		expect(right.closed).toBe(false);
		expect(right.dispatch({ type: 'DRAFT_CHANGED', value: 'Right draft' })).toBe(true);
		expect(rightStates.at(-1)?.draft).toBe('Right draft');
	});

	it('retains current state through a view gap and replays it to late consumers', () => {
		const instance = model();
		instance.start();
		const initialView = instance.viewModel$.subscribe();
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [first] });
		initialView.unsubscribe();
		instance.dispatch({ type: 'DRAFT_CHANGED', value: 'While hidden' });
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [first, second] });
		const lateStates: State[] = [];
		const lateViews: ViewModel[] = [];
		instance.state$.subscribe(state => lateStates.push(state));
		instance.viewModel$.subscribe(view => lateViews.push(view));
		expect(lateStates).toHaveLength(1);
		expect(lateStates[0]).toMatchObject({ todos: [first, second], draft: 'While hidden' });
		expect(lateViews).toHaveLength(1);
		expect(lateViews[0]).toMatchObject({ total: 2, completed: 1, remaining: 1, draft: 'While hidden' });
	});

	it('publishes accepted no-op intents as transitions without duplicate state or views', () => {
		const instance = model();
		const states: State[] = [];
		const views: ViewModel[] = [];
		const messages: Action[] = [];
		instance.state$.subscribe(state => states.push(state));
		instance.viewModel$.subscribe(view => views.push(view));
		instance.transitions$.subscribe(transition => messages.push(transition.message));
		instance.start();
		instance.dispatch({ type: 'LOAD_REQUESTED' });
		instance.dispatch({ type: 'DRAFT_CHANGED', value: '' });
		expect(messages).toEqual([{ type: 'LOAD_REQUESTED' }, { type: 'DRAFT_CHANGED', value: '' }]);
		expect(states).toHaveLength(1);
		expect(views).toHaveLength(1);
	});

	it('completes consumers, drops replay on disposal and resets only a new model', () => {
		const instance = model();
		instance.start();
		instance.dispatch({ type: 'DRAFT_CHANGED', value: 'Old draft' });
		let completions = 0;
		instance.state$.subscribe({ complete: () => completions++ });
		instance.viewModel$.subscribe({ complete: () => completions++ });
		instance.transitions$.subscribe({ complete: () => completions++ });
		instance.dispose();
		instance.dispose();
		instance.start();
		expect(instance.closed).toBe(true);
		expect(completions).toBe(3);
		expect(instance.dispatch({ type: 'DRAFT_CHANGED', value: 'Too late' })).toBe(false);
		const late: State[] = [];
		instance.state$.subscribe(state => late.push(state));
		expect(late).toEqual([]);
		const fresh = model();
		const freshStates: State[] = [];
		fresh.state$.subscribe(state => freshStates.push(state));
		fresh.start();
		expect(fresh.closed).toBe(false);
		expect(freshStates[0]).toMatchObject({ todos: [], draft: '', pending: [], error: null });
	});
});

describe('Todo model feedback and coherent derived values', () => {
	it('delivers synchronous startup feedback after every observer receives initial state', () => {
		const instance = model();
		const order: string[] = [];
		instance.state$.subscribe(state => {
			order.push(`first:${state.loadStatus}`);
			if (state.loadStatus === 'idle') instance.dispatch({ type: 'LOAD_REQUESTED' });
		});
		instance.state$.subscribe(state => order.push(`second:${state.loadStatus}`));
		instance.transitions$.subscribe(({ message, previous, state }) => {
			order.push(`transition:${message.type}`);
			if (message.type === 'LOAD_REQUESTED') {
				expect(previous).toBe(state);
				instance.dispatch({ type: 'OPERATION_STARTED', operation: { id: 'load', kind: 'load' } });
				instance.dispatch({ type: 'LOAD_SUCCEEDED', operationId: 'load', todos: [first] });
			}
		});
		instance.start();
		expect(order).toEqual([
			'first:idle', 'second:idle', 'transition:LOAD_REQUESTED',
			'first:loading', 'second:loading', 'transition:OPERATION_STARTED',
			'first:ready', 'second:ready', 'transition:LOAD_SUCCEEDED',
		]);
	});

	it('shares a single state identity and transition with additional state/view consumers', () => {
		const instance = model();
		const left: State[] = [];
		const right: State[] = [];
		const transitions: Action[] = [];
		instance.state$.subscribe(state => left.push(state));
		instance.state$.subscribe(state => right.push(state));
		instance.viewModel$.subscribe();
		instance.viewModel$.subscribe();
		instance.transitions$.subscribe(({ message }) => transitions.push(message));
		instance.start();
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [first] });
		expect(left).toHaveLength(2);
		expect(right).toHaveLength(2);
		expect(left[0]).toBe(right[0]);
		expect(left[1]).toBe(right[1]);
		expect(transitions).toEqual([{ type: 'SERVER_SNAPSHOT', todos: [first] }]);
		const lateTransitions: Action[] = [];
		instance.transitions$.subscribe(({ message }) => lateTransitions.push(message));
		expect(lateTransitions).toEqual([]);
	});

	it('emits each collection with coherent counts, completion and empty status', () => {
		const instance = model();
		const views: ViewModel[] = [];
		instance.viewModel$.subscribe(view => views.push(view));
		instance.start();
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [first, second] });
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [{ ...first, completed: true }, second] });
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [] });
		expect(views.map(({ loading, empty, total, completed, remaining }) => ({ loading, empty, total, completed, remaining })))
			.toEqual([
				{ loading: true, empty: false, total: 0, completed: 0, remaining: 0 },
				{ loading: false, empty: false, total: 2, completed: 1, remaining: 1 },
				{ loading: false, empty: false, total: 2, completed: 2, remaining: 0 },
				{ loading: false, empty: true, total: 0, completed: 0, remaining: 0 },
			]);
		for (const view of views) {
			expect(view.total).toBe(view.todos.length);
			expect(view.completed).toBe(view.todos.filter(todo => todo.completed).length);
			expect(view.remaining + view.completed).toBe(view.total);
		}
	});

	it('tracks pending load changes while idle and loading both project to loading', () => {
		const instance = model();
		const views: ViewModel[] = [];
		instance.viewModel$.subscribe(view => views.push(view));
		instance.start();
		instance.dispatch({ type: 'OPERATION_STARTED', operation: { id: 'load', kind: 'load' } });
		// The loading flag stays true, but pendingCount must still update.
		instance.dispatch({ type: 'DRAFT_CHANGED', value: '' });
		expect(views).toHaveLength(2);
		instance.dispatch({ type: 'OPERATION_CANCELLED', operationId: 'load' });
		expect(views.at(-1)).toMatchObject({ loading: true, pendingCount: 0 });
	});

	it('keeps pending create, newer draft and submission eligibility coherent through server feedback', () => {
		const instance = model();
		const views: ViewModel[] = [];
		instance.viewModel$.subscribe(view => views.push(view));
		instance.start();
		instance.dispatch({ type: 'DRAFT_CHANGED', value: 'Submitted' });
		instance.dispatch({ type: 'OPERATION_STARTED', operation: { id: 'c', kind: 'create', title: 'Submitted' } });
		instance.dispatch({ type: 'DRAFT_CHANGED', value: 'Newer text' });
		instance.dispatch({ type: 'SERVER_SNAPSHOT', todos: [second] });
		expect(views.at(-1)).toMatchObject({ draft: 'Newer text', creating: true, pendingCount: 1, canSubmit: false });
		instance.dispatch({ type: 'CREATE_SUCCEEDED', operationId: 'c', todo: { ...first, title: 'Submitted' } });
		expect(views.at(-1)).toMatchObject({ draft: 'Newer text', creating: false, pendingCount: 0, canSubmit: true, total: 2 });
	});
});
