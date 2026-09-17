import { expectTypeOf } from 'vitest';
import { apiPath, buildPath, routes, type RouteBody, type RouteParams, type RouteQuery, type RouteResponse } from './routes';
import type { CreateTodoBody, Todo } from './types';
import { todoListSchema, todoSchema } from './todo.schema';

describe('shared routes', () => {
	it('builds concrete paths from typed route params', () => {
		expect(buildPath(routes.todos.update.path, { id: 'a b' })).toBe('/todos/a%20b');
		expect(apiPath(routes.todos.remove.path, { id: '42' })).toBe('/api/todos/42');
	});

	it('derives path parameter types from route templates', () => {
		expectTypeOf<RouteParams<typeof routes.todos.update.path>>().toEqualTypeOf<{ id: string }>();
		expectTypeOf<RouteParams<typeof routes.todos.list.path>>().toEqualTypeOf<Record<never, never>>();
	});

	it('derives request and response payload types from route contracts', () => {
		expectTypeOf<RouteBody<typeof routes.todos.create>>().toEqualTypeOf<CreateTodoBody>();
		expectTypeOf<RouteQuery<typeof routes.todos.list>>().toEqualTypeOf<{ completed?: 'true' | 'false' }>();
		expectTypeOf<RouteResponse<typeof routes.todos.create>>().toEqualTypeOf<Todo>();
		expectTypeOf<RouteResponse<typeof routes.todos.list>>().toEqualTypeOf<Todo[]>();
	});

	it('declares one runtime response contract for every route', () => {
		expect(routes.todos.list.responseBody).toEqual({ kind: 'json', schema: todoListSchema });
		expect(routes.todos.create.responseBody).toEqual({ kind: 'json', schema: todoSchema });
		expect(routes.todos.update.responseBody).toEqual({ kind: 'json', schema: todoSchema });
		expect(routes.todos.remove.responseBody).toEqual({ kind: 'empty', status: 204 });
		expect(routes.todos.stream.responseBody).toEqual({ kind: 'stream' });
	});

	it('validates Todo field types and required values at the shared boundary', () => {
		const todo = { id: '42', title: 'Write tests', completed: false, createdAt: '2026-09-17T00:00:00.000Z' };
		expect(todoListSchema.parse([todo])).toEqual([todo]);
		for (const invalid of [
			{ ...todo, id: '' }, { ...todo, title: '' }, { ...todo, completed: 'false' },
			{ ...todo, createdAt: 'yesterday' }, { id: '42' },
		]) expect(todoSchema.safeParse(invalid).success).toBe(false);
	});

	it('builds paths with query strings', () => {
		expect(apiPath(routes.todos.list.path, {}, { completed: 'true' })).toBe('/api/todos?completed=true');
	});
});
