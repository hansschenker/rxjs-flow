import type { Observable } from 'rxjs';
import { createClient, type ClientOptions } from './api';
import { routes } from '../shared/routes';
import type { CreateTodoBody, Todo, UpdateTodoBody } from '../shared/types';

export interface TodoService {
	getAll$: () => Observable<Todo[]>;
	create$: (body: CreateTodoBody) => Observable<Todo>;
	update$: (id: string, body: UpdateTodoBody) => Observable<Todo>;
	remove$: (id: string) => Observable<void>;
}

const serviceFor = (api: ReturnType<typeof createClient<typeof routes>>): TodoService => ({
	getAll$: () => api.todos.list({}),
	create$: api.todos.create,
	update$: (id, body) => api.todos.update({ id }, body),
	remove$: id => api.todos.remove({ id }),
});

/** Construction is inert; each subscription uses this instance's transport. */
export const createTodoService = (options: ClientOptions = {}): TodoService =>
	serviceFor(createClient(routes, options));

// Compatibility exports describe the default client without touching global fetch.
export const api = createClient(routes);
export const { getAll$, create$, update$, remove$ } = serviceFor(api);
