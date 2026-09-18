import { Hono, type Context } from 'hono';
import { Observable, defer, firstValueFrom, map, mergeMap, of, type SchedulerLike } from 'rxjs';
import { MAX_BODY_BYTES, parseJsonBody } from '../server/core/body';
import { BadRequest, HttpError, NotFound } from '../server/core/errors';
import { createRequestOperation, type RequestOutcome } from '../server/core/request-operation';
import { applyRoute, flattenRoutes, get, type Route, type RouteDefinition } from '../server/core/router';
import { json } from '../server/core/response';
import type { AppContext, Effect, HttpRequest, HttpResponse, Middleware } from '../server/core/types';

export interface HonoAppOptions {
	services?: Record<string, unknown>;
	middlewares?: Middleware[];
	auth?: (effect: Effect) => Effect;
	cors?: (effect: Effect) => Effect;
	includeHealthRoutes?: boolean;
	deadlineMs?: number;
	scheduler?: SchedulerLike;
}

/** Keep the baseline's slash normalization; only this adapter owns /api. */
function normalizedPath(request: Request): string {
	return `/${new URL(request.url).pathname.split('/').filter(Boolean).join('/')}`;
}

/** Bytes are bounded while reading, including requests without Content-Length. */
export function readRequestBody$(request: Request, signal: AbortSignal): Observable<unknown> {
	return new Observable(subscriber => {
		if (signal.aborted) {
			subscriber.error(new HttpError(499, 'Request canceled'));
			return;
		}
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let finished = false;
		let cancelling = false;
		function cancelReader(): void {
			if (!reader || cancelling || finished) return;
			cancelling = true;
			void reader.cancel().catch(() => { /* The request owner reports the terminal outcome. */ });
		}
		function onAbort(): void {
			cancelReader();
			subscriber.error(new HttpError(499, 'Request canceled'));
		}
		async function read(): Promise<unknown> {
			if (signal.aborted) return undefined;
			if (request.body) reader = request.body.getReader();
			const declared = Number(request.headers.get('content-length'));
			if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
			if (!reader) return parseJsonBody('');
			const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
			let bytes = 0;
			let text = '';
			while (!subscriber.closed && !signal.aborted) {
				const chunk = await reader.read();
				if (subscriber.closed || signal.aborted) return undefined;
				if (chunk.done) {
					finished = true;
					try { text += decoder.decode(); } catch { throw new BadRequest('Malformed UTF-8 request body'); }
					return parseJsonBody(text);
				}
				bytes += chunk.value.byteLength;
				if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
				try { text += decoder.decode(chunk.value, { stream: true }); }
				catch { throw new BadRequest('Malformed UTF-8 request body'); }
			}
			return undefined;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		void read().then(value => {
			if (subscriber.closed || signal.aborted) return;
			subscriber.next(value);
			subscriber.complete();
		}, error => subscriber.error(error)).finally(() => {
			try { reader?.releaseLock(); } catch { /* Cancellation may still own a pending read. */ }
		});
		return () => {
			signal.removeEventListener('abort', onAbort);
			cancelReader();
		};
	});
}

/** Finite descriptor conversion belongs inside the operation's error boundary. */
export function finiteResponse(response: HttpResponse): Response {
	if (response.stream) throw new HttpError(501, 'Streaming responses are not supported by this adapter');
	const status = response.status ?? 200;
	const headers = new Headers(response.headers);
	if (!headers.has('content-type')) headers.set('content-type', 'application/json');
	if (response.body === undefined || status === 204 || status === 205 || status === 304) {
		return new Response(null, { status, headers });
	}
	const serialized = JSON.stringify(response.body);
	if (serialized === undefined) throw new Error('Response body cannot be represented as JSON');
	return new Response(serialized, { status, headers });
}

/** A failure before decoding still owns disposal of the unread incoming body. */
function cancelUnreadBody(request: Request): void {
	if (!request.body || request.body.locked) return;
	void request.body.cancel().catch(() => { /* Failure is already reported by its operation. */ });
}

function outcomeResponse(outcome: RequestOutcome<Response>, request: Request): Response {
	if (outcome.kind === 'success') return outcome.value;
	cancelUnreadBody(request);
	return Response.json(outcome.body, { status: outcome.status });
}

function healthy$(): ReturnType<Effect> { return of(json({ status: 'ok' })); }
function ready$(): ReturnType<Effect> { return of(json({ status: 'ready' })); }

/**
 * Hono matches the flattened, authoritative route definitions. Its Context never
 * crosses into an Effect; RxJS Middleware remains an OperatorFunction explicitly
 * applied to the request stream. A request owns one finite subscription.
 */
export function createHonoApp(definitions: RouteDefinition[], options: HonoAppOptions = {}) {
	const context: AppContext = { services: options.services ?? {}, state: {} };
	const definitionsWithHealth = options.includeHealthRoutes === false
		? definitions
		: [get('/health', healthy$), get('/ready', ready$), ...definitions];
	const routes = flattenRoutes(definitionsWithHealth);
	const app = new Hono({ getPath: normalizedPath });

	function respond(hono: Context, selected?: Route): Promise<Response> {
		const incoming = hono.req.raw;
		const operation = createRequestOperation<Response>({
			signal: incoming.signal,
			deadlineMs: options.deadlineMs,
			scheduler: options.scheduler,
			execute(signal) {
				return defer(() => {
					const path = normalizedPath(incoming);
					try { decodeURIComponent(path); } catch { throw new BadRequest('Malformed path encoding'); }
					const withinApi = path === '/api' || path.startsWith('/api/');
					const route = selected?.method === incoming.method ? selected : undefined;
					const request: HttpRequest = {
						method: incoming.method,
						url: withinApi ? path.slice(4) || '/' : path,
						params: route ? hono.req.param() : {},
						query: Object.fromEntries(new URL(incoming.url).searchParams),
						headers: Object.fromEntries(incoming.headers),
						body: undefined,
						signal,
						context,
						requestContext: { state: {} },
					};
					const matched: Effect = request$ => request$.pipe(mergeMap(value => {
						if (!route || !withinApi) throw new NotFound();
						return applyRoute(route, value, context);
					}));
					const authorized = options.auth ? options.auth(matched) : matched;
					const wrapped = options.cors ? options.cors(authorized) : authorized;
					return readRequestBody$(incoming, signal).pipe(
						mergeMap(body => {
							const input$ = (options.middlewares ?? []).reduce(
								(source$, middleware) => source$.pipe(middleware), of({ ...request, body }),
							);
							return wrapped(input$);
						}),
						map(finiteResponse),
					);
				});
			},
		});
		const result = firstValueFrom(operation.result$).then(outcome => outcomeResponse(outcome, incoming));
		operation.start();
		return result;
	}

	for (const route of routes) {
		app.on(route.method, `/api${route.path === '/' ? '' : route.path}`, hono => respond(hono, route));
	}
	app.all('*', hono => respond(hono));
	// Hono's matching/construction boundary must also return a finite JSON failure.
	app.onError((_error, hono) => {
		cancelUnreadBody(hono.req.raw);
		return Response.json({ error: 'Internal server error' }, { status: 500 });
	});
	const dispatch = app.fetch.bind(app);
	app.fetch = async (...args: Parameters<typeof dispatch>): Promise<Response> => {
		try { return await dispatch(...args); }
		catch {
			cancelUnreadBody(args[0]);
			return Response.json({ error: 'Internal server error' }, { status: 500 });
		}
	};
	return app;
}
