import { Observable } from 'rxjs';
import { createRequestFailure, isRequestFailure, type RequestFailure } from '../shared/http-error';
import {
	apiPath,
	type AnyRoute,
	type RouteBody,
	type RouteParams,
	type RouteQuery,
	type RouteResponse,
	type ResponseBody,
} from '../shared/routes';

export type FetchTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
	readonly fetch?: FetchTransport;
}

// Resolve the host capability only when a subscription actually executes a request.
const defaultFetch: FetchTransport = (input, init) => globalThis.fetch(input, init);

type HasParams<TRoute extends AnyRoute> =
	keyof RouteParams<TRoute['path']> extends never ? false : true;
type HasQuery<TRoute extends AnyRoute> =
	RouteQuery<TRoute> extends undefined ? false : true;

export type ClientMethod<TRoute extends AnyRoute> =
	RouteBody<TRoute> extends undefined
		? HasParams<TRoute> extends true
			? HasQuery<TRoute> extends true
				? (params: RouteParams<TRoute['path']>, query: RouteQuery<TRoute>) => Observable<RouteResponse<TRoute>>
				: (params: RouteParams<TRoute['path']>) => Observable<RouteResponse<TRoute>>
			: HasQuery<TRoute> extends true
				? (query: RouteQuery<TRoute>) => Observable<RouteResponse<TRoute>>
				: () => Observable<RouteResponse<TRoute>>
		: HasParams<TRoute> extends true
			? HasQuery<TRoute> extends true
				? (params: RouteParams<TRoute['path']>, query: RouteQuery<TRoute>, body: RouteBody<TRoute>) => Observable<RouteResponse<TRoute>>
				: (params: RouteParams<TRoute['path']>, body: RouteBody<TRoute>) => Observable<RouteResponse<TRoute>>
			: HasQuery<TRoute> extends true
				? (query: RouteQuery<TRoute>, body: RouteBody<TRoute>) => Observable<RouteResponse<TRoute>>
				: (body: RouteBody<TRoute>) => Observable<RouteResponse<TRoute>>;

export type ClientFor<TContract> =
	TContract extends AnyRoute
		? ClientMethod<TContract>
		: { [Key in keyof TContract]: ClientFor<TContract[Key]> };

export const request$ = <TRoute extends AnyRoute>(
	route: TRoute,
	params: RouteParams<TRoute['path']>,
	query: RouteQuery<TRoute>,
	...bodyArg: RouteBody<TRoute> extends undefined ? [] : [RouteBody<TRoute>]
): Observable<RouteResponse<TRoute>> =>
	requestCore$(route, params as Record<string, string>, query as Record<string, string | undefined> | undefined, bodyArg[0]) as Observable<RouteResponse<TRoute>>;

const parseErrorBody = (text: string): unknown => {
	try { return JSON.parse(text); } catch { return text; }
};

const httpFailure = (status: number, text: string): RequestFailure => {
	const body = parseErrorBody(text);
	const structured = typeof body === 'object' && body !== null ? body : undefined;
	const message = structured && 'error' in structured && typeof structured.error === 'string'
		? structured.error : `HTTP ${status}`;
	return createRequestFailure({
		kind: 'http', status, message, body,
		...(structured && 'details' in structured ? { details: structured.details } : {}),
	});
};

const decodeSuccess = (
	contract: Exclude<ResponseBody<unknown>, { kind: 'stream' }>,
	status: number,
	text: string,
): unknown => {
	if (contract.kind === 'empty') {
		if (status !== contract.status || text !== '') {
			throw createRequestFailure({ kind: 'decode', status, message: `Expected an empty ${contract.status} response.` });
		}
		return undefined;
	}
	let decoded: unknown;
	try { decoded = JSON.parse(text); } catch (cause) {
		throw createRequestFailure({ kind: 'decode', status, message: 'Expected a valid JSON response body.', cause });
	}
	const validated = contract.schema.safeParse(decoded);
	if (!validated.success) {
		throw createRequestFailure({ kind: 'decode', status, message: 'The response body does not match the route schema.', details: validated.error.issues });
	}
	return validated.data;
};

/** Own both fetch and its response body for exactly one Observable subscription. */
const requestCore$ = (
	route: AnyRoute,
	params: Record<string, string>,
	query?: Record<string, string | undefined>,
	body?: unknown,
	options: ClientOptions = {},
): Observable<unknown> => new Observable(subscriber => {
	const controller = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let settled = false;
	let status: number | undefined;

	const readBody = async (response: Response): Promise<string> => {
		if (!response.body) return '';
		const ownedReader = response.body.getReader();
		reader = ownedReader;
		const decoder = new TextDecoder();
		let text = '';
		try {
			while (!subscriber.closed) {
				const chunk = await ownedReader.read();
				if (chunk.done) return text + decoder.decode();
				text += decoder.decode(chunk.value, { stream: true });
			}
			return '';
		} finally {
			ownedReader.releaseLock();
			if (reader === ownedReader) reader = undefined;
		}
	};

	const execute = async (): Promise<unknown> => {
		if (route.responseBody.kind === 'stream') {
			throw createRequestFailure({ kind: 'unsupported-response', message: 'A streaming route requires a stream transport; the finite JSON client cannot consume it.' });
		}
		const init: RequestInit = { method: route.method, signal: controller.signal };
		if (body !== undefined) {
			init.headers = { 'Content-Type': 'application/json' };
			init.body = JSON.stringify(body);
		}
		const response = await (options.fetch ?? defaultFetch)(apiPath(route.path, params, query), init);
		status = response.status;
		if (subscriber.closed) {
			// An injected transport may ignore abort and still deliver headers later.
			await response.body?.cancel();
			return;
		}
		if (status < 200 || status >= 300) {
			let text: string;
			try { text = await readBody(response); } catch (cause) {
				throw createRequestFailure({ kind: 'http', status, message: `HTTP ${status}`, cause });
			}
			throw httpFailure(status, text);
		}
		const text = await readBody(response);
		return subscriber.closed ? undefined : decodeSuccess(route.responseBody, status, text);
	};

	void execute().then(
		value => {
			if (subscriber.closed) return;
			settled = true;
			subscriber.next(value);
			subscriber.complete();
		},
		cause => {
			if (subscriber.closed) return;
			settled = true;
			subscriber.error(isRequestFailure(cause) ? cause : createRequestFailure({
				kind: 'network', message: cause instanceof Error ? cause.message : 'Request transport failed.',
				...(status === undefined ? {} : { status }), cause,
			}));
		},
	);

	return () => {
		if (settled) return;
		controller.abort();
		// Aborting fetch alone is insufficient for custom transports that own a stream.
		void reader?.cancel().catch(() => { /* The closed owner cannot deliver cancellation failures. */ });
	};
});

export const createClient = <TContract>(contract: TContract, options: ClientOptions = {}): ClientFor<TContract> => {
	const build = (node: unknown): unknown => {
		if (isRoute(node)) {
			return (...args: unknown[]) => {
				const hasParams = /:[A-Za-z0-9_]+/.test(node.path);
				const hasQuery = node.query !== undefined;
				const params = hasParams ? args[0] as Record<string, string> : {};
				const query = hasQuery ? args[hasParams ? 1 : 0] as Record<string, string | undefined> : undefined;
				const body = args[hasParams ? (hasQuery ? 2 : 1) : (hasQuery ? 1 : 0)];
				return requestCore$(node, params, query, body, options);
			};
		}

		return Object.fromEntries(
			Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, build(value)]),
		);
	};

	return build(contract) as ClientFor<TContract>;
};

const isRoute = (value: unknown): value is AnyRoute =>
	typeof value === 'object'
	&& value !== null
	&& 'method' in value
	&& 'path' in value;
