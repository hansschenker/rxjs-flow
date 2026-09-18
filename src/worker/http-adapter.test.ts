import { exports } from 'cloudflare:workers';
import { EMPTY, NEVER, Observable, Subject, finalize, firstValueFrom, map, mergeMap, of, tap } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../server/core/body';
import { cors, requestId, requireAuth } from '../server/core/middleware';
import { get, group, post } from '../server/core/router';
import { created, json, noContent, redirect, stream$, withCookie } from '../server/core/response';
import type { Effect, HttpRequest, HttpResponse } from '../server/core/types';
import { createTodoStore } from '../server/todos/todo.store-factory';
import type { Todo } from '../shared/types';
import { createHonoApp, readRequestBody$ } from './http-adapter';
import { createWorkerApp } from './index';

function request(path: string, init?: RequestInit): Request {
	return new Request(`https://example.test${path}`, init);
}

function jsonRequest(path: string, body: unknown, method = 'POST'): Request {
	return request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function createApp(effect: Effect, deadlineMs?: number) {
	return createHonoApp([get('/test', effect)], { includeHealthRoutes: false, deadlineMs });
}

describe('Hono finite HTTP compatibility in workerd', () => {
	it('constructs the graph without executing domain work', () => {
		const effect = vi.fn(() => of(json('ok')));
		createApp(effect);
		expect(effect).not.toHaveBeenCalled();
	});

	it('maps nested definitions, decoded parameters, last query value, headers and middleware order', async () => {
		const order: string[] = [];
		const remember = (name: string) => tap<HttpRequest>(() => order.push(name));
		const effect: Effect = input$ => input$.pipe(map(input => json({
			params: input.params, query: input.query, header: input.headers['x-check'],
			url: input.url, id: input.requestContext.requestId, hasRaw: 'raw' in input,
			hasSignal: input.signal instanceof AbortSignal,
		})));
		const app = createHonoApp([group('/items', [get('/:id', effect, remember('route'))], remember('group'))], {
			middlewares: [requestId(), remember('application')],
		});
		const response = await app.fetch(request('/api//items/a%2Fb/?filter=first&filter=last', { headers: { 'x-check': 'yes' } }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			params: { id: 'a/b' }, query: { filter: 'last' }, header: 'yes',
			url: '/items/a%2Fb', id: expect.any(String), hasRaw: false, hasSignal: true,
		});
		expect(order).toEqual(['application', 'group', 'route']);
	});

	it('retains health/ready routes and JSON not-found without an asset fallback', async () => {
		const app = createHonoApp([]);
		for (const [path, status] of [['/api/health', 'ok'], ['/api/ready', 'ready']] as const) {
			expect(await (await app.fetch(request(path))).json()).toEqual({ status });
		}
		for (const path of ['/api', '/api/unknown', '/health', '/api/api/health']) {
			const response = await app.fetch(request(path));
			expect(response.status).toBe(404);
			expect(response.headers.get('content-type')).toContain('application/json');
		}
	});

	it('does not execute GET effects for an unregistered HEAD method', async () => {
		const effect = vi.fn(() => of(json('ok')));
		expect((await createApp(effect).fetch(request('/api/test', { method: 'HEAD' }))).status).toBe(404);
		expect(effect).not.toHaveBeenCalled();
	});

	it('preserves status, custom headers, cookies and redirects', async () => {
		const response = await createApp(() => of(withCookie(created({ ok: true }, { 'x-result': 'created' }), 'demo', 'yes', { HttpOnly: true })))
			.fetch(request('/api/test'));
		expect(response.status).toBe(201);
		expect(response.headers.get('x-result')).toBe('created');
		expect(response.headers.get('set-cookie')).toContain('demo=yes; HttpOnly');
		const redirected = await createApp(() => of(redirect('/elsewhere'))).fetch(request('/api/test'));
		expect(redirected.status).toBe(302);
		expect(redirected.headers.get('location')).toBe('/elsewhere');
		expect(await redirected.text()).toBe('');
	});

	it('emits a genuinely empty 204 response', async () => {
		const response = await createApp(() => of(noContent())).fetch(request('/api/test'));
		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
		expect(await response.text()).toBe('');
	});

	it('preserves CORS preflight and auth on canonical and normalized paths', async () => {
		const effect = vi.fn(() => of(json({ allowed: true })));
		const verify = vi.fn((token: string) => {
			if (token !== 'valid') throw new Error('invalid token');
			return { subject: 'user' };
		});
		const app = createHonoApp([get('/private', effect)], {
			auth: requireAuth(verify), cors: cors({ origins: ['https://allowed.test'] }),
		});
		const preflight = await app.fetch(request('/api/private', { method: 'OPTIONS', headers: { origin: 'https://allowed.test' } }));
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-origin')).toBe('https://allowed.test');
		expect(effect).not.toHaveBeenCalled();
		for (const path of ['/api/private', '/api//private/', '/private', '/api/api/private', '/api/private/extra']) {
			const response = await app.fetch(request(path));
			expect(response.status).toBe(401);
			expect(response.headers.get('content-type')).toContain('application/json');
		}
		expect(effect).not.toHaveBeenCalled();
		expect((await app.fetch(request('/api/private', { headers: { authorization: 'Bearer invalid' } }))).status).toBe(401);
		const success = await app.fetch(request('/api/private', { headers: { authorization: 'Bearer valid', origin: 'https://allowed.test' } }));
		expect(success.status).toBe(200);
		expect(success.headers.get('access-control-allow-origin')).toBe('https://allowed.test');
		expect(effect).toHaveBeenCalledTimes(1);
		expect((await app.fetch(request('/api/health'))).status).toBe(200);
	});

	it('rejects malformed path encoding without poisoning the next request', async () => {
		const effect = vi.fn(() => of(json('ok')));
		const app = createHonoApp([get('/items/:id', effect)]);
		expect((await app.fetch(request('/api/items/%E0%A4%A'))).status).toBe(400);
		expect((await app.fetch(request('/api/items/good'))).status).toBe(200);
		expect(effect).toHaveBeenCalledTimes(1);
	});

	it('contains a matching failure and allows a subsequent request', async () => {
		const app = createApp(() => of(json('ok')));
		const match = app.router.match.bind(app.router);
		vi.spyOn(app.router, 'match').mockImplementationOnce(() => { throw new Error('match fault'); }).mockImplementation(match);
		expect((await app.fetch(request('/api/test'))).status).toBe(500);
		expect((await app.fetch(request('/api/test'))).status).toBe(200);
	});

	it('contains synchronous effect and middleware construction failures', async () => {
		let calls = 0;
		const effect: Effect = () => {
			if (++calls === 1) throw new Error('private detail');
			return of(json('ok'));
		};
		const app = createApp(effect);
		const failed = await app.fetch(request('/api/test'));
		expect(failed.status).toBe(500);
		expect(await failed.text()).not.toContain('private detail');
		expect((await app.fetch(request('/api/test'))).status).toBe(200);
		const middlewareApp = createHonoApp([get('/test', effect)], {
			middlewares: [() => { throw new Error('middleware setup'); }],
		});
		expect((await middlewareApp.fetch(request('/api/test'))).status).toBe(500);
	});

	it.each([
		['empty', () => EMPTY, 500],
		['multiple', () => of(json('first'), json('second')), 500],
		['never', () => NEVER, 504],
		['one then never', () => new Observable<HttpResponse>(subscriber => subscriber.next(json('first'))), 504],
	] as const)('settles %s handlers as a defined failure', async (_label, effect, status) => {
		const cleanup = vi.fn();
		const response = await createApp(() => effect().pipe(finalize(cleanup)), 10).fetch(request('/api/test'));
		expect(response.status).toBe(status);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('contains invalid response serialization, status and headers', async () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		for (const descriptor of [json(circular), json(1n), json('ok', 42), json('ok', 200, { 'bad\nheader': 'value' })]) {
			const response = await createApp(() => of(descriptor)).fetch(request('/api/test'));
			expect(response.status).toBe(500);
			expect(response.headers.get('content-type')).toContain('application/json');
		}
	});

	it('does not start an SSE body when the finite descriptor reaches the adapter', async () => {
		const subscribe = vi.fn();
		const source$ = new Observable(subscribe);
		const response = await createApp(() => of(stream$(source$))).fetch(request('/api/test'));
		expect(response.status).toBe(501);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it('extra response consumers do not repeat domain work', async () => {
		const effect = vi.fn(() => of(json({ ok: true })));
		const response = await createApp(effect).fetch(request('/api/test'));
		const copy = response.clone();
		expect(await response.json()).toEqual({ ok: true });
		expect(await copy.json()).toEqual({ ok: true });
		expect(effect).toHaveBeenCalledTimes(1);
	});
});

describe('Fetch request body ownership in workerd', () => {
	it('rejects malformed JSON then accepts a valid body on the same app', async () => {
		const effect = vi.fn((input$: Observable<HttpRequest>) => input$.pipe(map(input => json(input.body))));
		const app = createHonoApp([post('/test', effect)]);
		expect((await app.fetch(request('/api/test', { method: 'POST', body: '{' }))).status).toBe(400);
		expect(await (await app.fetch(jsonRequest('/api/test', { ok: true }))).json()).toEqual({ ok: true });
		expect(effect).toHaveBeenCalledTimes(1);
	});

	it('bounds declared size and actual streamed bytes', async () => {
		const effect = vi.fn(() => of(json('ok')));
		const app = createHonoApp([post('/test', effect)]);
		const declared = await app.fetch(request('/api/test', {
			method: 'POST', body: '{}', headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
		}));
		expect(declared.status).toBe(413);
		const cancel = vi.fn();
		const bytes = new Uint8Array(MAX_BODY_BYTES / 2 + 1).fill(32);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) { controller.enqueue(bytes); pulls++; }, cancel,
		}, { highWaterMark: 0 });
		expect((await app.fetch(request('/api/test', { method: 'POST', body }))).status).toBe(413);
		expect(pulls).toBe(2);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(effect).not.toHaveBeenCalled();
	});

	it('decodes UTF-8 split between chunks and rejects invalid UTF-8', async () => {
		const encoded = new TextEncoder().encode('{"title":"☕"}');
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
			controller.close();
		} });
		expect(await firstValueFrom(readRequestBody$(request('/api/test', { method: 'POST', body }), new AbortController().signal)))
			.toEqual({ title: '☕' });
		const app = createHonoApp([post('/test', () => of(json('ok')))]);
		expect((await app.fetch(request('/api/test', { method: 'POST', body: new Uint8Array([0xff]) }))).status).toBe(400);
	});

	it('cancels a pending body reader before effects start and releases its lock', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const controller = new AbortController();
		const effect = vi.fn(() => of(json('ok')));
		const app = createHonoApp([post('/test', effect)]);
		const response = app.fetch(request('/api/test', { method: 'POST', body, signal: controller.signal }));
		expect(body.locked).toBe(true);
		controller.abort();
		expect((await response).status).toBe(499);
		await Promise.resolve();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
		expect(effect).not.toHaveBeenCalled();
	});

	it('the request deadline also cancels a slow body reader', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const effect = vi.fn(() => of(json('ok')));
		const app = createHonoApp([post('/test', effect)], { deadlineMs: 10 });
		expect((await app.fetch(request('/api/test', { method: 'POST', body }))).status).toBe(504);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(effect).not.toHaveBeenCalled();
	});

	it('does not activate work for an already-aborted request', async () => {
		const controller = new AbortController();
		controller.abort();
		const effect = vi.fn(() => of(json('ok')));
		expect((await createApp(effect).fetch(request('/api/test', { signal: controller.signal }))).status).toBe(499);
		expect(effect).not.toHaveBeenCalled();
	});

	it.each(['already aborted', 'malformed path', 'matching failure'] as const)(
		'cancels the unread body on %s before a reader was acquired', async failure => {
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({ cancel });
			const controller = new AbortController();
			if (failure === 'already aborted') controller.abort();
			const effect = vi.fn(() => of(json('ok')));
			const app = createHonoApp([post('/test/:id', effect)]);
			if (failure === 'matching failure') vi.spyOn(app.router, 'match').mockImplementationOnce(() => { throw new Error('match'); });
			const path = failure === 'malformed path' ? '/api/test/%EA' : '/api/test/id';
			const response = await app.fetch(request(path, { method: 'POST', body, signal: controller.signal }));
			expect(response.status).toBe(failure === 'already aborted' ? 499 : failure === 'malformed path' ? 400 : 500);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
			expect(effect).not.toHaveBeenCalled();
		},
	);

	it('isolates simultaneous contexts and cancelling A leaves B active', async () => {
		const contexts: HttpRequest[] = [];
		const first = new Subject<HttpResponse>();
		const second = new Subject<HttpResponse>();
		const cleanFirst = vi.fn();
		const cleanSecond = vi.fn();
		let bothStarted!: () => void;
		const started = new Promise<void>(resolve => { bothStarted = resolve; });
		const effect: Effect = input$ => input$.pipe(mergeMap(input => {
			contexts.push(input);
			input.requestContext.state.owner = contexts.length;
			if (contexts.length === 2) bothStarted();
			return contexts.length === 1 ? first.pipe(finalize(cleanFirst)) : second.pipe(finalize(cleanSecond));
		}));
		const app = createApp(effect);
		const controller = new AbortController();
		const a = app.fetch(request('/api/test', { signal: controller.signal }));
		const b = app.fetch(request('/api/test'));
		await started;
		expect(contexts[0].requestContext).not.toBe(contexts[1].requestContext);
		expect(contexts[0].requestContext.state.owner).toBe(1);
		expect(contexts[1].requestContext.state.owner).toBe(2);
		expect(contexts[0].context).toBe(contexts[1].context);
		expect(contexts[0].signal).not.toBe(contexts[1].signal);
		controller.abort();
		expect((await a).status).toBe(499);
		expect(cleanFirst).toHaveBeenCalledTimes(1);
		expect(cleanSecond).not.toHaveBeenCalled();
		expect(second.observed).toBe(true);
		second.next(json('B'));
		second.complete();
		expect(await (await b).json()).toBe('B');
		expect(cleanSecond).toHaveBeenCalledTimes(1);
	});
});

describe('Todo Worker migration in workerd', () => {
	it('keeps all production Todo access disabled and authorized SSE explicitly pending', async () => {
		const response = await exports.default.fetch('https://example.test/api/todos');
		expect(response.status).toBe(503);
		expect((await exports.default.fetch('https://example.test/api/todos/stream')).status).toBe(503);
		const authorized = createWorkerApp({ todoStore: createTodoStore() });
		expect((await authorized.fetch(request('/api/todos/stream'))).status).toBe(501);
	});

	it('reuses the canonical CRUD contracts with an injected local store', async () => {
		const store = createTodoStore();
		const app = createWorkerApp({ todoStore: store });
		const initial = await (await app.fetch(request('/api/todos'))).json() as unknown[];
		expect(initial).toHaveLength(1);
		const created = await app.fetch(jsonRequest('/api/todos', { title: 'Worker Todo' }));
		expect(created.status).toBe(201);
		const todo = await created.json() as { id: string; title: string; completed: boolean; createdAt: string };
		expect(todo).toMatchObject({ title: 'Worker Todo', completed: false, id: expect.any(String), createdAt: expect.any(String) });
		const updated = await app.fetch(jsonRequest(`/api/todos/${todo.id}`, { completed: true }, 'PUT'));
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({ id: todo.id, completed: true });
		expect(await (await app.fetch(request('/api/todos?completed=true'))).json()).toEqual([expect.objectContaining({ id: todo.id })]);
		const removed = await app.fetch(request(`/api/todos/${todo.id}`, { method: 'DELETE' }));
		expect(removed.status).toBe(204);
		expect(await removed.text()).toBe('');
		expect(store.getTodos()).toHaveLength(1);
	});

	it('retains body/query validation, 404 mutation failures, and recovery', async () => {
		const app = createWorkerApp({ todoStore: createTodoStore() });
		const invalid = await app.fetch(jsonRequest('/api/todos', { title: '' }));
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({ error: 'Validation failed', details: { target: 'body', issues: expect.any(Array) } });
		expect((await app.fetch(request('/api/todos?completed=maybe'))).status).toBe(422);
		expect((await app.fetch(request('/api/todos/missing', { method: 'DELETE' }))).status).toBe(404);
		expect((await app.fetch(jsonRequest('/api/todos/missing', { completed: true }, 'PUT'))).status).toBe(404);
		expect((await app.fetch(jsonRequest('/api/todos', { title: 'Valid after failure' }))).status).toBe(201);
	});

	it('never subscribes to the store live stream during M05b', async () => {
		const subscribe = vi.fn();
		const store = { ...createTodoStore(), todos$: new Observable<Todo[]>(subscribe) };
		const response = await createWorkerApp({ todoStore: store }).fetch(request('/api/todos/stream'));
		expect(response.status).toBe(501);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it('keeps separately injected test stores isolated', async () => {
		const first = createWorkerApp({ todoStore: createTodoStore() });
		const second = createWorkerApp({ todoStore: createTodoStore() });
		await first.fetch(jsonRequest('/api/todos', { title: 'only first' }));
		expect(await (await first.fetch(request('/api/todos'))).json()).toHaveLength(2);
		expect(await (await second.fetch(request('/api/todos'))).json()).toHaveLength(1);
	});
});
