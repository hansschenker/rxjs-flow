import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { firstValueFrom, Observable, Subject, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TODO_AUTHORITY_LIMITS, type TodoAuthority, type TodoSnapshot } from '../server/todos/todo.authority';
import type { SseEvent } from '../server/core/types';
import { createWorkerApp } from './index';
import type { TodoCollection } from './todo-collection';
import { createDurableTodoLive, TODO_WATCH_CONTENT_TYPE, TODO_WATCH_PATH } from './todo-live';
import { createTodoLiveResponse } from './todo-live-response';

const encoder = new TextEncoder();
const snapshot: TodoSnapshot = {
	schemaVersion: 1, collectionId: 'decoder-test', stateGeneration: 'generation', revision: 0, todos: [],
};

function transport(fetch: () => Promise<Response>): DurableObjectStub<TodoCollection> {
	return { fetch } as unknown as DurableObjectStub<TodoCollection>;
}

function response(chunks: Uint8Array[], cancel?: () => void): Response {
	return new Response(new ReadableStream<Uint8Array>({
		start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (!cancel) controller.close(); }, cancel,
	}), { headers: { 'content-type': TODO_WATCH_CONTENT_TYPE } });
}

function collection() {
	const id = `live-${crypto.randomUUID()}`;
	return { id, stub: env.TODO_COLLECTIONS.getByName(id) };
}

async function counts(stub: DurableObjectStub<TodoCollection>) {
	return runInDurableObject(stub, instance => (instance as unknown as { authority: TodoAuthority }).authority.resourceCounts());
}

async function mutate(stub: DurableObjectStub<TodoCollection>, title: string) {
	using result = await stub.execute({ kind: 'create', input: { title } });
	expect(result.ok).toBe(true);
}

function events(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	let pending = '';
	const decoder = new TextDecoder();
	return {
		cancel: () => reader.cancel(),
		async next(): Promise<SseEvent> {
			while (!pending.includes('\n\n')) {
				const item = await reader.read();
				if (item.done) throw new Error('Live response ended');
				pending += decoder.decode(item.value, { stream: true });
			}
			const end = pending.indexOf('\n\n');
			const frame = pending.slice(0, end);
			pending = pending.slice(end + 2);
			const lines = frame.split('\n');
			return { event: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.find(line => line.startsWith('data:'))!.slice(5).trim()) };
		},
	};
}

describe('bounded authority record decoding in workerd', () => {
	it('is cold and decodes split Unicode and multiple records from one transport read', async () => {
		const named = { ...snapshot, revision: 1, todos: [{ id: '1', title: '日本語 🌱', completed: false, createdAt: '2026-09-18T00:00:00.000Z' }] };
		const bytes = encoder.encode(`${JSON.stringify(named)}\n${JSON.stringify({ ...named, revision: 2 })}\n`);
		const split = bytes.findIndex(byte => byte > 127) + 1;
		const fetch = vi.fn(async () => response([bytes.subarray(0, split), bytes.subarray(split)]));
		const live = createDurableTodoLive(transport(fetch), snapshot.collectionId);
		expect(fetch).not.toHaveBeenCalled();
		expect(await firstValueFrom(live.pipe(toArray()))).toEqual([{ event: 'todos', data: named.todos }, { event: 'todos', data: named.todos }]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		['foreign collection', `${JSON.stringify({ ...snapshot, collectionId: 'foreign' })}\n`],
		['invalid JSON', '{broken}\n'],
		['truncated frame', JSON.stringify(snapshot)],
		['blank frame', '\n'],
		['unsupported schema', `${JSON.stringify({ ...snapshot, schemaVersion: 2 })}\n`],
	])('rejects %s without delivering an advertised snapshot', async (_label, text) => {
		await expect(firstValueFrom(createDurableTodoLive(transport(async () => response([encoder.encode(text)])), snapshot.collectionId).pipe(toArray()))).rejects.toMatchObject({ status: 503 });
	});

	it('bounds an unterminated snapshot and cancels the upstream body', async () => {
		const cancel = vi.fn();
		await expect(firstValueFrom(createDurableTodoLive(transport(async () => response([
			new Uint8Array(TODO_AUTHORITY_LIMITS.maxSnapshotBytes + 1).fill(32),
		], cancel)), snapshot.collectionId))).rejects.toMatchObject({ status: 503 });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed UTF8 instead of silently changing a persisted title', async () => {
		const bytes = Uint8Array.from([...encoder.encode(JSON.stringify(snapshot).slice(0, -1)), 255, 125, 10]);
		await expect(firstValueFrom(createDurableTodoLive(transport(async () => response([bytes])), snapshot.collectionId))).rejects.toMatchObject({ status: 503 });
	});

	it('cancels a late body when disposal occurred while its fetch was pending', async () => {
		let resolve!: (response: Response) => void;
		const cancel = vi.fn();
		const fetch = vi.fn((_url: string, init: RequestInit) => {
			expect(init.signal?.aborted).toBe(false);
			return new Promise<Response>(settle => { resolve = settle; });
		});
		const live = createDurableTodoLive({ fetch } as unknown as DurableObjectStub<TodoCollection>, snapshot.collectionId);
		const subscription = live.subscribe();
		subscription.unsubscribe();
		expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
		resolve(response([], cancel));
		await expect.poll(() => cancel.mock.calls.length).toBe(1);
	});

	it('rejects an invalid response and releases its unread body', async () => {
		const cancel = vi.fn();
		const stub = transport(async () => new Response(new ReadableStream({ cancel }), { status: 503 }));
		await expect(firstValueFrom(createDurableTodoLive(stub, snapshot.collectionId))).rejects.toMatchObject({ status: 503 });
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});

describe('authority byte response lifecycle in workerd', () => {
	it('finishes a synchronous snapshot source without retaining its subscription', async () => {
		const finish = vi.fn();
		const body = createTodoLiveResponse(new Observable<TodoSnapshot>(observer => {
			observer.next(snapshot); observer.complete(); return finish;
		}), new AbortController().signal);
		expect(new TextDecoder().decode(await body.arrayBuffer())).toBe(`${JSON.stringify(snapshot)}\n`);
		expect(finish).toHaveBeenCalledTimes(1);
	});

	it('makes synchronous source failure visible and disposes its source', async () => {
		const finish = vi.fn();
		const body = createTodoLiveResponse(new Observable<TodoSnapshot>(observer => {
			observer.error(new Error('Source failed')); return finish;
		}), new AbortController().signal);
		await expect(body.arrayBuffer()).rejects.toThrow('Source failed');
		expect(finish).toHaveBeenCalledTimes(1);
	});

	it('never activates a source when the internal request is already aborted', async () => {
		const activate = vi.fn();
		const controller = new AbortController(); controller.abort();
		const body = createTodoLiveResponse(new Observable(activate), controller.signal);
		await expect(body.arrayBuffer()).rejects.toBeDefined();
		expect(activate).not.toHaveBeenCalled();
	});

	it('coalesces only full snapshots while the consumer stops reading', async () => {
		const source = new Subject<TodoSnapshot>();
		const response = createTodoLiveResponse(source, new AbortController().signal);
		for (let revision = 1; revision <= 100; revision++) source.next({ ...snapshot, revision });
		const reader = response.body!.getReader();
		const item = await reader.read();
		expect(JSON.parse(new TextDecoder().decode(item.value)).revision).toBe(100);
		await reader.cancel();
		expect(source.observed).toBe(false);
	});
});

describe('Durable Object to Worker to live response in workerd', () => {
	it('keeps two real authority consumers active; cancelling A leaves B and committed state intact', async () => {
		const { id, stub } = collection();
		const app = createWorkerApp({ todoLive$: createDurableTodoLive(stub, id) });
		const first = events((await app.request('/api/todos/stream')).body!);
		const second = events((await app.request('/api/todos/stream')).body!);
		try {
			expect(await first.next()).toEqual({ event: 'todos', data: [] });
			expect(await second.next()).toEqual({ event: 'todos', data: [] });
			expect((await counts(stub)).subscribers).toBe(2);
			await mutate(stub, 'Both clients');
			expect((await first.next()).data).toMatchObject([{ title: 'Both clients' }]);
			expect((await second.next()).data).toMatchObject([{ title: 'Both clients' }]);
			await first.cancel();
			await expect.poll(async () => (await counts(stub)).subscribers).toBe(1);
			await mutate(stub, 'B continues');
			expect((await second.next()).data).toMatchObject([{ title: 'Both clients' }, { title: 'B continues' }]);
		} finally { await first.cancel(); await second.cancel(); }
		await expect.poll(async () => (await counts(stub)).subscribers).toBe(0);
		using committed = await stub.execute({ kind: 'snapshot' });
		expect(committed).toMatchObject({ ok: true, result: { snapshot: { revision: 2 } } });
	});

	it('actual response cancellation before any read releases the authority registration', async () => {
		const { stub } = collection();
		const response = await stub.fetch(`https://authority${TODO_WATCH_PATH}`);
		expect((await counts(stub)).subscribers).toBe(1);
		await response.body!.cancel();
		await expect.poll(async () => (await counts(stub)).subscribers).toBe(0);
	});

	it('a mutation racing connection setup appears in the initial or next full snapshot', async () => {
		const { id, stub } = collection();
		const app = createWorkerApp({ todoLive$: createDurableTodoLive(stub, id) });
		const opening = app.request('/api/todos/stream');
		await mutate(stub, 'During setup');
		const consumer = events((await opening).body!);
		try {
			const initial = await consumer.next();
			const latest = (initial.data as unknown[]).length === 0 ? await consumer.next() : initial;
			expect(latest.data).toMatchObject([{ title: 'During setup' }]);
		} finally { await consumer.cancel(); }
		await expect.poll(async () => (await counts(stub)).subscribers).toBe(0);
	});

	it('propagates authority source failure through both response bodies and releases its subscribers', async () => {
		const { id, stub } = collection();
		const app = createWorkerApp({ todoLive$: createDurableTodoLive(stub, id) });
		const first = events((await app.request('/api/todos/stream')).body!);
		const second = events((await app.request('/api/todos/stream')).body!);
		await first.next(); await second.next();
		const outcomes = Promise.all([first.next(), second.next()].map(pending =>
			pending.then(() => 'unexpected value', () => 'interrupted'),
		));
		await runInDurableObject(stub, instance => (instance as unknown as { authority: TodoAuthority }).authority.dispose());
		expect(await outcomes).toEqual(['interrupted', 'interrupted']);
		expect((await counts(stub)).subscribers).toBe(0);
	});

	it('turns a hard runtime abort into a visible stream failure', async () => {
		const { id, stub } = collection();
		const app = createWorkerApp({ todoLive$: createDurableTodoLive(stub, id) });
		const consumer = events((await app.request('/api/todos/stream')).body!);
		await consumer.next();
		const interruption = consumer.next().then(() => 'unexpected value', () => 'interrupted');
		await runInDurableObject(stub, (_instance, state) => state.abort('Injected authority interruption')).catch(() => {});
		expect(await interruption).toBe('interrupted');
		const replacement = env.TODO_COLLECTIONS.getByName(id);
		expect((await counts(replacement)).subscribers).toBe(0);
	});

	it('reconnects after local eviction to the same durable history with a fresh stream', async () => {
		const { id, stub } = collection();
		const app = createWorkerApp({ todoLive$: createDurableTodoLive(stub, id) });
		const first = events((await app.request('/api/todos/stream')).body!);
		await first.next();
		await mutate(stub, 'Before eviction');
		expect((await first.next()).data).toMatchObject([{ title: 'Before eviction' }]);
		using before = await stub.execute({ kind: 'snapshot' });
		await first.cancel();
		await expect.poll(async () => (await counts(stub)).subscribers).toBe(0);
		await evictDurableObject(stub);
		const replacement = env.TODO_COLLECTIONS.getByName(id);
		using after = await replacement.execute({ kind: 'snapshot' });
		expect(after).toEqual(before);
		const second = events((await createWorkerApp({ todoLive$: createDurableTodoLive(replacement, id) }).request('/api/todos/stream')).body!);
		try {
			expect((await second.next()).data).toMatchObject([{ title: 'Before eviction' }]);
			expect((await counts(replacement)).subscribers).toBe(1);
			await mutate(replacement, 'After eviction');
			expect((await second.next()).data).toMatchObject([{ title: 'Before eviction' }, { title: 'After eviction' }]);
		} finally { await second.cancel(); }
		await expect.poll(async () => (await counts(replacement)).subscribers).toBe(0);
	});
});
