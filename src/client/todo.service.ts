import { defer, type Observable } from 'rxjs';
import { createClient, type ClientOptions } from './api';
import { apiPath, routes } from '../shared/routes';
import type { CreateTodoBody, Todo, UpdateTodoBody } from '../shared/types';
import { decodeTodoLiveSnapshot, type TodoLiveSnapshot } from '../shared/todo-live';
import { liveConnection$, type LiveConnectionOptions, type LiveConnectionEvent, type LiveDecodeContext } from './live-connection';

export interface TodoService {
	getAll$: () => Observable<Todo[]>;
	create$: (body: CreateTodoBody) => Observable<Todo>;
	update$: (id: string, body: UpdateTodoBody) => Observable<Todo>;
	remove$: (id: string) => Observable<void>;
	/** The host owns one subscription; omitting it selects explicit finite compatibility mode. */
	live$?: (recover$: Observable<unknown>) => Observable<LiveConnectionEvent<TodoLiveSnapshot>>;
	/** Inert per-operation capability; optional and local, without changing the wire. */
	withOperation?: (operationId: string) => TodoService;
}

export interface TodoServiceOptions extends ClientOptions {
	readonly live?: Omit<LiveConnectionOptions, 'recover$'>;
	/** Optional known logical collection; otherwise the first validated snapshot pins it. */
	readonly collectionId?: string;
}

const serviceFor = (api: ReturnType<typeof createClient<typeof routes>>): TodoService => ({
	getAll$: () => api.todos.list({}),
	create$: api.todos.create,
	update$: (id, body) => api.todos.update({ id }, body),
	remove$: id => api.todos.remove({ id }),
});

/** Construction is inert; each subscription uses this instance's transport. */
export function createTodoService(options: TodoServiceOptions = {}): TodoService {
	return { ...serviceFor(createClient(routes, options)), live$: createLive, withOperation };

	function withOperation(operationId: string): TodoService {
		return createTodoService({ ...options, operationId });
	}

	function createLive(recover$: Observable<unknown>): Observable<LiveConnectionEvent<TodoLiveSnapshot>> {
		return defer(function ownTodoProtocol() {
			let collectionId = options.collectionId;
			let generation: string | undefined;
			let revision = -1;
			function decodeSnapshot(value: unknown, context: LiveDecodeContext): TodoLiveSnapshot {
				const snapshot = decodeTodoLiveSnapshot(value);
				if (collectionId !== undefined && snapshot.collectionId !== collectionId) {
					throw new Error('The live snapshot belongs to a different collection.');
				}
				if (!context.firstSnapshot && generation !== snapshot.stateGeneration) {
					throw new Error('Collection history changed within a connection. Reconnect to resynchronize.');
				}
				if (context.firstSnapshot && generation === snapshot.stateGeneration && snapshot.revision < revision) {
					throw new Error('The initial live snapshot is older than the remembered state. Reconnect to resynchronize.');
				}
				collectionId = snapshot.collectionId;
				revision = generation === snapshot.stateGeneration ? Math.max(revision, snapshot.revision) : snapshot.revision;
				generation = snapshot.stateGeneration;
				return snapshot;
			}
			return liveConnection$(apiPath(routes.todos.live.path, {}), routes.todos.live.responseBody.event,
				decodeSnapshot, { ...options.live, recover$ });
		});
	}
}

// Compatibility exports describe the default client without touching global fetch.
export const api = createClient(routes);
export const { getAll$, create$, update$, remove$ } = serviceFor(api);
const defaultLiveService = createTodoService();
export const live$ = defaultLiveService.live$!;
export const withOperation = defaultLiveService.withOperation!;
