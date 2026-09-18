import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { request as nodeRequest, type ClientRequest } from 'node:http';
import { once } from 'node:events';
import { EMPTY, NEVER, Observable, Subject, concat, map, mergeMap, of, take } from 'rxjs';
import { vi } from 'vitest';
import { createApp } from './core/app';
import { bootstrap } from './core/bootstrap';
import { get, post, type RouteDefinition } from './core/router';
import { json, stream$ } from './core/response';
import type { Effect, HttpResponse, Middleware, SseEvent } from './core/types';

const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
};

const createHarness = async (routes: RouteDefinition[], options: Parameters<typeof createApp>[1] = {}) => {
	const app = createApp(routes, options);
	const server = await app.start(0);
	const port = server.address()!.port;
	return { app, server, port, url: (path: string) => `http://127.0.0.1:${port}${path}` };
};

const ok: Effect = input$ => input$.pipe(map(() => json({ ok: true })));

// Socket milestones and explicit Subjects order these tests. Short adapter
// deadlines test settlement; no sleeps are used to guess server readiness.
describe('retained Node finite request ownership', () => {
	it('keeps serving after malformed parameters, sync construction and serialization failures', async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const harness = await createHarness([
			get('/item/:id', ok),
			get('/throw', () => { throw new Error('construction failure'); }),
			get('/serialize', () => of(json(circular))),
			get('/function', () => of(json(() => undefined))),
			get('/symbol', () => of(json(Symbol('invalid-json')))),
			get('/header', () => of(json({}, 200, { 'invalid\nheader': 'value' }))),
		]);
		const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			for (const [path, status] of [['/item/%E0%A4%A', 400], ['/throw', 500], ['/serialize', 500], ['/function', 500], ['/symbol', 500], ['/header', 500]] as const) {
				const failed = await fetch(harness.url(path));
				expect(failed.status).toBe(status);
				expect(await failed.json()).toHaveProperty('error');
				expect((await fetch(harness.url('/health'))).status).toBe(200);
				expect(harness.server.closed).toBe(false);
			}
		} finally { logger.mockRestore(); await harness.app.stop(); }
	});

	it('contains global middleware construction faults within the request', async () => {
		let calls = 0;
		const middleware: Middleware = source$ => {
			if (++calls === 1) throw new Error('middleware construction');
			return source$;
		};
		const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
		const harness = await createHarness([], { middlewares: [middleware] });
		try {
			expect((await fetch(harness.url('/health'))).status).toBe(500);
			expect((await fetch(harness.url('/health'))).status).toBe(200);
		} finally { logger.mockRestore(); await harness.app.stop(); }
	});

	it('settles empty, multiple and never-completing handlers with defined finite failures', async () => {
		const harness = await createHarness([
			get('/empty', () => EMPTY), get('/multiple', () => of(json('a'), json('b'))),
			get('/never', () => NEVER), get('/one-without-complete', () => concat(of(json('a')), NEVER)),
		], { request: { deadlineMs: 40 } });
		try {
			for (const [path, status, error] of [
				['/empty', 500, 'Finite operation completed without a response'],
				['/multiple', 500, 'Finite operation emitted multiple responses'],
				['/never', 504, 'Request deadline exceeded'],
				['/one-without-complete', 504, 'Request deadline exceeded'],
			] as const) {
				const response = await fetch(harness.url(path));
				expect(response.status).toBe(status);
				expect(await response.json()).toEqual({ error });
			}
			expect((await fetch(harness.url('/health'))).status).toBe(200);
		} finally { await harness.app.stop(); }
	});

	it('canceling A tears down its work while B retains its isolated context and completes', async () => {
		const entered = { a: deferred(), b: deferred() };
		const released = { a: deferred(), b: deferred() };
		const values = { a: new Subject<void>(), b: new Subject<void>() };
		const contextStates: object[] = [];
		let executions = 0;
		const handler: Effect = input$ => input$.pipe(mergeMap(request => new Observable<HttpResponse>(observer => {
				const id = request.params.id as 'a' | 'b';
				request.requestContext.state.id = id;
				contextStates.push(request.requestContext.state);
				executions++;
				const execution = values[id].pipe(take(1), map(() => json(request.requestContext.state))).subscribe(observer);
				observer.add(() => { released[id].resolve(); });
				observer.add(execution);
				entered[id].resolve();
		})));
		const harness = await createHarness([get('/wait/:id', handler)]);
		const controller = new AbortController();
		try {
			const a = fetch(harness.url('/wait/a'), { signal: controller.signal }).catch(error => error);
			const b = fetch(harness.url('/wait/b'));
			await Promise.all([entered.a.promise, entered.b.promise]);
			expect(contextStates[0]).not.toBe(contextStates[1]);
			controller.abort();
			await a;
			await released.a.promise;
			values.b.next();
			expect(await (await b).json()).toEqual({ id: 'b' });
			await released.b.promise;
			expect(executions).toBe(2);
			expect((await fetch(harness.url('/health'))).status).toBe(200);
		} finally { controller.abort(); await harness.app.stop(); }
	});

	it('bounds unfinished bodies and never executes their handler', async () => {
		let executions = 0;
		const harness = await createHarness([post('/body', source$ => source$.pipe(map(() => { executions++; return json('unexpected'); })))], {
			request: { deadlineMs: 50 },
		});
		let request: ClientRequest | undefined;
		try {
			const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
				request = nodeRequest(harness.url('/body'), { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
					let text = '';
					res.on('data', chunk => { text += chunk; });
					res.on('end', () => resolve({ status: res.statusCode!, text }));
				});
				request.on('error', reject);
				request.write('{"title":');
			});
			expect(await response).toEqual({ status: 504, text: '{"error":"Request deadline exceeded"}' });
			expect(executions).toBe(0);
			expect((await fetch(harness.url('/health'))).status).toBe(200);
		} finally { request?.destroy(); await harness.app.stop(); }
	});

	it('rejects overflow before the uploading peer ends its request', async () => {
		const harness = await createHarness([post('/body', ok)]);
		let request: ClientRequest | undefined;
		try {
			const response = new Promise<number>((resolve, reject) => {
				request = nodeRequest(harness.url('/body'), { method: 'POST' }, res => { res.resume(); resolve(res.statusCode!); });
				request.on('error', reject);
				request.write(Buffer.alloc(1024 * 1024 + 1, 'x'));
			});
			expect(await response).toBe(413);
			expect((await fetch(harness.url('/health'))).status).toBe(200);
		} finally { request?.destroy(); await harness.app.stop(); }
	});
});

describe('retained Node server ownership', () => {
	it('registers startup ownership before hooks reenter start or stop', async () => {
		let repeated: Promise<unknown> | undefined;
		let stopping: Promise<void> | undefined;
		const app = createApp([], { onStart: [() => {
			repeated = expect(app.start(0)).rejects.toThrow('already started');
			stopping = app.stop();
		}] });
		await expect(app.start(0)).rejects.toThrow('start canceled');
		await repeated;
		await stopping;
	});

	it('runs stop cleanup for a partial startup failure before permitting restart', async () => {
		let resources = 0;
		const app = createApp([], {
			onStart: [() => { resources++; }, () => { throw new Error('hook failure'); }],
			onStop: [() => { resources--; }],
		});
		await expect(app.start(0)).rejects.toThrow('hook failure');
		await expect(app.start(0)).rejects.toThrow('already started');
		expect(resources).toBe(1);
		await app.stop();
		expect(resources).toBe(0);
	});

	it('resolves start only after listening, rejects repeated start, and releases its port before stop resolves', async () => {
		const harness = await createHarness([]);
		expect(harness.server.address()?.port).toBeGreaterThan(0);
		expect((await fetch(harness.url('/ready'))).status).toBe(200);
		await expect(harness.app.start(0)).rejects.toThrow('already started');
		await Promise.all([harness.app.stop(), harness.app.stop()]);
		expect(harness.server.closed).toBe(true);
		const replacement = createNetServer();
		replacement.listen(harness.port);
		await once(replacement, 'listening');
		await new Promise<void>(resolve => replacement.close(() => resolve()));
		const restarted = await harness.app.start(0);
		expect(restarted.closed).toBe(false);
		await harness.app.stop();
	});

	it('rejects occupied ports without an unhandled listener failure', async () => {
		const occupied = createNetServer();
		occupied.listen(0);
		await once(occupied, 'listening');
		const app = createApp([]);
		try {
			await expect(app.start((occupied.address() as AddressInfo).port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
			await app.stop();
		} finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
	});

	it('rejects invalid listen arguments and still settles stop', async () => {
		const app = createApp([]);
		await expect(app.start(-1)).rejects.toBeInstanceOf(RangeError);
		await app.stop();
	});

	it('stops during startup hooks without opening a later listener', async () => {
		const entered = deferred();
		const finish = deferred();
		const stopHook = vi.fn();
		const app = createApp([], { onStart: [async () => { entered.resolve(); await finish.promise; }], onStop: [stopHook] });
		const start = app.start(0);
		const failure = expect(start).rejects.toThrow('start canceled');
		await entered.promise;
		const stop = app.stop();
		finish.resolve();
		await Promise.all([failure, stop]);
		expect(stopHook).toHaveBeenCalledOnce();
		const server = await app.start(0);
		expect(server.address()).not.toBeNull();
		await app.stop();
	});

	it('legacy bootstrap can be disposed immediately while listening is pending', async () => {
		const server = bootstrap(0, ok);
		server.unsubscribe();
		await expect(server.ready).rejects.toThrow('stopped before listening');
		await server.stopped;
		expect(server.address()).toBeNull();
	});

	it('keeps SSE alive after the GET ends and tears it down on response disconnect', async () => {
		const events = new Subject<SseEvent>();
		const released = deferred();
		let active = 0;
		const stream = new Observable<SseEvent>(observer => {
			active++;
			const subscription = events.subscribe(observer);
			observer.next({ data: 'initial' });
			return () => { subscription.unsubscribe(); active--; released.resolve(); };
		});
		const harness = await createHarness([get('/stream', () => of({ stream }))]);
		const controller = new AbortController();
		try {
			const response = await fetch(harness.url('/stream'), { signal: controller.signal });
			const reader = response.body!.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain('initial');
			expect(active).toBe(1);
			events.next({ data: 'later' });
			expect(new TextDecoder().decode((await reader.read()).value)).toContain('later');
			controller.abort();
			await released.promise;
			expect(active).toBe(0);
			expect((await fetch(harness.url('/health'))).status).toBe(200);
		} finally { controller.abort(); await harness.app.stop(); }
	});

	it('application shutdown owns and releases active SSE subscriptions', async () => {
		let active = 0;
		const stream = new Observable(observer => {
			active++;
			observer.next('initial');
			return () => { active--; };
		});
		const harness = await createHarness([get('/stream', () => of(stream$(stream)))]);
		const response = await fetch(harness.url('/stream'));
		const reader = response.body!.getReader();
		await reader.read();
		expect(active).toBe(1);
		await harness.app.stop();
		expect(active).toBe(0);
		await reader.cancel().catch(() => undefined);
	});
});
