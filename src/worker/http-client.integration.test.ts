import { Hono } from 'hono';
import { Observable, firstValueFrom, mergeMap, of, type Subscriber } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { createClient, type FetchTransport } from '../client/api';
import { handle } from '../server/core/router';
import type { Effect, HttpRequest, HttpResponse } from '../server/core/types';
import { createTodoRoutes } from '../server/todos/todo.routes';
import { createTodoStore } from '../server/todos/todo.store-factory';
import { routes } from '../shared/routes';
import type { Todo } from '../shared/types';
import { createHonoApp } from './http-adapter';

const todo: Todo = {
	id: 'fixture-id', title: 'Worker client fixture', completed: false,
	createdAt: '2026-09-18T00:00:00.000Z',
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(fulfill => { resolve = fulfill; });
	return { promise, resolve };
}

/** Runs Hono and Web Request/Response in workerd; no network-fetch mock. */
function transportFor(app: { fetch: (request: Request) => Response | Promise<Response> }): FetchTransport {
	return async function dispatch(input, init) {
		const path = input instanceof Request ? input.url : String(input);
		return app.fetch(new Request(new URL(path, 'https://m05b.test'), init));
	};
}

describe('M03 client against the M05b Hono adapter in workerd', () => {
	it('uses the authoritative Todo route list for CRUD and expected empty DELETE success', async () => {
		const store = createTodoStore();
		const app = createHonoApp(createTodoRoutes(), { services: { todoStore: store } });
		const client = createClient(routes, { fetch: transportFor(app) });
		const before = await firstValueFrom(client.todos.list({}));
		const created = await firstValueFrom(client.todos.create({ title: 'Created through Hono' }));
		expect(created).toMatchObject({ title: 'Created through Hono', completed: false });
		expect(created.id).toEqual(expect.any(String));
		expect(await firstValueFrom(client.todos.update({ id: created.id }, { completed: true })))
			.toEqual({ ...created, completed: true });
		expect(await firstValueFrom(client.todos.list({ completed: 'true' })))
			.toEqual([{ ...created, completed: true }]);
		await expect(firstValueFrom(client.todos.remove({ id: created.id }))).resolves.toBeUndefined();
		expect(await firstValueFrom(client.todos.list({}))).toEqual(before);
		await expect(firstValueFrom(client.todos.remove({ id: created.id }))).rejects.toMatchObject({
			kind: 'http', status: 404, message: 'Todo not found',
		});
	});

	it('preserves real validation details and continues after malformed request JSON', async () => {
		const app = createHonoApp(createTodoRoutes(), { services: { todoStore: createTodoStore() } });
		const fetch = transportFor(app);
		const client = createClient(routes, { fetch });
		await expect(firstValueFrom(client.todos.create({ title: '' }))).rejects.toMatchObject({
			kind: 'http', status: 422, message: 'Validation failed',
			details: { target: 'body', issues: expect.any(Array) },
		});
		const malformed: FetchTransport = (input, init) => fetch(input, { ...init, body: '{"title":' });
		await expect(firstValueFrom(createClient(routes, { fetch: malformed }).todos.create({ title: 'x' })))
			.rejects.toMatchObject({ kind: 'http', status: 400, message: 'Malformed JSON' });
		await expect(firstValueFrom(client.todos.create({ title: 'Valid next request' })))
			.resolves.toMatchObject({ title: 'Valid next request' });
	});

	it.each([200, 201, 202, 206, 299])('decodes valid JSON status %i produced by a finite Hono effect', async status => {
		const app = createHonoApp([handle(routes.todos.list, () => of({ status, body: [todo] }))]);
		await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.list({})))
			.resolves.toEqual([todo]);
	});

	it.each([300, 301, 400, 401, 404, 409, 422, 500, 503, 599])(
		'rejects non-2xx %i emitted by Hono and preserves its structured error', async status => {
			const details = { fields: [{ path: 'title', message: 'Required' }] };
			const app = createHonoApp([handle(routes.todos.list, () => of({
				status, body: { error: 'Cannot save', details },
			}))]);
			await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.list({})))
				.rejects.toMatchObject({ kind: 'http', status, message: 'Cannot save', details });
		},
	);

	it.each([404, 500])('does not turn failed DELETE %i into success at the Hono boundary', async status => {
		const app = createHonoApp([handle(routes.todos.remove, () => of({
			status, body: { error: 'Delete failed' },
		}))]);
		await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.remove({ id: 'x' })))
			.rejects.toMatchObject({ kind: 'http', status, message: 'Delete failed' });
	});

	it('rejects an unexpected 204 for the JSON list contract', async () => {
		const app = createHonoApp([handle(routes.todos.list, () => of({ status: 204 }))]);
		await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.list({})))
			.rejects.toMatchObject({ kind: 'decode', status: 204 });
	});

	it('requires the declared 204 for the empty DELETE contract', async () => {
		const app = createHonoApp([handle(routes.todos.remove, () => of({ status: 200, body: { ignored: true } }))]);
		await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.remove({ id: 'x' })))
			.rejects.toMatchObject({ kind: 'decode', status: 200 });
	});

	it('retains schema failure details for invalid Todo content produced by an effect', async () => {
		const app = createHonoApp([handle(routes.todos.create, () => of({
			status: 201, body: { ...todo, completed: 'false' },
		}))]);
		await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.create({ title: 'x' })))
			.rejects.toMatchObject({ kind: 'decode', status: 201, details: expect.any(Array) });
	});

	it('cancels the Hono request operation before headers and suppresses its later outcome', async () => {
		const entered = deferred<HttpRequest>();
		const cleaned = vi.fn();
		let active: Subscriber<HttpResponse> | undefined;
		const pending: Effect = requests => requests.pipe(mergeMap(request => new Observable<HttpResponse>(subscriber => {
			active = subscriber;
			entered.resolve(request);
			return cleaned;
		})));
		const app = createHonoApp([handle(routes.todos.list, pending)]);
		const next = vi.fn();
		const error = vi.fn();
		const complete = vi.fn();
		const subscription = createClient(routes, { fetch: transportFor(app) }).todos.list({})
			.subscribe({ next, error, complete });
		const request = await entered.promise;
		expect(request.signal.aborted).toBe(false);
		subscription.unsubscribe();
		expect(request.signal.aborted).toBe(true);
		expect(cleaned).toHaveBeenCalledTimes(1);
		expect(active?.closed).toBe(true);
		active?.next({ body: [todo] });
		active?.complete();
		await Promise.resolve();
		expect(next).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it('keeps two cold HTTP subscriptions independent when the first is cancelled', async () => {
		const entered = deferred<void>();
		const operations: Array<{ request: HttpRequest; subscriber: Subscriber<HttpResponse>; cleanup: ReturnType<typeof vi.fn> }> = [];
		const pending: Effect = requests => requests.pipe(mergeMap(request => new Observable<HttpResponse>(subscriber => {
			const cleanup = vi.fn();
			operations.push({ request, subscriber, cleanup });
			if (operations.length === 2) entered.resolve();
			return cleanup;
		})));
		const app = createHonoApp([handle(routes.todos.list, pending)]);
		const request$ = createClient(routes, { fetch: transportFor(app) }).todos.list({});
		expect(operations).toHaveLength(0);
		const firstNext = vi.fn();
		const first = request$.subscribe(firstNext);
		const second = firstValueFrom(request$);
		await entered.promise;
		first.unsubscribe();
		expect(operations).toHaveLength(2);
		expect(operations[0].request.signal.aborted).toBe(true);
		expect(operations[0].cleanup).toHaveBeenCalledTimes(1);
		expect(operations[1].request.signal.aborted).toBe(false);
		expect(operations[1].cleanup).not.toHaveBeenCalled();
		operations[1].subscriber.next({ body: [todo] });
		operations[1].subscriber.complete();
		await expect(second).resolves.toEqual([todo]);
		expect(operations[1].cleanup).toHaveBeenCalledTimes(1);
		expect(firstNext).not.toHaveBeenCalled();
	});
});

describe('M03 client with fault-injecting raw Hono response fixtures in workerd', () => {
	// These explicit fixtures bypass finiteResponse to supply broken wire data or
	// a delayed JSON body. They verify the client boundary, not M05d SSE delivery.
	it.each(['', '{', 'null', '{}', '[{}]', '[{"id":"1","title":"x","completed":"false","createdAt":"now"}]'])(
		'rejects malformed or schema-invalid successful body %j', async body => {
			const app = new Hono();
			app.get('/api/todos', () => new Response(body));
			await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.list({})))
				.rejects.toMatchObject({ kind: 'decode', status: 200 });
		},
	);

	it.each(['', 'not JSON', '{', 'null', '{"error":42}'])(
		'retains HTTP status for unusable error body %j', async body => {
			const app = new Hono();
			app.get('/api/todos', () => new Response(body, { status: 500 }));
			await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.list({})))
				.rejects.toMatchObject({ kind: 'http', status: 500 });
		},
	);

	it('cancels an actual response reader during delayed JSON consumption', async () => {
		const reading = deferred<void>();
		const cancelled = deferred<void>();
		const cleanup = vi.fn(() => cancelled.resolve());
		let body!: ReadableStream<Uint8Array>;
		let signal!: AbortSignal;
		const app = new Hono();
		app.get('/api/todos', context => {
			signal = context.req.raw.signal;
			body = new ReadableStream<Uint8Array>({
				start(controller) { controller.enqueue(new TextEncoder().encode('[')); },
				pull() { if (body.locked) reading.resolve(); },
				cancel: cleanup,
			});
			return new Response(body, { headers: { 'Content-Type': 'application/json' } });
		});
		const next = vi.fn();
		const error = vi.fn();
		const complete = vi.fn();
		const subscription = createClient(routes, { fetch: transportFor(app) }).todos.list({})
			.subscribe({ next, error, complete });
		await reading.promise;
		expect(body.locked).toBe(true);
		subscription.unsubscribe();
		await cancelled.promise;
		await Promise.resolve();
		expect(signal.aborted).toBe(true);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
		expect(next).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it.each([200, 503])('retains status %i when its response body fails during reading', async status => {
		const app = new Hono();
		app.get('/api/todos', () => new Response(new ReadableStream<Uint8Array>({
			start(controller) { controller.error(new Error('body disconnected')); },
		}), { status }));
		await expect(firstValueFrom(createClient(routes, { fetch: transportFor(app) }).todos.list({})))
			.rejects.toMatchObject({ kind: status === 200 ? 'network' : 'http', status });
	});
});
