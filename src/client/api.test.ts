import { expectTypeOf, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { createClient, type FetchTransport } from './api';
import { defineRoute, routes, type AnyFiniteRoute } from '../shared/routes';
import type { CreateTodoBody, Todo, UpdateTodoBody } from '../shared/types';

const todo: Todo = { id: '1', title: 'Test', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };
const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};

const flushPromises = async () => {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

describe('createClient()', () => {
	it('derives callable client methods from the route tree', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse(todo, 201));
		const client = createClient(routes, { fetch });
		const result = await firstValueFrom(client.todos.create({ title: 'Test' }));
		expect(fetch).toHaveBeenCalledWith('/api/todos', expect.objectContaining({
			method: 'POST', body: JSON.stringify({ title: 'Test' }), signal: expect.any(AbortSignal),
		}));
		expect(result).toEqual(todo);
	});

	it('preserves method signatures from contracts', () => {
		const client = createClient(routes);
		expectTypeOf(client.todos.list).toEqualTypeOf<(query: { completed?: 'true' | 'false' }) => import('rxjs').Observable<Todo[]>>();
		expectTypeOf(client.todos.create).toEqualTypeOf<(body: CreateTodoBody) => import('rxjs').Observable<Todo>>();
		expectTypeOf(client.todos.update).toEqualTypeOf<(params: { id: string }, body: UpdateTodoBody) => import('rxjs').Observable<Todo>>();
		expectTypeOf(client.todos.remove).toEqualTypeOf<(params: { id: string }) => import('rxjs').Observable<void>>();
		expectTypeOf<keyof typeof client.todos>().toEqualTypeOf<'list' | 'create' | 'update' | 'remove'>();
		expect(client.todos).not.toHaveProperty('stream');
		expect(client.todos).not.toHaveProperty('live');
	});

	it('defers URL construction, body serialization and transport until each subscription', async () => {
		const fetch = vi.fn<FetchTransport>().mockImplementation(async () => jsonResponse(todo));
		const serialize = vi.fn(() => ({ title: 'Captured at subscribe' }));
		const client = createClient(routes, { fetch });
		const params = { id: 'first' };
		const request = client.todos.update(params, { title: 'Test', toJSON: serialize } as UpdateTodoBody);
		expect(fetch).not.toHaveBeenCalled();
		expect(serialize).not.toHaveBeenCalled();
		params.id = 'a/b';
		await firstValueFrom(request);
		await firstValueFrom(request);
		expect(serialize).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledWith('/api/todos/a%2Fb', expect.objectContaining({ body: '{"title":"Captured at subscribe"}' }));
		expect(fetch.mock.calls[0][1]?.signal).not.toBe(fetch.mock.calls[1][1]?.signal);
		expect(fetch.mock.calls.every(([, init]) => !init?.signal?.aborted)).toBe(true);
	});

	it.each([200, 201, 202, 206, 299])('accepts valid JSON throughout the 2xx range (%i)', async status => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse([todo], status));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).resolves.toEqual([todo]);
	});

	it.each([300, 301, 400, 401, 404, 409, 422, 500, 503, 599])('rejects non-2xx %i and preserves structured errors', async status => {
		const details = { fields: [{ path: 'title', message: 'Required' }] };
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse({ error: 'Cannot save', details }, status));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).rejects.toMatchObject({
			kind: 'http', status, message: 'Cannot save', details,
		});
	});

	it.each([404, 500])('does not turn failed DELETE %i into success', async status => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse({ error: 'Missing todo' }, status));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.remove({ id: '1' }))).rejects.toMatchObject({
			kind: 'http', status, message: 'Missing todo',
		});
	});

	it.each(['', 'not JSON', '{', 'null', '{"error":42}'])('retains HTTP failure for an unusable error body %j', async body => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(body, { status: 500 }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).rejects.toMatchObject({ kind: 'http', status: 500 });
	});

	it('accepts expected 204 empty success from the route contract', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(null, { status: 204 }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.remove({ id: '1' }))).resolves.toBeUndefined();
	});

	it('rejects unexpected empty status for a JSON response contract', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(null, { status: 204 }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).rejects.toMatchObject({ kind: 'decode', status: 204 });
	});

	it('requires the declared status for an empty response contract', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse({ ignored: true }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.remove({ id: '1' }))).rejects.toMatchObject({ kind: 'decode', status: 200 });
	});

	it('decodes a DELETE JSON response using its schema instead of its method', async () => {
		const contract = defineRoute<'DELETE', '/audit/:id', undefined, undefined, { removed: boolean }>(
			'DELETE', '/audit/:id', { kind: 'json', schema: z.object({ removed: z.boolean() }) },
		);
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse({ removed: true }));
		await expect(firstValueFrom(createClient({ remove: contract }, { fetch }).remove({ id: '1' }))).resolves.toEqual({ removed: true });
	});

	it.each(['', '{', 'null', '{}', '[{}]', '[{"id":"1","title":"x","completed":"false","createdAt":"now"}]'])('rejects malformed or invalid Todo JSON %j', async body => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(body));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).rejects.toMatchObject({ kind: 'decode', status: 200 });
	});

	it('validates individual Todo responses and retains validation details', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse({ ...todo, completed: 'false' }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.create({ title: 'Test' }))).rejects.toMatchObject({
			kind: 'decode', status: 200, details: expect.any(Array),
		});
	});

	it('contains untyped finite-client misuse of a streaming route without fetching', async () => {
		const fetch = vi.fn<FetchTransport>();
		// JavaScript/unsafe casts cannot bypass the runtime transport boundary.
		const unsafe = createClient(routes.todos.live as unknown as AnyFiniteRoute, { fetch });
		await expect(firstValueFrom(unsafe(undefined, undefined))).rejects.toMatchObject({
			kind: 'unsupported-response', message: expect.stringContaining('stream'),
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('normalizes transport rejection and synchronous transport throw', async () => {
		const cause = new TypeError('offline');
		const fetch = vi.fn<FetchTransport>()
			.mockRejectedValueOnce(cause)
			.mockImplementationOnce(() => { throw cause; });
		const client = createClient(routes, { fetch });
		for (let count = 0; count < 2; count++) {
			await expect(firstValueFrom(client.todos.list({}))).rejects.toMatchObject({ kind: 'network', message: 'offline', cause });
		}
	});

	it('delivers serialization failures through the observable error channel', async () => {
		const fetch = vi.fn<FetchTransport>();
		const body = { title: 'Test', toJSON() { throw new Error('Cannot encode'); } };
		const request = createClient(routes, { fetch }).todos.create(body);
		await expect(firstValueFrom(request)).rejects.toMatchObject({ message: 'Cannot encode' });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('request ownership', () => {
	it('aborts before headers and cancels a late response without delivery', async () => {
		const pending = deferred<Response>();
		const cancel = vi.fn();
		const fetch = vi.fn<FetchTransport>().mockReturnValue(pending.promise);
		const next = vi.fn();
		const error = vi.fn();
		const complete = vi.fn();
		const subscription = createClient(routes, { fetch }).todos.list({}).subscribe({ next, error, complete });
		const signal = fetch.mock.calls[0][1]?.signal;
		subscription.unsubscribe();
		expect(signal?.aborted).toBe(true);
		pending.resolve(new Response(new ReadableStream({ cancel })));
		await flushPromises();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(next).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it('cancels the actual readable stream while consuming a delayed body', async () => {
		const reading = deferred<void>();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new TextEncoder().encode('[')); },
			pull() { reading.resolve(); },
			cancel,
		});
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(stream));
		const next = vi.fn();
		const error = vi.fn();
		const complete = vi.fn();
		const subscription = createClient(routes, { fetch }).todos.list({}).subscribe({ next, error, complete });
		await reading.promise;
		await flushPromises();
		subscription.unsubscribe();
		await flushPromises();
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(stream.locked).toBe(false);
		expect(next).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it('keeps subscriptions independent when one is cancelled', async () => {
		const first = deferred<Response>();
		const second = deferred<Response>();
		const fetch = vi.fn<FetchTransport>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const request = createClient(routes, { fetch }).todos.list({});
		const subscription = request.subscribe();
		const result = firstValueFrom(request);
		subscription.unsubscribe();
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(false);
		first.reject(new DOMException('Aborted', 'AbortError'));
		second.resolve(jsonResponse([todo]));
		await expect(result).resolves.toEqual([todo]);
	});

	it('retains HTTP status when reading its error body fails', async () => {
		const cause = new Error('body disconnected');
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(new ReadableStream({
			start(controller) { controller.error(cause); },
		}), { status: 503 }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).rejects.toMatchObject({ kind: 'http', status: 503, cause });
	});

	it('treats a successful response body transport failure as a network failure with status', async () => {
		const cause = new Error('body disconnected');
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response(new ReadableStream({
			start(controller) { controller.error(cause); },
		}), { status: 200 }));
		await expect(firstValueFrom(createClient(routes, { fetch }).todos.list({}))).rejects.toMatchObject({ kind: 'network', status: 200, cause });
	});
});
