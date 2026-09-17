import { describe, expect, it } from 'vitest';
import type { Todo } from '../shared/types';
import type { State } from './todo.state';
import { equalViewModel, selectViewModel, type ViewModel } from './todo.selectors';

const first: Readonly<Todo> = Object.freeze({
	id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z',
});
const second: Readonly<Todo> = Object.freeze({
	id: '2', title: 'Second', completed: true, createdAt: '2026-01-02T00:00:00.000Z',
});

function stateWith(overrides: Partial<State> = {}): State {
	return {
		todos: [], draft: '', loadStatus: 'idle', pending: [], error: null,
		connection: 'idle', ...overrides,
	};
}

describe('selectViewModel', () => {
	it('derives coherent counts and preserves readonly snapshot data', () => {
		const state = Object.freeze(stateWith({
			todos: Object.freeze([first, second]),
			draft: '  Next  ',
			loadStatus: 'ready',
			pending: Object.freeze([
				{ id: 'load-1', kind: 'load' as const },
				{ id: 'update-1', kind: 'update' as const, todoId: first.id },
			]),
			error: 'Recoverable failure',
			connection: 'connected',
		}));

		const view = selectViewModel(state);

		expect(view).toEqual({
			todos: [first, second], error: 'Recoverable failure', draft: '  Next  ',
			loading: false, empty: false, total: 2, completed: 1, remaining: 1,
			pendingCount: 2, creating: false, connection: 'connected', canSubmit: true,
		});
		expect(view.todos).toBe(state.todos);
		expect(view.completed + view.remaining).toBe(view.total);
		expect(selectViewModel(state)).toEqual(view);
	});

	it.each([
		['idle', true, false],
		['loading', true, false],
		['ready', false, true],
		['error', false, false],
	] as const)('distinguishes %s from confirmed empty data', (loadStatus, loading, empty) => {
		const view = selectViewModel(stateWith({ loadStatus }));
		expect(view).toMatchObject({ loading, empty, total: 0, completed: 0, remaining: 0 });
	});

	it('keeps counts coherent while a populated collection reloads', () => {
		const view = selectViewModel(stateWith({ todos: [second], loadStatus: 'loading' }));
		expect(view).toMatchObject({ loading: true, empty: false, total: 1, completed: 1, remaining: 0 });
	});

	it('finds a pending create among other operations and blocks submission', () => {
		const view = selectViewModel(stateWith({
			draft: 'Another Todo',
			pending: [
				{ id: 'load-1', kind: 'load' },
				{ id: 'create-1', kind: 'create', title: 'Accepted Todo' },
				{ id: 'delete-1', kind: 'delete', todoId: first.id },
			],
		}));
		expect(view).toMatchObject({ pendingCount: 3, creating: true, canSubmit: false });
	});

	it.each(['', ' ', '\t\n'])('rejects a blank draft %j without changing its value', draft => {
		const view = selectViewModel(stateWith({ draft }));
		expect(view).toMatchObject({ draft, pendingCount: 0, creating: false, canSubmit: false });
	});

	it('allows a nonblank draft while non-create work is pending', () => {
		const view = selectViewModel(stateWith({
			draft: '  Next\n', pending: [{ id: 'delete-1', kind: 'delete', todoId: first.id }],
		}));
		expect(view).toMatchObject({ draft: '  Next\n', pendingCount: 1, creating: false, canSubmit: true });
	});
});

describe('equalViewModel', () => {
	const view = selectViewModel(stateWith({ todos: [first, second], loadStatus: 'ready' }));

	it('accepts the same object and equivalent fields with the same todos reference', () => {
		expect(equalViewModel(view, view)).toBe(true);
		expect(equalViewModel(view, { ...view })).toBe(true);
	});

	const changes: Record<keyof ViewModel, Partial<ViewModel>> = {
		todos: { todos: [...view.todos] },
		error: { error: 'Failed' },
		draft: { draft: 'Changed' },
		loading: { loading: true },
		empty: { empty: true },
		total: { total: 3 },
		completed: { completed: 2 },
		remaining: { remaining: 2 },
		pendingCount: { pendingCount: 1 },
		creating: { creating: true },
		connection: { connection: 'disconnected' },
		canSubmit: { canSubmit: true },
	};

	it.each(Object.entries(changes))('detects a change to %s', (_field, change) => {
		const changed = { ...view, ...change };
		expect(equalViewModel(view, changed)).toBe(false);
		expect(equalViewModel(changed, view)).toBe(false);
	});
});
