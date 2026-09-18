import { catchError, defer, mergeMap, of, type Observable } from 'rxjs';
import type { AppContext, Effect, HttpRequest, HttpResponse, Middleware } from './types';
import { BadRequest, errorResponse, NotFound } from './errors';
import type { AnyRoute, RouteBody, RouteParams, RouteQuery } from '../../shared/routes';

export interface Route<TPath extends string = string> {
	method: string;
	path: TPath;
	effect: Effect;
	middlewares?: Middleware[];
}

export interface RouteGroup {
	prefix: string;
	routes: RouteDefinition[];
	middlewares?: Middleware[];
}

export type RouteDefinition = Route | RouteGroup;
export type ContractEffect<TRoute extends AnyRoute> = Effect<
	HttpRequest<
		RouteBody<TRoute>,
		RouteParams<TRoute['path']>,
		RouteQuery<TRoute> extends undefined ? Record<string, string | undefined> : Extract<RouteQuery<TRoute>, Record<string, string | undefined>>
	>
>;

const joinPath = (prefix: string, path: string): string =>
	`${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`.replace(/^$/, '/');

const matchRoute = (pattern: string, url: string): Record<string, string> | null => {
	const patternParts = pattern.split('/').filter(Boolean);
	const urlParts = url.split('/').filter(Boolean);
	if (patternParts.length !== urlParts.length) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < patternParts.length; i++) {
		if (patternParts[i].startsWith(':')) {
			try {
				params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
			} catch {
				throw new BadRequest('Malformed route parameter');
			}
		} else if (patternParts[i] !== urlParts[i]) {
			return null;
		}
	}
	return params;
};

export const route = <TPath extends string>(
	method: string,
	path: TPath,
	effect: Effect,
	...middlewares: Middleware[]
): Route<TPath> => ({
	method,
	path,
	effect,
	middlewares,
});

export const get = <TPath extends string>(path: TPath, effect: Effect, ...middlewares: Middleware[]): Route<TPath> =>
	route('GET', path, effect, ...middlewares);
export const post = <TPath extends string>(path: TPath, effect: Effect, ...middlewares: Middleware[]): Route<TPath> =>
	route('POST', path, effect, ...middlewares);
export const put = <TPath extends string>(path: TPath, effect: Effect, ...middlewares: Middleware[]): Route<TPath> =>
	route('PUT', path, effect, ...middlewares);
export const del = <TPath extends string>(path: TPath, effect: Effect, ...middlewares: Middleware[]): Route<TPath> =>
	route('DELETE', path, effect, ...middlewares);

export const handle = <TRoute extends AnyRoute>(
	contract: TRoute,
	effect: ContractEffect<TRoute>,
	...middlewares: Middleware[]
): Route<TRoute['path']> =>
	route(contract.method, contract.path, effect as Effect, ...middlewares);

export const group = (prefix: string, routes: RouteDefinition[], ...middlewares: Middleware[]): RouteGroup => ({
	prefix,
	routes,
	middlewares,
});

export const flattenRoutes = (definitions: RouteDefinition[], parentPrefix = '', parentMiddlewares: Middleware[] = []): Route[] =>
	definitions.flatMap(definition => {
		if (!('prefix' in definition)) {
			return [{
				...definition,
				path: joinPath(parentPrefix, definition.path),
				middlewares: [...parentMiddlewares, ...(definition.middlewares ?? [])],
			}];
		}
		return flattenRoutes(
			definition.routes,
			joinPath(parentPrefix, definition.prefix),
			[...parentMiddlewares, ...(definition.middlewares ?? [])],
		);
	});

/** Apply a matched route without exposing either platform's raw context. */
export function applyRoute(
	routeDefinition: Route,
	request: HttpRequest,
	context: AppContext,
): Observable<HttpResponse> {
	return defer(() => {
		const enriched = { ...request, context };
		const piped = (routeDefinition.middlewares ?? []).reduce(
			(source$, middleware) => source$.pipe(middleware),
			of(enriched),
		);
		return routeDefinition.effect(piped);
	}).pipe(catchError(error => of(errorResponse(error))));
}

export const createRouter = (
	definitions: RouteDefinition[],
	context: AppContext = { services: {}, state: {} },
): Effect =>
	request$ => request$.pipe(
		mergeMap(request => defer(() => {
			for (const definition of flattenRoutes(definitions)) {
				if (definition.method !== request.method) continue;
				const params = matchRoute(definition.path, request.url);
				if (params === null) continue;
				return applyRoute(definition, { ...request, params }, context);
			}
			return of(errorResponse(new NotFound()));
		}).pipe(catchError(error => of(errorResponse(error))))),
	);
