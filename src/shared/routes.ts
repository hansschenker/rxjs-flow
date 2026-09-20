import type { z } from 'zod';
import type { CreateTodoBody, Todo, UpdateTodoBody } from './types';
import { todoListSchema, todoSchema } from './todo.schema';
import { TODO_LIVE_EVENT, TODO_LIVE_PATH, todoLiveSnapshotSchema } from './todo-live';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RouteParams<Path extends string> =
	Path extends `${string}:${infer Param}/${infer Rest}`
		? { [Key in Param | keyof RouteParams<`/${Rest}`>]: string }
		: Path extends `${string}:${infer Param}`
			? { [Key in Param]: string }
			: Record<never, never>;

export type FiniteResponseBody<TResponse> =
	| { readonly kind: 'json'; readonly schema: z.ZodType<TResponse> }
	| { readonly kind: 'empty'; readonly status: 204 };

export type LiveResponseBody<TResponse> = {
	readonly kind: 'stream';
	readonly event: string;
	readonly schema: z.ZodType<TResponse>;
};

export type ResponseBody<TResponse> = FiniteResponseBody<TResponse> | LiveResponseBody<TResponse>;
export type ResponseKind = ResponseBody<unknown>['kind'];

export interface RouteContract<
	TMethod extends HttpMethod,
	TPath extends string,
	TBody = undefined,
	TQuery = undefined,
	TResponse = unknown,
	TKind extends ResponseKind = ResponseKind,
> {
	method: TMethod;
	path: TPath;
	body: TBody;
	query: TQuery;
	response: TResponse;
	responseBody: Extract<ResponseBody<TResponse>, { kind: TKind }>;
}

/** Structural boundary avoids widening a route's discriminant during inference. */
export interface AnyRoute {
	method: HttpMethod;
	path: string;
	body: unknown;
	query: unknown;
	response: unknown;
	responseBody: ResponseBody<unknown>;
}
export type AnyFiniteRoute = Omit<AnyRoute, 'responseBody'> & { responseBody: FiniteResponseBody<unknown> };
export type AnyLiveRoute = Omit<AnyRoute, 'method' | 'body' | 'query' | 'responseBody'> & {
	method: 'GET'; body: undefined; query: undefined; responseBody: LiveResponseBody<unknown>;
};
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
	responseBody: FiniteResponseBody<TResponse>,
	hasQuery?: boolean,
): RouteContract<TMethod, TPath, TBody, TQuery, TResponse, 'json' | 'empty'> => ({
	method,
	path,
	body: undefined as TBody,
	query: (hasQuery === true ? {} : undefined) as TQuery,
	response: undefined as TResponse,
	responseBody,
});

/** Live contracts are intentionally separate from finite JSON client methods. */
export function defineLiveRoute<TPath extends string, TResponse>(
	path: TPath,
	event: string,
	schema: z.ZodType<TResponse>,
): RouteContract<'GET', TPath, undefined, undefined, TResponse, 'stream'> {
	return { method: 'GET', path, body: undefined, query: undefined, response: undefined as TResponse,
		responseBody: { kind: 'stream', event, schema } };
}

export const routes = {
	todos: {
		list: defineRoute<'GET', '/todos', undefined, { completed?: 'true' | 'false' }, Todo[]>('GET', '/todos', { kind: 'json', schema: todoListSchema }, true),
		create: defineRoute<'POST', '/todos', CreateTodoBody, undefined, Todo>('POST', '/todos', { kind: 'json', schema: todoSchema }),
		update: defineRoute<'PUT', '/todos/:id', UpdateTodoBody, undefined, Todo>('PUT', '/todos/:id', { kind: 'json', schema: todoSchema }),
		remove: defineRoute<'DELETE', '/todos/:id', undefined, undefined, void>('DELETE', '/todos/:id', { kind: 'empty', status: 204 }),
		stream: defineLiveRoute('/todos/stream', 'todos', todoListSchema),
		live: defineLiveRoute(TODO_LIVE_PATH, TODO_LIVE_EVENT, todoLiveSnapshotSchema),
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
