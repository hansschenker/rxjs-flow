import { describe, expect, it } from 'vitest';
import type { Todo } from '../shared/types';
import { createInitialState, reducer, type State } from './todo.state';
import { interpretTodoIntent } from './todo.intents';
import { equalViewModel, selectViewModel, type ViewModel } from './todo.selectors';

const first: Readonly<Todo> = Object.freeze({
	id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z',
});
const second: Readonly<Todo> = Object.freeze({
	id: '2', title: 'Second', completed: true, createdAt: '2026-01-02T00:00:00.000Z',
});

function stateWith(overrides: Partial<State> = {}): State {
	return {
		...createInitialState(), ...overrides,
	};
}

describe('selectViewModel', () => {
	it.each([
		['all', ['1', '2']], ['active', ['1']], ['completed', ['2']],
	] as const)('shows the %s subset while retaining full-collection counts', (filter, ids) => {
		const state = stateWith({ todos: [first, second], loadStatus: 'ready', draft: 'Unsent' });
		const message = { type: 'FILTER_CHANGED' as const, filter };
		const filtered = reducer(state, message);
		const view = selectViewModel(filtered);
		expect(view.todos.map(todo => todo.id)).toEqual(ids);
		expect(view).toMatchObject({ filter, visibleCount: ids.length, total: 2, completed: 1, remaining: 1, draft: 'Unsent' });
		expect(filtered.todos).toBe(state.todos);
		expect(filtered.pending).toBe(state.pending);
		expect(reducer(filtered, message)).toBe(filtered);
		expect(interpretTodoIntent({ previous: state, state: filtered, message })).toBeNull();
	});

	it('distinguishes an empty selected filter from an empty collection and initial loading', () => {
		const activeOnly = stateWith({ todos: [first], filter: 'completed', loadStatus: 'ready' });
		expect(selectViewModel(activeOnly)).toMatchObject({ empty: false, filteredEmpty: true, visibleCount: 0, total: 1 });
		expect(selectViewModel({ ...activeOnly, todos: [] })).toMatchObject({ empty: true, filteredEmpty: false });
		expect(selectViewModel({ ...activeOnly, loadStatus: 'loading' })).toMatchObject({ empty: false, filteredEmpty: false });
	});

	it('recomputes the selected subset from a server snapshot without changing the local filter or draft', () => {
		const state = stateWith({ todos: [first, second], filter: 'active', loadStatus: 'ready', draft: 'Still typing' });
		const next = reducer(state, { type: 'SERVER_SNAPSHOT', todos: [{ ...first, completed: true }, second] });
		expect(selectViewModel(next)).toMatchObject({ filter: 'active', draft: 'Still typing', todos: [],
			filteredEmpty: true, total: 2, completed: 2, remaining: 0 });
	});

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
			draftError: null, draftInvalid: false, filter: 'all', visibleCount: 2, filteredEmpty: false,
			recoveryHint: 'Your draft is kept. Review the message before trying again.',
			loading: false, empty: false, total: 2, completed: 1, remaining: 1,
			pendingCount: 2, pendingTodoIds: ['1'], creating: false, connection: 'connected', live: null, canSubmit: true,
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

	it('keeps a row pending until every accepted operation for that Todo settles', () => {
		const pending: State['pending'] = [
			{ id: 'load', kind: 'load' },
			{ id: 'create', kind: 'create', title: 'New' },
			{ id: 'a', kind: 'update', todoId: first.id },
			{ id: 'b', kind: 'delete', todoId: second.id },
			{ id: 'c', kind: 'update', todoId: first.id },
		];
		expect(selectViewModel(stateWith({ pending })).pendingTodoIds).toEqual(['1', '2']);
		expect(selectViewModel(stateWith({ pending: pending.filter(operation => operation.id !== 'a') })).pendingTodoIds).toEqual(['2', '1']);
		expect(selectViewModel(stateWith({ pending: pending.filter(operation => !['a', 'c'].includes(operation.id)) })).pendingTodoIds).toEqual(['2']);
	});
});

describe('operation-specific recovery guidance', () => {
	it.each(['update', 'delete'] as const)('does not describe a draft submission after uncertain %s work', kind => {
		const current = stateWith({ failedOperation: kind, error: 'Reply lost.',
			failure: { kind: 'network', message: 'Reply lost.' } });
		const hint = selectViewModel(current).recoveryHint;
		expect(hint).toContain('Refresh and review the list before repeating the change');
		expect(hint).not.toMatch(/draft|submitting/);
		const live = createInitialState({ collectionSource: 'live' }).live;
		expect(selectViewModel({ ...current, live }).recoveryHint).toContain('Reconnect and review');
	});

	it('gives a read-specific recovery path for an initial finite load failure', () => {
		const failed = stateWith({ failedOperation: 'load', error: 'Offline.', failure: { kind: 'network', message: 'Offline.' } });
		expect(selectViewModel(failed).recoveryHint).toBe('Refresh to load the current list again.');
	});
});

describe('equalViewModel', () => {
	const view = selectViewModel(stateWith({ todos: [first, second], loadStatus: 'ready' }));

	it('accepts the same object and equivalent fields with the same todos reference', () => {
		expect(equalViewModel(view, view)).toBe(true);
		expect(equalViewModel(view, { ...view })).toBe(true);
	});

	const changes: Record<keyof ViewModel, Partial<ViewModel>> = {
		todos: { todos: [second, first] },
		error: { error: 'Failed' },
		draft: { draft: 'Changed' },
		draftError: { draftError: 'Enter a task title.' },
		draftInvalid: { draftInvalid: true },
		filter: { filter: 'active' },
		visibleCount: { visibleCount: 0 },
		filteredEmpty: { filteredEmpty: true },
		recoveryHint: { recoveryHint: 'Review the list.' },
		loading: { loading: true },
		empty: { empty: true },
		total: { total: 3 },
		completed: { completed: 2 },
		remaining: { remaining: 2 },
		pendingCount: { pendingCount: 1 },
		pendingTodoIds: { pendingTodoIds: ['1'] },
		creating: { creating: true },
		connection: { connection: 'disconnected' },
		live: { live: { expectedCollectionId: null, identity: null, connectionId: 1,
			firstSnapshotPending: true, acceptingSnapshots: true, stale: false, attempt: 0,
			retryDelayMs: null, error: null, resyncRequired: false } },
		canSubmit: { canSubmit: true },
	};

	it('treats equal filtered item identities as unchanged without sharing mutable selector caches', () => {
		const initial = stateWith({ todos: [first, second], filter: 'active', loadStatus: 'ready' });
		const left = selectViewModel(initial);
		const right = selectViewModel({ ...initial, draftRevision: initial.draftRevision + 1 });
		expect(left.todos).not.toBe(right.todos);
		expect(equalViewModel(left, right)).toBe(true);
		expect(equalViewModel(left, { ...right, todos: [{ ...first, title: 'Updated' }] })).toBe(false);
	});

	it.each(Object.entries(changes))('detects a change to %s', (_field, change) => {
		const changed = { ...view, ...change };
		expect(equalViewModel(view, changed)).toBe(false);
		expect(equalViewModel(changed, view)).toBe(false);
	});
});
