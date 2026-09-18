import { map, mergeMap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { HttpError } from '../core/errors';
import { created, json, noContent, stream$ } from '../core/response';
import type { Effect, SseEvent } from '../core/types';
import { validateBody, validateParams, validateQuery } from '../core/validator';
import { CreateTodoSchema, TodoListQuerySchema, TodoParamsSchema, UpdateTodoSchema } from './todo.validator';
import type { TodoStore } from './todo.store-factory';
import { routes, type RouteResponse } from '../../shared/routes';
import { createMemoryTodoRepository, type TodoRepository } from './todo.repository';

export interface TodoServices {
	todoStore?: TodoStore;
	todoRepository?: TodoRepository;
	todoLive$?: Observable<SseEvent>;
}

export const createTodoEffects = () => ({
	getAll$: ((req$) =>
		req$.pipe(
			validateQuery(TodoListQuerySchema),
			mergeMap(req => getTodoRepository(req).list$(
				req.query.completed === undefined ? undefined : req.query.completed === 'true',
			).pipe(map(todos => json(todos)))),
		)) as Effect,

	create$: ((req$) =>
		req$.pipe(
			validateBody(CreateTodoSchema),
			mergeMap(req => getTodoRepository(req).create$(req.body).pipe(
				map(todo => created(todo satisfies RouteResponse<typeof routes.todos.create>)),
			)),
		)) as Effect,

	update$: ((req$) =>
		req$.pipe(
			validateParams(TodoParamsSchema),
			validateBody(UpdateTodoSchema),
			mergeMap(req => getTodoRepository(req).update$(req.params.id, req.body).pipe(
				map(todo => json(todo satisfies RouteResponse<typeof routes.todos.update>)),
			)),
		)) as Effect,

	delete$: ((req$) =>
		req$.pipe(
			validateParams(TodoParamsSchema),
			mergeMap(req => getTodoRepository(req).delete$(req.params.id).pipe(map(() => noContent()))),
		)) as Effect,

	todoStream$: ((req$) =>
		req$.pipe(
			map(req => {
				const live = req.context.services.todoLive$ as Observable<SseEvent> | undefined;
				if (live) return { ...stream$(live), stream: live, streamPolicy: 'latest-snapshot' as const };
				const store = req.context.services.todoStore as TodoStore | undefined;
				if (!store) throw new HttpError(503, 'Todo live storage is not configured');
				return { ...stream$(store.todos$, 'todos'), streamPolicy: 'latest-snapshot' as const };
			}),
		)) as Effect,
});

const defaultEffects = createTodoEffects();
export const getAll$ = defaultEffects.getAll$;
export const create$ = defaultEffects.create$;
export const update$ = defaultEffects.update$;
export const delete$ = defaultEffects.delete$;
export const todoStream$ = defaultEffects.todoStream$;

function getTodoRepository(req: { context: { services: Record<string, unknown> } }): TodoRepository {
	const capability = req.context.services.todoRepository as TodoRepository | undefined;
	if (capability) return capability;
	const store = req.context.services.todoStore as TodoStore | undefined;
	if (store) return createMemoryTodoRepository(store);
	throw new HttpError(503, 'Todo storage is not configured');
}
