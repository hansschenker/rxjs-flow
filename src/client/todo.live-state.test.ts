import { describe, expect, it, vi } from 'vitest';
import { Subject, of } from 'rxjs';
import type { Todo } from '../shared/types';
import type { TodoLiveSnapshot } from '../shared/todo-live';
import { todoEffects$ } from './todo.effects';
import { interpretTodoIntent } from './todo.intents';
import { createTodoModel } from './todo.model';
import type { TodoService } from './todo.service';
import { createInitialState, reducer, type Action, type Operation, type State } from './todo.state';

const first: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };
const second: Todo = { ...first, id: '2', title: 'Second' };

function snapshot(revision: number, todos: Todo[] = [first], stateGeneration = 'history-a', collectionId = 'collection-a'): TodoLiveSnapshot {
	return { schemaVersion: 1, collectionId, stateGeneration, revision, todos };
}

function begin(state = createInitialState({ collectionSource: 'live' }), connectionId = 1): State {
	return reducer(state, { type: 'LIVE_CONNECTING', connectionId, attempt: 0 });
}

function receive(state: State, value: TodoLiveSnapshot, connectionId = state.live!.connectionId): State {
	return reducer(state, { type: 'LIVE_SNAPSHOT', connectionId, snapshot: value });
}

function ready(): State { return receive(begin(), snapshot(5)); }

function interrupt(state: State, retrying = true): State {
	return reducer(state, { type: 'LIVE_INTERRUPTED', connectionId: state.live!.connectionId,
		message: 'Connection lost.', retrying, attempt: 1, ...(retrying ? { delayMs: 250 } : {}) });
}

function queued(state: State, operation: Operation): State {
	return reducer(state, { type: 'OPERATION_QUEUED', operation });
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}

describe('live collection admission and remembered identity', () => {
	it('keeps construction idle and distinguishes the first complete empty snapshot from loading', () => {
		const initial = createInitialState({ collectionSource: 'live', collectionId: 'collection-a' });
		expect(initial).toMatchObject({ todos: [], loadStatus: 'idle', connection: 'idle',
			live: { expectedCollectionId: 'collection-a', identity: null, acceptingSnapshots: false, stale: false } });
		const connecting = begin(initial);
		expect(connecting).toMatchObject({ loadStatus: 'loading', connection: 'connecting' });
		const current = receive(connecting, snapshot(0, []));
		expect(current).toMatchObject({ loadStatus: 'ready', todos: [], connection: 'connected',
			live: { identity: { collectionId: 'collection-a', stateGeneration: 'history-a', revision: 0 },
				firstSnapshotPending: false, stale: false } });
	});

	it('pins the configured collection or the first admitted collection and rejects another collection', () => {
		const configured = begin(createInitialState({ collectionSource: 'live', collectionId: 'collection-a' }));
		expect(receive(configured, snapshot(0, [second], 'other', 'collection-b'))).toBe(configured);
		const current = ready();
		expect(current.live?.expectedCollectionId).toBe('collection-a');
		expect(receive(current, snapshot(100, [second], 'history-a', 'collection-b'))).toBe(current);
		const reconnecting = begin(current, 2);
		expect(receive(reconnecting, snapshot(0, [second], 'other', 'collection-b'))).toBe(reconnecting);
	});

	it('ignores snapshots before ownership and all finite compatibility snapshot/connection facts in live mode', () => {
		const initial = createInitialState({ collectionSource: 'live' });
		expect(receive(initial, snapshot(0), 0)).toBe(initial);
		expect(receive(initial, snapshot(0), 1)).toBe(initial);
		const current = ready();
		expect(reducer(current, { type: 'SERVER_SNAPSHOT', todos: [second] })).toBe(current);
		expect(reducer(current, { type: 'CONNECTION_CHANGED', status: 'disconnected' })).toBe(current);
	});

	it('ignores invalid/repeated connection starts and callbacks from superseded connections', () => {
		const current = begin(ready(), 2);
		for (const connectionId of [-1, 0, 1, 2, 2.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(reducer(current, { type: 'LIVE_CONNECTING', connectionId, attempt: 0 })).toBe(current);
		}
		expect(receive(current, snapshot(100, [second]), 1)).toBe(current);
		expect(receive(current, snapshot(0, [second], 'history-b'), 1)).toBe(current);
		expect(reducer(current, { type: 'LIVE_INTERRUPTED', connectionId: 1, message: 'Old callback', retrying: false, attempt: 4 })).toBe(current);
		expect(receive(current, snapshot(6, [first, second]), 2).todos).toEqual([first, second]);
	});

	it('rejects duplicate/older revisions without touching identities, including different duplicate payloads', () => {
		const current = ready();
		expect(receive(current, snapshot(5, [second]))).toBe(current);
		expect(receive(current, snapshot(4, []))).toBe(current);
		expect(receive(current, snapshot(0, [second]))).toBe(current);
		const next = receive(current, snapshot(9, [first, second]));
		expect(next.todos).toEqual([first, second]);
		expect(next.todos[0]).toBe(current.todos[0]);
		expect(next.live?.identity?.revision).toBe(9);
	});

	it('accepts a newer revision even when content is equal, preserving the collection reference', () => {
		const current = ready();
		const next = receive(current, snapshot(6, [{ ...first }]));
		expect(next).not.toBe(current);
		expect(next.todos).toBe(current.todos);
		expect(next.live?.identity?.revision).toBe(6);
	});

	it('retains known data while retrying and lets equal first revision restore current readiness', () => {
		const current = ready();
		const disconnected = interrupt(current);
		expect(disconnected).toMatchObject({ connection: 'connecting', loadStatus: 'ready',
			live: { stale: true, acceptingSnapshots: false, attempt: 1, retryDelayMs: 250, error: 'Connection lost.' } });
		expect(disconnected.todos).toBe(current.todos);
		expect(receive(disconnected, snapshot(6, [second]))).toBe(disconnected);
		const connecting = begin(disconnected, 2);
		expect(connecting.live?.stale).toBe(true);
		const reconnected = receive(connecting, snapshot(5, [second]));
		expect(reconnected.todos).toBe(current.todos);
		expect(reconnected).toMatchObject({ connection: 'connected', loadStatus: 'ready',
			live: { firstSnapshotPending: false, stale: false, error: null, retryDelayMs: null } });
	});

	it('requests explicit resynchronization for an older first snapshot without regressing collection', () => {
		const current = ready();
		const connecting = begin(interrupt(current), 2);
		const rejected = receive(connecting, snapshot(4, [second]));
		expect(rejected.todos).toBe(current.todos);
		expect(rejected).toMatchObject({ connection: 'disconnected', live: { stale: true, resyncRequired: true,
			acceptingSnapshots: false, firstSnapshotPending: false, identity: current.live!.identity } });
		expect(receive(rejected, snapshot(0, [second], 'history-b'))).toBe(rejected);
		const recovered = receive(begin(rejected, 3), snapshot(6, [first, second]));
		expect(recovered).toMatchObject({ connection: 'connected', live: { stale: false, resyncRequired: false } });
	});

	it('accepts a changed history only as the first snapshot from a newer owned connection', () => {
		const current = ready();
		const replaced = receive(begin(interrupt(current), 2), snapshot(0, [second], 'history-b'));
		expect(replaced.todos).toEqual([second]);
		expect(replaced.live?.identity).toEqual({ collectionId: 'collection-a', stateGeneration: 'history-b', revision: 0 });
		expect(receive(replaced, snapshot(100, [first]), 1)).toBe(replaced);
		const newer = receive(replaced, snapshot(1, [second, first], 'history-b'));
		expect(newer.todos).toEqual([second, first]);
	});

	it('rejects a delayed different history within the same connection and leaves recovery explicit', () => {
		const current = ready();
		const rejected = receive(current, snapshot(100, [second], 'history-b'));
		expect(rejected.todos).toBe(current.todos);
		expect(rejected.live?.identity).toBe(current.live?.identity);
		expect(rejected).toMatchObject({ connection: 'disconnected', live: { stale: true, resyncRequired: true, acceptingSnapshots: false } });
		expect(receive(rejected, snapshot(101, [second], 'history-b'))).toBe(rejected);
		expect(receive(rejected, snapshot(6, [first, second]))).toBe(rejected);
	});

	it('does not reopen history admission after an equal reconnect snapshot', () => {
		const reconnected = receive(begin(interrupt(ready()), 2), snapshot(5));
		const rejected = receive(reconnected, snapshot(0, [second], 'history-b'));
		expect(rejected.todos).toBe(reconnected.todos);
		expect(rejected.live?.resyncRequired).toBe(true);
	});

	it('separates connection failure from pending mutation errors and local drafts', () => {
		const current = queued({ ...ready(), draft: 'Unsent', error: 'Write failed' }, { id: 'other', kind: 'delete', todoId: '1' });
		const withError = { ...current, error: 'Write failed' };
		const failed = interrupt(withError, false);
		expect(failed).toMatchObject({ draft: 'Unsent', error: 'Write failed', connection: 'disconnected', loadStatus: 'ready',
			live: { stale: true, error: 'Connection lost.', retryDelayMs: null } });
		const recovered = receive(begin(failed, 2), snapshot(6, []));
		expect(recovered).toMatchObject({ draft: 'Unsent', error: 'Write failed', live: { stale: false, error: null } });
		expect(recovered.pending).toBe(current.pending);
	});

	it('shows initial retry versus terminal failure without inventing a known empty collection', () => {
		const retry = interrupt(begin());
		expect(retry).toMatchObject({ loadStatus: 'loading', live: { identity: null, stale: false } });
		const failed = interrupt(retry, false);
		expect(failed).toMatchObject({ loadStatus: 'error', connection: 'disconnected', live: { identity: null } });
		const recovered = receive(begin(failed, 2), snapshot(0, []));
		expect(recovered).toMatchObject({ loadStatus: 'ready', connection: 'connected', todos: [] });
	});

	it('owns accepted snapshot data and replays a frozen recovery trace deterministically', () => {
		const value = snapshot(0, [{ ...first }]);
		const current = receive(begin(), value);
		value.todos[0].title = 'External mutation';
		value.todos.length = 0;
		expect(current.todos).toEqual([first]);
		const initial = freeze(createInitialState({ collectionSource: 'live' }));
		const actions = freeze<Action[]>([
			{ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 0 },
			{ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(5) },
			{ type: 'DRAFT_CHANGED', value: 'Keep draft' },
			{ type: 'LIVE_INTERRUPTED', connectionId: 1, retrying: true, attempt: 1, delayMs: 250, message: 'Lost' },
			{ type: 'LIVE_CONNECTING', connectionId: 2, attempt: 1 },
			{ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(9, [second]) },
			{ type: 'LIVE_SNAPSHOT', connectionId: 2, snapshot: snapshot(0, [second], 'history-b') },
		]);
		const original = structuredClone({ initial, actions });
		const run = () => actions.reduce((state, action) => freeze(reducer(state, action)), initial);
		expect(run()).toEqual(run());
		expect({ initial, actions }).toEqual(original);
	});
});

describe('HTTP settlement under live collection authority', () => {
	it.each(['http-first', 'snapshot-first'] as const)('creates exactly one collection update with %s delivery', order => {
		let state = queued({ ...ready(), draft: 'Second' }, { id: 'c', kind: 'create', title: 'Second' });
		const before = state;
		const success: Action = { type: 'CREATE_SUCCEEDED', operationId: 'c', todo: second };
		const live: Action = { type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(6, [first, second]) };
		let collectionUpdates = 0;
		for (const action of order === 'http-first' ? [success, live] : [live, success]) {
			const next = reducer(state, action);
			if (next.todos !== state.todos) collectionUpdates++;
			if (action.type === 'CREATE_SUCCEEDED') expect(next.todos).toBe(state.todos);
			state = next;
		}
		expect(collectionUpdates).toBe(1);
		expect(state).toMatchObject({ todos: [first, second], pending: [], draft: '' });
		expect(before.todos).toEqual([first]);
	});

	it.each(['http-first', 'snapshot-first'] as const)('updates only from the snapshot with %s delivery', order => {
		const updated = { ...first, completed: true };
		let state = queued(ready(), { id: 'u', kind: 'update', todoId: '1' });
		const success: Action = { type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: updated };
		const live: Action = { type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(6, [updated]) };
		let collectionUpdates = 0;
		for (const action of order === 'http-first' ? [success, live] : [live, success]) {
			const next = reducer(state, action);
			if (next.todos !== state.todos) collectionUpdates++;
			if (action.type === 'UPDATE_SUCCEEDED') expect(next.todos).toBe(state.todos);
			state = next;
		}
		expect(collectionUpdates).toBe(1);
		expect(state).toMatchObject({ todos: [updated], pending: [] });
	});

	it.each(['http-first', 'snapshot-first'] as const)('deletes only from the snapshot with %s delivery', order => {
		let state = queued(ready(), { id: 'd', kind: 'delete', todoId: '1' });
		const success: Action = { type: 'DELETE_SUCCEEDED', operationId: 'd', id: '1' };
		const live: Action = { type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(6, []) };
		let collectionUpdates = 0;
		for (const action of order === 'http-first' ? [success, live] : [live, success]) {
			const next = reducer(state, action);
			if (next.todos !== state.todos) collectionUpdates++;
			if (action.type === 'DELETE_SUCCEEDED') expect(next.todos).toBe(state.todos);
			state = next;
		}
		expect(collectionUpdates).toBe(1);
		expect(state).toMatchObject({ todos: [], pending: [] });
	});

	it('does not let an HTTP response arriving after a newer snapshot overwrite or resurrect a Todo', () => {
		const pending = queued(queued(ready(), { id: 'u', kind: 'update', todoId: '1' }), { id: 'c', kind: 'create', title: 'Second' });
		const deleted = receive(pending, snapshot(9, []));
		const afterUpdate = reducer(deleted, { type: 'UPDATE_SUCCEEDED', operationId: 'u', todo: { ...first, completed: true } });
		const afterCreate = reducer(afterUpdate, { type: 'CREATE_SUCCEEDED', operationId: 'c', todo: second });
		expect(afterUpdate.todos).toBe(deleted.todos);
		expect(afterCreate.todos).toBe(deleted.todos);
		expect(afterCreate.pending).toEqual([]);
	});

	it('does not populate an initial collection from HTTP success or issue finite refreshes in live mode', () => {
		let state = queued(begin(), { id: 'c', kind: 'create', title: 'First' });
		state = reducer(state, { type: 'CREATE_SUCCEEDED', operationId: 'c', todo: first });
		expect(state).toMatchObject({ todos: [], loadStatus: 'loading', pending: [] });
		const message: Action = { type: 'LOAD_REQUESTED' };
		expect(interpretTodoIntent({ message, state, previous: state })).toBeNull();
		const pending = queued(state, { id: 'l', kind: 'load' });
		const loaded = reducer(pending, { type: 'LOAD_SUCCEEDED', operationId: 'l', todos: [first] });
		expect(loaded.todos).toBe(state.todos);
		expect(loaded).toMatchObject({ loadStatus: 'loading', pending: [] });
	});

	it('keeps the mounted effect/model flow pending-only on HTTP acknowledgement without retrying writes', () => {
		const model = createTodoModel({ collectionSource: 'live', collectionId: 'collection-a' });
		const createResponse = new Subject<Todo>();
		const service: TodoService = {
			getAll$: vi.fn(() => of([second])), create$: vi.fn(() => createResponse),
			update$: vi.fn(() => of(first)), remove$: vi.fn(() => of(undefined)),
		};
		const states: State[] = [];
		const observed = model.state$.subscribe(state => states.push(state));
		const effect = todoEffects$(model.transitions$, service).subscribe(model.dispatch);
		model.start();
		model.dispatch({ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 0 });
		model.dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(0, []) });
		model.dispatch({ type: 'LOAD_REQUESTED' });
		model.dispatch({ type: 'CREATE_REQUESTED', title: 'First' });
		expect(states.at(-1)?.pending).toHaveLength(1);
		createResponse.next(first);
		expect(states.at(-1)).toMatchObject({ todos: [], pending: [] });
		model.dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: snapshot(1) });
		expect(states.at(-1)?.todos).toEqual([first]);
		model.dispatch({ type: 'LIVE_INTERRUPTED', connectionId: 1, retrying: true, attempt: 1, message: 'Offline' });
		model.dispatch({ type: 'LIVE_CONNECTING', connectionId: 2, attempt: 1 });
		model.dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 2, snapshot: snapshot(1) });
		expect(service.create$).toHaveBeenCalledTimes(1);
		expect(service.getAll$).not.toHaveBeenCalled();
		effect.unsubscribe();
		observed.unsubscribe();
		model.dispose();
	});
});
