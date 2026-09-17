import type { Todo } from '../shared/types';

export type Operation =
	| { readonly id: string; readonly kind: 'load' }
	| { readonly id: string; readonly kind: 'create'; readonly title: string }
	| { readonly id: string; readonly kind: 'update'; readonly todoId: string }
	| { readonly id: string; readonly kind: 'delete'; readonly todoId: string };

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

// Intents request work; only correlated operation facts settle accepted work.
// SERVER_SNAPSHOT already contains domain data. Transport decoding belongs to
// its adapter, and live revision/connection admission remains M06 work.
export type Action =
	| { readonly type: 'DRAFT_CHANGED'; readonly value: string }
	| { readonly type: 'LOAD_REQUESTED' }
	| { readonly type: 'CREATE_REQUESTED'; readonly title: string }
	| { readonly type: 'TOGGLE_REQUESTED'; readonly id: string; readonly completed: boolean }
	| { readonly type: 'DELETE_REQUESTED'; readonly id: string }
	| { readonly type: 'OPERATION_STARTED'; readonly operation: Operation }
	| { readonly type: 'LOAD_SUCCEEDED'; readonly operationId: string; readonly todos: readonly Readonly<Todo>[] }
	| { readonly type: 'CREATE_SUCCEEDED'; readonly operationId: string; readonly todo: Readonly<Todo> }
	| { readonly type: 'UPDATE_SUCCEEDED'; readonly operationId: string; readonly todo: Readonly<Todo> }
	| { readonly type: 'DELETE_SUCCEEDED'; readonly operationId: string; readonly id: string }
	| { readonly type: 'OPERATION_FAILED'; readonly operationId: string; readonly message: string }
	| { readonly type: 'OPERATION_CANCELLED'; readonly operationId: string }
	| { readonly type: 'SERVER_SNAPSHOT'; readonly todos: readonly Readonly<Todo>[] }
	| { readonly type: 'CONNECTION_CHANGED'; readonly status: ConnectionStatus }
	| { readonly type: 'ERROR_DISMISSED' };

export interface State {
	readonly todos: readonly Readonly<Todo>[];
	readonly draft: string;
	readonly loadStatus: LoadStatus;
	readonly pending: readonly Operation[];
	readonly error: string | null;
	readonly connection: ConnectionStatus;
}

export function createInitialState(): State {
	return { todos: [], draft: '', loadStatus: 'idle', pending: [], error: null, connection: 'idle' };
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

export function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'DRAFT_CHANGED':
			return state.draft === action.value ? state : { ...state, draft: action.value };
		case 'LOAD_REQUESTED':
		case 'CREATE_REQUESTED':
		case 'TOGGLE_REQUESTED':
		case 'DELETE_REQUESTED':
			return state;
		case 'OPERATION_STARTED': {
			if (state.pending.some(operation => operation.id === action.operation.id)) return state;
			return {
				...state,
				pending: [...state.pending, { ...action.operation }],
				loadStatus: action.operation.kind === 'load' && state.loadStatus !== 'ready'
					? 'loading' : state.loadStatus,
				error: null,
			};
		}
		case 'LOAD_SUCCEEDED': {
			if (!state.pending.some(operation => operation.id === action.operationId && operation.kind === 'load')) return state;
			return {
				...state, todos: replaceCollection(state.todos, action.todos),
				pending: removeOperation(state, action.operationId), loadStatus: 'ready', error: null,
			};
		}
		case 'CREATE_SUCCEEDED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (operation?.kind !== 'create') return state;
			return {
				...state, todos: upsertTodo(state.todos, action.todo),
				pending: removeOperation(state, action.operationId),
				draft: state.draft.trim() === operation.title ? '' : state.draft,
			};
		}
		case 'UPDATE_SUCCEEDED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (operation?.kind !== 'update' || operation.todoId !== action.todo.id) return state;
			// A concurrent delete or snapshot may have removed the target already.
			// Its update still settles only its own operation, without resurrecting it.
			const todos = state.todos.some(todo => todo.id === action.todo.id)
				? upsertTodo(state.todos, action.todo) : state.todos;
			return { ...state, todos, pending: removeOperation(state, action.operationId) };
		}
		case 'DELETE_SUCCEEDED': {
			const operation = state.pending.find(operation => operation.id === action.operationId);
			if (operation?.kind !== 'delete' || operation.todoId !== action.id) return state;
			const todos = state.todos.some(todo => todo.id === action.id)
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
			};
		}
		case 'SERVER_SNAPSHOT': {
			const todos = replaceCollection(state.todos, action.todos);
			return todos === state.todos && state.loadStatus === 'ready'
				? state : { ...state, todos, loadStatus: 'ready' };
		}
		case 'CONNECTION_CHANGED':
			return state.connection === action.status ? state : { ...state, connection: action.status };
		case 'ERROR_DISMISSED':
			return state.error === null ? state : { ...state, error: null };
	}
}
