import { describe, expect, it } from 'vitest';
import type { Todo } from '../shared/types';
import { createInitialState, reducer, type Action, type Operation, type State } from './todo.state';

const first: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };
const second: Todo = { id: '2', title: 'Second', completed: true, createdAt: '2026-01-02T00:00:00.000Z' };

function populated(): State {
	return reducer(createInitialState(), { type: 'SERVER_SNAPSHOT', todos: [first, second] });
}

function start(state: State, operation: Operation): State {
	return reducer(state, { type: 'OPERATION_STARTED', operation });
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}

describe('Todo initial state and intents', () => {
	it('creates independent idle state, collection and pending arrays', () => {
		const firstState = createInitialState();
		const next = createInitialState();
		expect(next).toEqual({ todos: [], draft: '', draftRevision: 0, draftTouched: false, filter: 'all',
			loadStatus: 'idle', pending: [], error: null, failure: null, failedOperation: null, connection: 'idle', live: null });
		expect(next).not.toBe(firstState);
		expect(next.todos).not.toBe(firstState.todos);
		expect(next.pending).not.toBe(firstState.pending);
	});

	it.each<Action>([
		{ type: 'LOAD_REQUESTED' },
		{ type: 'CREATE_REQUESTED', title: 'First' },
		{ type: 'TOGGLE_REQUESTED', id: '1', completed: true },
		{ type: 'DELETE_REQUESTED', id: '1' },
	])('keeps $type separate from operation acceptance and completion', action => {
		const state = populated();
		expect(reducer(state, action)).toBe(state);
	});

	it('records exact draft text and preserves identity for repeated text', () => {
		const state = populated();
		const next = reducer(state, { type: 'DRAFT_CHANGED', value: '  Unsent  ' });
		expect(next.draft).toBe('  Unsent  ');
		expect(next.todos).toBe(state.todos);
		expect(reducer(next, { type: 'DRAFT_CHANGED', value: next.draft })).toBe(next);
	});
});

describe('operation admission and load outcomes', () => {
	it('remembers queued writes immediately and does not double-count their activation', () => {
		const operation: Operation = { id: 'queued', kind: 'create', title: 'Waiting' };
		const queued = reducer(populated(), { type: 'OPERATION_QUEUED', operation });
		expect(queued.pending).toEqual([operation]);
		expect(start(queued, operation)).toBe(queued);
		const rejected = reducer(queued, { type: 'MUTATION_REJECTED', message: 'Write queue is full.' });
		expect(rejected.pending).toBe(queued.pending);
		expect(rejected.error).toBe('Write queue is full.');
	});

	it('preserves structured failure evidence while releasing only its pending operation', () => {
		const pending = start(populated(), { id: 'delete', kind: 'delete', todoId: '1' });
		const failure = freeze({ kind: 'http' as const, status: 409, message: 'Conflict',
			details: { id: '1', reason: 'changed' }, body: { error: 'Conflict' }, cause: new Error('transport') });
		const failed = reducer(pending, { type: 'OPERATION_FAILED', operationId: 'delete', message: 'Failed to delete todo.', failure });
		expect(failed.failure).toEqual({ kind: 'http', status: 409, message: 'Conflict', details: failure.details, body: failure.body });
		expect(failed.failure).not.toHaveProperty('cause');
		expect(failed.pending).toEqual([]);
		expect(failed.todos).toBe(pending.todos);
		expect(start(failed, { id: 'retry', kind: 'delete', todoId: '1' }).failure).toBeNull();
		expect(reducer(failed, { type: 'ERROR_DISMISSED' }).failure).toBeNull();
	});

	it('copies started operations, deduplicates pending IDs and clears an earlier error', () => {
		const operation: Operation = { id: 'create-1', kind: 'create', title: 'First' };
		const state = start({ ...populated(), error: 'Earlier failure' }, operation);
		expect(state.error).toBeNull();
		expect(state.pending).toEqual([operation]);
		expect(state.pending[0]).not.toBe(operation);
		expect(start(state, { id: 'create-1', kind: 'delete', todoId: '2' })).toBe(state);
	});

	it('distinguishes initial loading from successful empty data', () => {
		const loading = start(createInitialState(), { id: 'load-1', kind: 'load' });
		expect(loading.loadStatus).toBe('loading');
		const ready = reducer(loading, { type: 'LOAD_SUCCEEDED', operationId: 'load-1', todos: [] });
		expect(ready).toMatchObject({ loadStatus: 'ready', todos: [], pending: [], error: null });
	});

	it('replaces collection on load, copies data, and clears only the matching load', () => {
		const create: Operation = { id: 'create-1', kind: 'create', title: 'Third' };
		const loading = start(start(populated(), create), { id: 'load-1', kind: 'load' });
		const payload = [{ ...first, title: 'Refreshed' }];
		const next = reducer(loading, { type: 'LOAD_SUCCEEDED', operationId: 'load-1', todos: payload });
		expect(next.todos).toEqual(payload);
		expect(next.todos).not.toBe(payload);
		expect(next.todos[0]).not.toBe(payload[0]);
		expect(next.pending).toEqual([create]);
		payload[0].title = 'Changed externally';
		payload.push(second);
		expect(next.todos).toHaveLength(1);
		expect(next.todos[0].title).toBe('Refreshed');
	});

	it('keeps loading while another initial load is pending, then exposes failure', () => {
		const loading = start(start(createInitialState(), { id: 'a', kind: 'load' }), { id: 'b', kind: 'load' });
		const failed = reducer(loading, { type: 'OPERATION_FAILED', operationId: 'a', message: 'Offline' });
		expect(failed).toMatchObject({ loadStatus: 'loading', error: 'Offline', pending: [{ id: 'b', kind: 'load' }] });
		const finished = reducer(failed, { type: 'OPERATION_CANCELLED', operationId: 'b' });
		expect(finished).toMatchObject({ loadStatus: 'error', pending: [], error: 'Offline' });
	});

	it('recovers an initial load failure when a later load succeeds', () => {
		const failed = reducer(start(createInitialState(), { id: 'a', kind: 'load' }), {
			type: 'OPERATION_FAILED', operationId: 'a', message: 'Offline',
		});
		expect(failed.loadStatus).toBe('error');
		const retry = start(failed, { id: 'b', kind: 'load' });
		expect(retry).toMatchObject({ loadStatus: 'loading', error: null });
		expect(reducer(retry, { type: 'LOAD_SUCCEEDED', operationId: 'b', todos: [] }))
			.toMatchObject({ loadStatus: 'ready', error: null, pending: [] });
	});

	it('cancels initial load without inventing success or an error', () => {
		const loading = start(createInitialState(), { id: 'a', kind: 'load' });
		expect(reducer(loading, { type: 'OPERATION_CANCELLED', operationId: 'a' }))
			.toMatchObject({ loadStatus: 'idle', error: null, pending: [] });
	});

	it.each<Action>([
		{ type: 'OPERATION_CANCELLED', operationId: 'refresh' },
		{ type: 'OPERATION_FAILED', operationId: 'refresh', message: 'Offline' },
	])('preserves known empty data through refresh $type', action => {
		const ready = reducer(createInitialState(), { type: 'SERVER_SNAPSHOT', todos: [] });
		const refreshing = start(ready, { id: 'refresh', kind: 'load' });
		expect(refreshing.loadStatus).toBe('ready');
		expect(reducer(refreshing, action).loadStatus).toBe('ready');
	});
});

describe('correlated mutation outcomes', () => {
	it('appends an owned Todo and clears only the submitted draft', () => {
		const state = start({ ...populated(), draft: '  Third  ' }, {
			id: 'c', kind: 'create', title: 'Third', submittedDraft: { value: '  Third  ', revision: 0 },
		});
		const incoming = { ...first, id: '3', title: 'Third' };
		const next = reducer(state, { type: 'CREATE_SUCCEEDED', operationId: 'c', todo: incoming });
		expect(next.todos).toEqual([...state.todos, incoming]);
		expect(next.todos[0]).toBe(state.todos[0]);
		expect(next.todos[2]).not.toBe(incoming);
		expect(next.draft).toBe('');
		expect(next.pending).toEqual([]);
		incoming.title = 'External mutation';
		expect(next.todos[2].title).toBe('Third');
	});

	it('preserves a newer different draft and a concurrent error on create success', () => {
		const state = start({ ...populated(), draft: 'Submitted' }, { id: 'c', kind: 'create', title: 'Submitted' });
		const typed = reducer(state, { type: 'DRAFT_CHANGED', value: 'New draft' });
		const next = reducer({ ...typed, error: 'Another operation failed' }, {
			type: 'CREATE_SUCCEEDED', operationId: 'c', todo: { ...first, id: '3', title: 'Submitted' },
		});
		expect(next).toMatchObject({ draft: 'New draft', error: 'Another operation failed' });
	});

	it('does not duplicate a created Todo already present in a collection snapshot', () => {
		const state = start(populated(), { id: 'c', kind: 'create', title: first.title });
		const next = reducer(state, { type: 'CREATE_SUCCEEDED', operationId: 'c', todo: { ...first } });
		expect(next.todos).toBe(state.todos);
		expect(next.pending).toEqual([]);
	});

	it('updates only its matching target and preserves unchanged item identity', () => {
		const state = start(populated(), { id: 'u', kind: 'update', todoId: '1' });
		const incoming = { ...first, completed: true };
		const next = reducer(state, { type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: incoming });
		expect(next.todos[0]).toEqual(incoming);
		expect(next.todos[0]).not.toBe(incoming);
		expect(next.todos[1]).toBe(state.todos[1]);
		expect(next.pending).toEqual([]);
	});

	it('deletes only its matching target and preserves remaining item identity', () => {
		const state = start(populated(), { id: 'd', kind: 'delete', todoId: '1' });
		const next = reducer(state, { type: 'DELETE_SUCCEEDED', operationId: 'd', id: '1' });
		expect(next.todos).toEqual([second]);
		expect(next.todos[0]).toBe(state.todos[1]);
		expect(next.pending).toEqual([]);
	});

	it('settles concurrent same-target operations independently without resurrecting a deleted Todo', () => {
		const updating = start(populated(), { id: 'u', kind: 'update', todoId: '1' });
		const deleting = start(updating, { id: 'd', kind: 'delete', todoId: '1' });
		const deleted = reducer(deleting, { type: 'DELETE_SUCCEEDED', operationId: 'd', id: '1' });
		expect(deleted.pending).toEqual([{ id: 'u', kind: 'update', todoId: '1' }]);
		const updated = reducer(deleted, { type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: { ...first, completed: true } });
		expect(updated.todos).toBe(deleted.todos);
		expect(updated.pending).toEqual([]);
	});

	it('settles two deletes of the same target without removing unrelated pending work', () => {
		const once = start(populated(), { id: 'a', kind: 'delete', todoId: '1' });
		const twice = start(once, { id: 'b', kind: 'delete', todoId: '1' });
		const deleted = reducer(twice, { type: 'DELETE_SUCCEEDED', operationId: 'a', id: '1' });
		expect(deleted.pending).toEqual([{ id: 'b', kind: 'delete', todoId: '1' }]);
		const settled = reducer(deleted, { type: 'DELETE_SUCCEEDED', operationId: 'b', id: '1' });
		expect(settled.todos).toBe(deleted.todos);
		expect(settled.pending).toEqual([]);
	});

	it.each<Operation>([
		{ id: 'operation', kind: 'create', title: 'Third' },
		{ id: 'operation', kind: 'update', todoId: '1' },
		{ id: 'operation', kind: 'delete', todoId: '1' },
	])('separates failure and cancellation for $kind without changing collection or draft', operation => {
		const state = start(start({ ...populated(), draft: 'Keep text' }, operation), {
			id: 'other', kind: 'update', todoId: '1',
		});
		const failed = reducer(state, { type: 'OPERATION_FAILED', operationId: operation.id, message: 'Cannot save' });
		expect(failed).toMatchObject({ error: 'Cannot save', draft: 'Keep text', pending: [{ id: 'other', kind: 'update', todoId: '1' }] });
		expect(failed.todos).toBe(state.todos);
		const cancelled = reducer(state, { type: 'OPERATION_CANCELLED', operationId: operation.id });
		expect(cancelled).toMatchObject({ error: null, draft: 'Keep text', pending: failed.pending });
		expect(cancelled.todos).toBe(state.todos);
	});

	it.each<Action>([
		{ type: 'LOAD_SUCCEEDED', operationId: 'missing', todos: [] },
		{ type: 'CREATE_SUCCEEDED', operationId: 'missing', todo: first },
		{ type: 'UPDATE_SUCCEEDED', operationId: 'missing', todo: first },
		{ type: 'DELETE_SUCCEEDED', operationId: 'missing', id: '1' },
		{ type: 'OPERATION_FAILED', operationId: 'missing', message: 'Late error' },
		{ type: 'OPERATION_CANCELLED', operationId: 'missing' },
	])('ignores unmatched or already settled $type', action => {
		const state = populated();
		expect(reducer(state, action)).toBe(state);
	});

	it('ignores mismatched success kinds and mismatched mutation targets', () => {
		const update = start(populated(), { id: 'u', kind: 'update', todoId: '1' });
		for (const action of [
			{ type: 'LOAD_SUCCEEDED', operationId: 'u', todos: [] },
			{ type: 'CREATE_SUCCEEDED', operationId: 'u', todo: first },
			{ type: 'DELETE_SUCCEEDED', operationId: 'u', id: '1' },
			{ type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: second },
		] satisfies Action[]) expect(reducer(update, action)).toBe(update);
		const deletion = start(populated(), { id: 'd', kind: 'delete', todoId: '1' });
		expect(reducer(deletion, { type: 'DELETE_SUCCEEDED', operationId: 'd', id: '2' })).toBe(deletion);
	});

	it('ignores a late result after cancellation and a duplicate success after settlement', () => {
		const pending = start(populated(), { id: 'u', kind: 'update', todoId: '1' });
		const success: Action = { type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: { ...first, completed: true } };
		const cancelled = reducer(pending, { type: 'OPERATION_CANCELLED', operationId: 'u' });
		expect(reducer(cancelled, success)).toBe(cancelled);
		const settled = reducer(pending, success);
		expect(reducer(settled, success)).toBe(settled);
	});
});

describe('snapshots and local UI state', () => {
	it('copies collection input while preserving draft, pending work, errors and connection', () => {
		const state = start({ ...populated(), draft: 'Unsent', connection: 'disconnected' }, { id: 'u', kind: 'update', todoId: '1' });
		const withError = { ...state, error: 'Operation failed' };
		const incoming = [{ ...first, completed: true }, { ...second }];
		const next = reducer(withError, { type: 'SERVER_SNAPSHOT', todos: incoming });
		expect(next).toMatchObject({ draft: 'Unsent', error: 'Operation failed', connection: 'disconnected', loadStatus: 'ready' });
		expect(next.pending).toBe(withError.pending);
		expect(next.todos).not.toBe(incoming);
		expect(next.todos[0]).not.toBe(incoming[0]);
		expect(next.todos[1]).toBe(withError.todos[1]);
		incoming[0].title = 'External edit';
		incoming.length = 0;
		expect(next.todos).toHaveLength(2);
		expect(next.todos[0].title).toBe(first.title);
	});

	it('preserves state for an equal snapshot and item identities through reordering', () => {
		const state = populated();
		expect(reducer(state, { type: 'SERVER_SNAPSHOT', todos: [{ ...first }, { ...second }] })).toBe(state);
		const reordered = reducer(state, { type: 'SERVER_SNAPSHOT', todos: [{ ...second }, { ...first }] });
		expect(reordered.todos).not.toBe(state.todos);
		expect(reordered.todos[0]).toBe(state.todos[1]);
		expect(reordered.todos[1]).toBe(state.todos[0]);
	});

	it('records connection changes independently and dismisses recoverable errors', () => {
		const state = { ...populated(), error: 'Offline' };
		const next = reducer(state, { type: 'CONNECTION_CHANGED', status: 'connecting' });
		expect(next.todos).toBe(state.todos);
		expect(next.error).toBe('Offline');
		expect(reducer(next, { type: 'CONNECTION_CHANGED', status: 'connecting' })).toBe(next);
		const dismissed = reducer(next, { type: 'ERROR_DISMISSED' });
		expect(dismissed.error).toBeNull();
		expect(reducer(dismissed, { type: 'ERROR_DISMISSED' })).toBe(dismissed);
	});
});

describe('reducer determinism and immutability', () => {
	it('replays a frozen mixed outcome trace without mutating any prior state or action', () => {
		const initial = freeze(createInitialState());
		const actions = freeze<Action[]>([
			{ type: 'OPERATION_STARTED', operation: { id: 'l', kind: 'load' } },
			{ type: 'LOAD_SUCCEEDED', operationId: 'l', todos: [first, second] },
			{ type: 'DRAFT_CHANGED', value: 'Third' },
			{ type: 'OPERATION_STARTED', operation: { id: 'c', kind: 'create', title: 'Third' } },
			{ type: 'CREATE_SUCCEEDED', operationId: 'c', todo: { ...first, id: '3', title: 'Third' } },
			{ type: 'OPERATION_STARTED', operation: { id: 'u', kind: 'update', todoId: '1' } },
			{ type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: { ...first, completed: true } },
			{ type: 'OPERATION_STARTED', operation: { id: 'd', kind: 'delete', todoId: '2' } },
			{ type: 'DELETE_SUCCEEDED', operationId: 'd', id: '2' },
			{ type: 'SERVER_SNAPSHOT', todos: [second] },
			{ type: 'OPERATION_STARTED', operation: { id: 'f', kind: 'create', title: 'Failure' } },
			{ type: 'OPERATION_FAILED', operationId: 'f', message: 'Cannot save' },
			{ type: 'OPERATION_STARTED', operation: { id: 'x', kind: 'update', todoId: '2' } },
			{ type: 'OPERATION_CANCELLED', operationId: 'x' },
			{ type: 'CONNECTION_CHANGED', status: 'connected' },
			{ type: 'ERROR_DISMISSED' },
		]);
		const original = structuredClone({ initial, actions });
		const run = () => actions.reduce((state, action) => freeze(reducer(state, action)), initial);
		expect(run()).toEqual(run());
		expect({ initial, actions }).toEqual(original);
	});
});
