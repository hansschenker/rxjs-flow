import { routes } from '../../shared/routes';
import { handle, type RouteDefinition } from '../core/router';
import { createTodoEffects } from './todo.effect';

/** One registration list for Node and Hono; construction executes no operation. */
export function createTodoRoutes(): RouteDefinition[] {
	const effects = createTodoEffects();
	return [
		handle(routes.todos.list, effects.getAll$),
		handle(routes.todos.stream, effects.todoStream$),
		handle(routes.todos.create, effects.create$),
		handle(routes.todos.update, effects.update$),
		handle(routes.todos.remove, effects.delete$),
	];
}
