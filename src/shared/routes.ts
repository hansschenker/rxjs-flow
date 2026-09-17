import type { z } from 'zod';
import type { CreateTodoBody, Todo, UpdateTodoBody } from './types';
import { todoListSchema, todoSchema } from './todo.schema';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RouteParams<Path extends string> =
	Path extends `${string}:${infer Param}/${infer Rest}`
		? { [Key in Param | keyof RouteParams<`/${Rest}`>]: string }
		: Path extends `${string}:${infer Param}`
			? { [Key in Param]: string }
			: Record<never, never>;

export type ResponseBody<TResponse> =
	| { readonly kind: 'json'; readonly schema: z.ZodType<TResponse> }
	| { readonly kind: 'empty'; readonly status: 204 }
	| { readonly kind: 'stream' };

export interface RouteContract<
	TMethod extends HttpMethod,
	TPath extends string,
	TBody = undefined,
	TQuery = undefined,
	TResponse = unknown,
> {
	method: TMethod;
	path: TPath;
	body: TBody;
	query: TQuery;
	response: TResponse;
	responseBody: ResponseBody<TResponse>;
}

export type AnyRoute = RouteContract<HttpMethod, string, unknown, unknown, unknown>;
export type RouteBody<TRoute extends AnyRoute> = TRoute['body'];
export type RouteQuery<TRoute extends AnyRoute> = TRoute['query'];
export type RouteResponse<TRoute extends AnyRoute> = TRoute['response'];
export type RoutePath<TRoute extends AnyRoute> = TRoute['path'];
export type RouteRequest<TRoute extends AnyRoute> = {
	params: RouteParams<RoutePath<TRoute>>;
	body: RouteBody<TRoute>;
	query: RouteQuery<TRoute>;
};

export const defineRoute = <
	TMethod extends HttpMethod,
	TPath extends string,
	TBody = undefined,
	TQuery = undefined,
	TResponse = unknown,
>(
	method: TMethod,
	path: TPath,
	responseBody: ResponseBody<TResponse>,
	hasQuery?: boolean,
): RouteContract<TMethod, TPath, TBody, TQuery, TResponse> => ({
	method,
	path,
	body: undefined as TBody,
	query: (hasQuery === true ? {} : undefined) as TQuery,
	response: undefined as TResponse,
	responseBody,
});

export const routes = {
	todos: {
		list: defineRoute<'GET', '/todos', undefined, { completed?: 'true' | 'false' }, Todo[]>('GET', '/todos', { kind: 'json', schema: todoListSchema }, true),
		create: defineRoute<'POST', '/todos', CreateTodoBody, undefined, Todo>('POST', '/todos', { kind: 'json', schema: todoSchema }),
		update: defineRoute<'PUT', '/todos/:id', UpdateTodoBody, undefined, Todo>('PUT', '/todos/:id', { kind: 'json', schema: todoSchema }),
		remove: defineRoute<'DELETE', '/todos/:id', undefined, undefined, void>('DELETE', '/todos/:id', { kind: 'empty', status: 204 }),
		stream: defineRoute('GET', '/todos/stream', { kind: 'stream' }),
	},
} as const;

export type Routes = typeof routes;

export const buildPath = <TPath extends string>(
	path: TPath,
	params: RouteParams<TPath>,
): string =>
	path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) =>
		encodeURIComponent((params as Record<string, string>)[key]),
	);

export const apiPath = <TPath extends string>(
	path: TPath,
	params: RouteParams<TPath>,
	query?: Record<string, string | undefined>,
): string => {
	const concrete = `/api${buildPath(path, params)}`;
	const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined);
	return entries.length === 0 ? concrete : `${concrete}?${new URLSearchParams(entries as Array<[string, string]>).toString()}`;
};
