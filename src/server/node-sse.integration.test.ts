import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { Observable, Subject, map, of } from 'rxjs';
import { createApp } from './core/app';
import { NODE_SSE_LIMITS } from './core/http';
import { get } from './core/router';
import type { HttpResponse, SseEvent } from './core/types';

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	return { promise, resolve };
};

const readFrame = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
	new TextDecoder().decode((await reader.read()).value);

describe('retained Node SSE real response lifetimes', () => {
	it.each([204, 205, 304])('rejects stream status %i before headers and source activation', async status => {
		let activations = 0;
		const stream = new Observable<SseEvent>(() => { activations++; });
		const app = createApp([get('/invalid-stream', () => of({ status, stream }))]);
		const server = await app.start(0);
		try {
			const response = await fetch(`http://127.0.0.1:${server.address()!.port}/invalid-stream`);
			expect(response.status).toBe(500);
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(await response.json()).toEqual({ error: 'Internal server error' });
			expect(activations).toBe(0);
		} finally { await app.stop(); }
	});

	it('rejects an invalid stream policy before headers and source activation', async () => {
		let activations = 0;
		const stream = new Observable<SseEvent>(() => { activations++; });
		const app = createApp([get('/invalid-policy', () => of({
			stream, streamPolicy: 'unbounded' as HttpResponse['streamPolicy'],
		}))]);
		const server = await app.start(0);
		try {
			const response = await fetch(`http://127.0.0.1:${server.address()!.port}/invalid-policy`);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: 'Internal server error' });
			expect(activations).toBe(0);
		} finally { await app.stop(); }
	});

	it('disconnects A, keeps B active, reconnects A with current state and releases its port on shutdown', async () => {
		const updates = new Subject<SseEvent>();
		let current = 0;
		let active = 0;
		const disconnected = deferred();
		const stream = new Observable<SseEvent>(observer => {
			active++;
			const subscription = updates.subscribe(observer);
			observer.next({ data: current });
			return () => { subscription.unsubscribe(); active--; disconnected.resolve(); };
		});
		const app = createApp([get('/stream', () => of({ stream, streamPolicy: 'latest-snapshot' }))]);
		const server = await app.start(0);
		const port = server.address()!.port;
		const url = `http://127.0.0.1:${port}/stream`;
		const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
		try {
			const a = (await fetch(url)).body!.getReader();
			const b = (await fetch(url)).body!.getReader();
			readers.push(a, b);
			expect(await readFrame(a)).toBe('data: 0\n\n');
			expect(await readFrame(b)).toBe('data: 0\n\n');
			expect(active).toBe(2);
			await a.cancel();
			await disconnected.promise;
			expect(active).toBe(1);
			current = 1;
			updates.next({ data: current });
			expect(await readFrame(b)).toBe('data: 1\n\n');
			const reconnected = (await fetch(url)).body!.getReader();
			readers.push(reconnected);
			expect(await readFrame(reconnected)).toBe('data: 1\n\n');
			expect(active).toBe(2);
			await app.stop();
			expect(active).toBe(0);
			expect(updates.observed).toBe(false);
			const replacement = createNetServer();
			replacement.listen(port);
			await once(replacement, 'listening');
			await new Promise<void>(resolve => replacement.close(() => resolve()));
		} finally {
			await app.stop();
			await Promise.all(readers.map(reader => reader.cancel().catch(() => undefined)));
		}
	});

	it('exposes a post-header source failure as interrupted response while another client continues', async () => {
		const updates = { a: new Subject<SseEvent>(), b: new Subject<SseEvent>() };
		const app = createApp([get('/stream/:id', input$ => input$.pipe(map(request => ({
			stream: new Observable<SseEvent>(sink => {
				const subscription = updates[request.params.id as 'a' | 'b'].subscribe(sink);
				sink.next({ data: 'initial' });
				return subscription;
			}),
		}))))]);
		const server = await app.start(0);
		const url = `http://127.0.0.1:${server.address()!.port}`;
		const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
		try {
			const a = (await fetch(`${url}/stream/a`)).body!.getReader();
			const b = (await fetch(`${url}/stream/b`)).body!.getReader();
			readers.push(a, b);
			expect(await readFrame(a)).toContain('initial');
			expect(await readFrame(b)).toContain('initial');
			const failedRead = expect(a.read()).rejects.toThrow();
			updates.a.error(new Error('authority interrupted'));
			await failedRead;
			expect(updates.a.observed).toBe(false);
			updates.b.next({ data: 'still connected' });
			expect(await readFrame(b)).toContain('still connected');
			expect((await fetch(`${url}/health`)).status).toBe(200);
		} finally {
			await app.stop();
			await Promise.all(readers.map(reader => reader.cancel().catch(() => undefined)));
		}
	});

	it('rejects excess active responses before subscribing and reuses admission after cancellation', async () => {
		let active = 0;
		let activations = 0;
		const disconnected = deferred();
		const stream = new Observable<SseEvent>(observer => {
			active++;
			activations++;
			observer.next({ data: 'connected' });
			return () => { active--; disconnected.resolve(); };
		});
		const app = createApp([get('/stream', () => of({ stream }))]);
		const server = await app.start(0);
		const url = `http://127.0.0.1:${server.address()!.port}/stream`;
		const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
		try {
			for (let i = 0; i < NODE_SSE_LIMITS.maxActiveStreams; i++) {
				const response = await fetch(url);
				expect(response.status).toBe(200);
				const reader = response.body!.getReader();
				readers.push(reader);
				await reader.read();
			}
			expect(active).toBe(NODE_SSE_LIMITS.maxActiveStreams);
			const rejected = await fetch(url);
			expect(rejected.status).toBe(503);
			expect(await rejected.json()).toEqual({ error: 'Live stream capacity reached' });
			expect(activations).toBe(NODE_SSE_LIMITS.maxActiveStreams);
			await readers[0].cancel();
			await disconnected.promise;
			expect(active).toBe(NODE_SSE_LIMITS.maxActiveStreams - 1);
			const replacement = await fetch(url);
			expect(replacement.status).toBe(200);
			const reader = replacement.body!.getReader();
			readers.push(reader);
			await reader.read();
			expect(active).toBe(NODE_SSE_LIMITS.maxActiveStreams);
			expect(activations).toBe(NODE_SSE_LIMITS.maxActiveStreams + 1);
		} finally {
			await app.stop();
			await Promise.all(readers.map(reader => reader.cancel().catch(() => undefined)));
			expect(active).toBe(0);
		}
	});
});
