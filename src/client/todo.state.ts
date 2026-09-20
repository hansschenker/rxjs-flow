import type { Todo } from '../shared/types';
import type { RequestFailure } from '../shared/http-error';
import type { TodoLiveSnapshot } from '../shared/todo-live';

export type RememberedFailure = Omit<RequestFailure, 'cause'>;

export type Operation =
	| { readonly id: string; readonly kind: 'load' }
	| { readonly id: string; readonly kind: 'create'; readonly title: string }
	| { readonly id: string; readonly kind: 'update'; readonly todoId: string }
	| { readonly id: string; readonly kind: 'delete'; readonly todoId: string };

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TodoStateOptions {
	/** HTTP mode retains the finite M01–M04 fixtures. Mounted applications select live explicitly. */
	readonly collectionSource?: 'http' | 'live';
	readonly collectionId?: string;
}

export type LiveIdentity = Pick<TodoLiveSnapshot, 'collectionId' | 'stateGeneration' | 'revision'>;

export interface LiveState {
	readonly expectedCollectionId: string | null;
	readonly identity: LiveIdentity | null;
	readonly connectionId: number;
	readonly firstSnapshotPending: boolean;
	readonly acceptingSnapshots: boolean;
	readonly stale: boolean;
	readonly attempt: number;
	readonly retryDelayMs: number | null;
	readonly error: string | null;
	readonly resyncRequired: boolean;
}

// Intents request work; correlated HTTP facts settle accepted operations.
// In live mode only a validated, admitted snapshot can replace the collection.
export type Action =
	| { readonly type: 'DRAFT_CHANGED'; readonly value: string }
	| { readonly type: 'LOAD_REQUESTED' }
	| { readonly type: 'CREATE_REQUESTED'; readonly title: string }
	| { readonly type: 'TOGGLE_REQUESTED'; readonly id: string; readonly completed: boolean }
	| { readonly type: 'DELETE_REQUESTED'; readonly id: string }
	| { readonly type: 'OPERATION_QUEUED'; readonly operation: Operation }
	| { readonly type: 'OPERATION_STARTED'; readonly operation: Operation }
	| { readonly type: 'LOAD_SUCCEEDED'; readonly operationId: string; readonly todos: readonly Readonly<Todo>[] }
	| { readonly type: 'CREATE_SUCCEEDED'; readonly operationId: string; readonly todo: Readonly<Todo> }
	| { readonly type: 'UPDATE_SUCCEEDED'; readonly operationId: string; readonly todo: Readonly<Todo> }
	| { readonly type: 'DELETE_SUCCEEDED'; readonly operationId: string; readonly id: string }
	| { readonly type: 'OPERATION_FAILED'; readonly operationId: string; readonly message: string; readonly failure?: RequestFailure }
	| { readonly type: 'OPERATION_CANCELLED'; readonly operationId: string }
	| { readonly type: 'MUTATION_REJECTED'; readonly message: string }
	| { readonly type: 'SERVER_SNAPSHOT'; readonly todos: readonly Readonly<Todo>[] }
	| { readonly type: 'CONNECTION_CHANGED'; readonly status: ConnectionStatus }
	| { readonly type: 'LIVE_CONNECTING'; readonly connectionId: number; readonly attempt: number }
	| { readonly type: 'LIVE_SNAPSHOT'; readonly connectionId: number; readonly snapshot: TodoLiveSnapshot }
	| { readonly type: 'LIVE_INTERRUPTED'; readonly connectionId: number; readonly message: string; readonly retrying: boolean; readonly attempt: number; readonly delayMs?: number }
	| { readonly type: 'ERROR_DISMISSED' };

export interface State {
	readonly todos: readonly Readonly<Todo>[];
	readonly draft: string;
	readonly loadStatus: LoadStatus;
	readonly pending: readonly Operation[];
	readonly error: string | null;
	readonly failure: RememberedFailure | null;
	readonly connection: ConnectionStatus;
	readonly live: LiveState | null;
}

export function createInitialState(options: TodoStateOptions = {}): State {
	return {
		todos: [], draft: '', loadStatus: 'idle', pending: [], error: null, failure: null, connection: 'idle',
		live: options.collectionSource === 'live' ? {
			expectedCollectionId: options.collectionId ?? null, identity: null, connectionId: 0,
			firstSnapshotPending: false, acceptingSnapshots: false, stale: false, attempt: 0,
			retryDelayMs: null, error: null, resyncRequired: false,
		} : null,
	};
}

function rememberFailure(failure?: RequestFailure): RememberedFailure | null {
	if (!failure) return null;
	// Keep structured HTTP evidence without retaining a transport exception/cause.
	return {
		kind: failure.kind, message: failure.message,
		...(failure.status === undefined ? {} : { status: failure.status }),
		...(failure.details === undefined ? {} : { details: failure.details }),
		...(failure.body === undefined ? {} : { body: failure.body }),
	};
}

function equalTodo(left: Readonly<Todo>, right: Readonly<Todo>): boolean {
	return left.id === right.id && left.title === right.title &&
		left.completed === right.completed && left.createdAt === right.createdAt;
}

function ownedTodo(incoming: Readonly<Todo>, previous?: Readonly<Todo>): Readonly<Todo> {
	return previous && equalTodo(previous, incoming) ? previous : { ...incoming };
}

function replaceCollection(previous: State['todos'], incoming: State['todos']): State['todos'] {
	const byId = new Map(previous.map(todo => [todo.id, todo]));
	const next = incoming.map(todo => ownedTodo(todo, byId.get(todo.id)));
	return previous.length === next.length && next.every((todo, index) => todo === previous[index])
		? previous : next;
}

function upsertTodo(todos: State['todos'], incoming: Readonly<Todo>): State['todos'] {
	const index = todos.findIndex(todo => todo.id === incoming.id);
	if (index === -1) return [...todos, ownedTodo(incoming)];
	const next = ownedTodo(incoming, todos[index]);
	return next === todos[index] ? todos : todos.map((todo, position) => position === index ? next : todo);
}

function removeOperation(state: State, id: string): readonly Operation[] {
	return state.pending.filter(operation => operation.id !== id);
}

function finishLoad(state: State, pending: readonly Operation[], failed: boolean): LoadStatus {
	// Ready includes a confirmed empty collection. A failed/cancelled refresh
	// must not make that collection look as if it has never been loaded.
	if (state.loadStatus === 'ready') return 'ready';
	if (pending.some(operation => operation.kind === 'load')) return 'loading';
	return failed || state.error !== null ? 'error' : 'idle';
}

function requireResync(state: State, live: LiveState, message: string): State {
	return {
		...state, connection: 'disconnected',
		live: { ...live, firstSnapshotPending: false, acceptingSnapshots: false,
			stale: live.identity !== null, error: message, resyncRequired: true },
	};
}

/** The transport validates shape; this pure boundary decides whether that history is current. */
function admitSnapshot(state: State, connectionId: number, snapshot: TodoLiveSnapshot): State {
	const live = state.live;
	if (!live || connectionId !== live.connectionId || !live.acceptingSnapshots) return state;
	if (live.expectedCollectionId !== null && snapshot.collectionId !== live.expectedCollectionId) return state;
	const previous = live.identity;
	const sameHistory = previous !== null && snapshot.stateGeneration === previous.stateGeneration;
	if (previous !== null && !sameHistory && !live.firstSnapshotPending) {
		return requireResync(state, live, 'Collection history changed. Resynchronization is required.');
	}
	if (sameHistory && snapshot.revision < previous.revision) {
		return live.firstSnapshotPending
			? requireResync(state, live, 'The current snapshot is older than the remembered collection. Resynchronization is required.')
			: state;
	}
	// An equal revision is useful after reconnect: it confirms remembered data is
	// current. Its payload never rewrites items, even if it contains different data.
	if (sameHistory && snapshot.revision === previous.revision) {
		return live.firstSnapshotPending || live.stale || state.connection !== 'connected'
			? { ...state, connection: 'connected', loadStatus: 'ready', live: {
				...live, firstSnapshotPending: false, stale: false, retryDelayMs: null, error: null,
			} } : state;
	}
	return {
		...state, todos: replaceCollection(state.todos, snapshot.todos), loadStatus: 'ready', connection: 'connected',
		live: {
			...live, expectedCollectionId: snapshot.collectionId,
			identity: { collectionId: snapshot.collectionId, stateGeneration: snapshot.stateGeneration, revision: snapshot.revision },
			firstSnapshotPending: false, stale: false, retryDelayMs: null, error: null, resyncRequired: false,
		},
	};
}

export function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'DRAFT_CHANGED':
			return state.draft === action.value ? state : { ...state, draft: action.value };
		case 'LOAD_REQUESTED':
		case 'CREATE_REQUESTED':
		case 'TOGGLE_REQUESTED':
		case 'DELETE_REQUESTED':
			return state;
		case 'OPERATION_QUEUED':
		case 'OPERATION_STARTED': {
			if (state.pending.some(operation => operation.id === action.operation.id)) return state;
			return {
				...state,
				pending: [...state.pending, { ...action.operation }],
				loadStatus: action.operation.kind === 'load' && state.loadStatus !== 'ready'
					? 'loading' : state.loadStatus,
				error: null,
				failure: null,
			};
		}
		case 'LOAD_SUCCEEDED': {
			if (!state.pending.some(operation => operation.id === action.operationId && operation.kind === 'load')) return state;
			if (state.live) return { ...state, pending: removeOperation(state, action.operationId) };
			return {
				...state, todos: replaceCollection(state.todos, action.todos),
				pending: removeOperation(state, action.operationId), loadStatus: 'ready', error: null, failure: null,
			};
		}
		case 'CREATE_SUCCEEDED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (operation?.kind !== 'create') return state;
			return {
				...state, todos: state.live ? state.todos : upsertTodo(state.todos, action.todo),
				pending: removeOperation(state, action.operationId),
				draft: state.draft.trim() === operation.title ? '' : state.draft,
			};
		}
		case 'UPDATE_SUCCEEDED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (operation?.kind !== 'update' || operation.todoId !== action.todo.id) return state;
			// A concurrent delete or snapshot may have removed the target already.
			// Its update still settles only its own operation, without resurrecting it.
			const todos = !state.live && state.todos.some(todo => todo.id === action.todo.id)
				? upsertTodo(state.todos, action.todo) : state.todos;
			return { ...state, todos, pending: removeOperation(state, action.operationId) };
		}
		case 'DELETE_SUCCEEDED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (operation?.kind !== 'delete' || operation.todoId !== action.id) return state;
			const todos = !state.live && state.todos.some(todo => todo.id === action.id)
				? state.todos.filter(todo => todo.id !== action.id) : state.todos;
			return { ...state, todos, pending: removeOperation(state, action.operationId) };
		}
		case 'OPERATION_FAILED':
		case 'OPERATION_CANCELLED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (!operation) return state;
			const pending = removeOperation(state, action.operationId);
			const failed = action.type === 'OPERATION_FAILED';
			return {
				...state, pending,
				loadStatus: operation.kind === 'load' ? finishLoad(state, pending, failed) : state.loadStatus,
				error: failed ? action.message : state.error,
				failure: failed ? rememberFailure(action.failure) : state.failure,
			};
		}
		case 'MUTATION_REJECTED':
			return { ...state, error: action.message, failure: null };
		case 'SERVER_SNAPSHOT': {
			if (state.live) return state;
			const todos = replaceCollection(state.todos, action.todos);
			return todos === state.todos && state.loadStatus === 'ready'
				? state : { ...state, todos, loadStatus: 'ready' };
		}
		case 'CONNECTION_CHANGED':
			return state.live || state.connection === action.status ? state : { ...state, connection: action.status };
		case 'LIVE_CONNECTING': {
			const live = state.live;
			if (!live || !Number.isSafeInteger(action.connectionId) || action.connectionId <= live.connectionId) return state;
			return {
				...state, connection: 'connecting', loadStatus: live.identity ? state.loadStatus : 'loading',
				live: { ...live, connectionId: action.connectionId, firstSnapshotPending: true,
					acceptingSnapshots: true, stale: live.identity !== null, attempt: action.attempt,
					retryDelayMs: null, error: null, resyncRequired: false },
			};
		}
		case 'LIVE_SNAPSHOT':
			return admitSnapshot(state, action.connectionId, action.snapshot);
		case 'LIVE_INTERRUPTED': {
			const live = state.live;
			if (!live || action.connectionId !== live.connectionId || live.connectionId === 0) return state;
			return {
				...state, connection: action.retrying ? 'connecting' : 'disconnected',
				loadStatus: live.identity ? state.loadStatus : action.retrying ? 'loading' : 'error',
				live: { ...live, acceptingSnapshots: false, firstSnapshotPending: false,
					stale: live.identity !== null, attempt: action.attempt, retryDelayMs: action.delayMs ?? null,
					error: action.message, resyncRequired: false },
			};
		}
		case 'ERROR_DISMISSED':
			return state.error === null && state.failure === null ? state : { ...state, error: null, failure: null };
	}
}
