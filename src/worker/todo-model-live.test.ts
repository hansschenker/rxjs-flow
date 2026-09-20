import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { createTodoModel } from '../client/todo.model';
import { todoEffects$ } from '../client/todo.effects';
import { createTodoService } from '../client/todo.service';
import { createScope } from '../client/runtime/scope';
import type { EventSourceConnection } from '../client/sse';
import type { LiveConnectionEvent } from '../client/live-connection';
import type { Action, State } from '../client/todo.state';
import type { TodoLiveSnapshot } from '../shared/todo-live';
import type { TodoAuthority } from '../server/todos/todo.authority';
import { createWorkerApp } from './index';
import { createDurableTodoSnapshots } from './todo-live';
import { createDurableTodoRepository } from './todo-repository';

function latch() {
	let release!: () => void;
	const ready = new Promise<void>(resolve => { release = resolve; });
	return { ready, release };
}

/**
 * This test reader supplies EventSource's event interface using real workerd
 * response bodies. It has no reconnect policy: the production RxJS adapter owns
 * that policy. Browser EventSource/DOM evidence is recorded separately.
 */
function connectionTo(
	request: (request: Request) => Response | Promise<Response>,
	url: string,
	beforeDelivery: (data: string) => Promise<void>,
) {
	const lifetime = new AbortController();
	const listeners = new Map<string, Set<Parameters<EventSourceConnection['addEventListener']>[1]>>();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let stopped = false;
	const connection: EventSourceConnection & { interrupt(): void } = {
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
		},
		removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
		onerror: null,
		close() {
			if (stopped) return;
			stopped = true;
			if (reader) void reader.cancel().catch(() => {});
			else lifetime.abort();
		},
		interrupt() { connection.onerror?.(new Event('error')); },
	};
	async function consume() {
		try {
			const response = await request(new Request(new URL(url, 'https://model-test'), { signal: lifetime.signal }));
			if (stopped) { await response.body?.cancel(); return; }
			if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
				await response.body?.cancel();
				throw new Error('Expected an SSE response');
			}
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = '';
			while (!stopped) {
				const next = await reader.read();
				if (stopped) return;
				if (next.done) throw new Error('Live response ended');
				pending += decoder.decode(next.value, { stream: true });
				if (pending.length > 256 * 1_024) throw new Error('Test SSE buffer exceeded capacity');
				let end: number;
				while (!stopped && (end = pending.indexOf('\n\n')) !== -1) {
					const lines = pending.slice(0, end).split('\n');
					pending = pending.slice(end + 2);
					const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
					const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
					await beforeDelivery(data);
					if (!stopped) for (const listener of listeners.get(event) ?? []) listener(new MessageEvent(event, { data }));
				}
			}
		} catch {
			if (!stopped) connection.onerror?.(new Event('error'));
		} finally { try { reader?.releaseLock(); } catch { /* Cancellation owns a pending read. */ } }
	}
	void consume();
	return connection;
}

function fixture() {
	const collectionId = `models-${crypto.randomUUID()}`;
	let handlers = 0;
	const connections: ReturnType<typeof connectionTo>[] = [];
	let holdSnapshots: ReturnType<typeof latch> | undefined;
	let holdAcknowledgment: ReturnType<typeof latch> | undefined;
	let mutationResponses = 0;

	function stub() { return env.TODO_COLLECTIONS.getByName(collectionId); }
	function request(input: Request) {
		handlers++;
		const authority = stub();
		// No handler instance, repository or live source is shared across requests.
		return createWorkerApp({
			todoRepository: createDurableTodoRepository(authority, collectionId),
			todoSnapshots$: createDurableTodoSnapshots(authority, collectionId),
		}).fetch(input);
	}
	async function beforeDelivery(data: string) {
		if (holdSnapshots && (JSON.parse(data) as { revision: number }).revision > 0) await holdSnapshots.ready;
	}
	const service = createTodoService({
		collectionId,
		fetch: async (input, init) => {
			const response = await request(new Request(new URL(String(input), 'https://model-test'), init));
			if (init?.method === 'POST') {
				mutationResponses++;
				if (holdAcknowledgment) await holdAcknowledgment.ready;
			}
			return response;
		},
		live: {
			retryDelaysMs: [], initialSnapshotTimeoutMs: 5_000,
			createEventSource: url => {
				const connection = connectionTo(request, url, beforeDelivery);
				connections.push(connection);
				return connection;
			},
		},
	});
	return {
		collectionId, service, connections, stub,
		get handlers() { return handlers; },
		get mutationResponses() { return mutationResponses; },
		holdSnapshots() { return holdSnapshots = latch(); },
		holdAcknowledgment() { return holdAcknowledgment = latch(); },
		async active() {
			return runInDurableObject(stub(), instance => (instance as unknown as { authority: TodoAuthority }).authority.resourceCounts().subscribers);
		},
	};
}

function mountModel(test: ReturnType<typeof fixture>) {
	const scope = createScope();
	const recovery = new Subject<void>();
	const model = createTodoModel({ collectionSource: 'live', collectionId: test.collectionId });
	const collectionChanges: Action['type'][] = [];
	const failures: unknown[] = [];
	let current!: State;
	function dispatch(action: Action) { model.dispatch(action); }
	function accept(event: LiveConnectionEvent<TodoLiveSnapshot>) {
		switch (event.type) {
			case 'connecting': dispatch({ type: 'LIVE_CONNECTING', connectionId: event.connectionId, attempt: event.attempt }); break;
			case 'snapshot': dispatch({ type: 'LIVE_SNAPSHOT', connectionId: event.connectionId, snapshot: event.value }); break;
			case 'reconnecting': dispatch({ type: 'LIVE_INTERRUPTED', connectionId: event.connectionId, attempt: event.attempt,
				retrying: true, delayMs: event.delayMs, message: event.message }); break;
			case 'failed': dispatch({ type: 'LIVE_INTERRUPTED', connectionId: event.connectionId, attempt: event.attempt,
				retrying: false, message: event.message }); break;
		}
	}
	scope.subscribe(model.state$, { next: state => { current = state; }, error: error => failures.push(error) });
	scope.subscribe(model.transitions$, { next: transition => {
		if (transition.previous.todos !== transition.state.todos) collectionChanges.push(transition.message.type);
	} });
	scope.subscribe(todoEffects$(model.transitions$, test.service), { next: dispatch, error: error => failures.push(error) });
	model.start();
	scope.subscribe(test.service.live$!(recovery), { next: accept, error: error => failures.push(error) });
	return {
		model, failures, collectionChanges,
		get current() { return current; },
		create(title: string) { dispatch({ type: 'CREATE_REQUESTED', title }); },
		reconnect() { recovery.next(); },
		dispose() { scope.dispose(); recovery.complete(); model.dispose(); },
	};
}

describe('M06 live models through real workerd authority and independent Hono handlers', () => {
	it.each(['HTTP first', 'snapshot first'] as const)('converges once per accepted mutation when %s settles', async order => {
		const test = fixture();
		const a = mountModel(test);
		const b = mountModel(test);
		let release: (() => void) | undefined;
		try {
			await expect.poll(() => a.current.connection).toBe('connected');
			await expect.poll(() => b.current.connection).toBe('connected');
			expect(await test.active()).toBe(2);
			expect(test.handlers).toBe(2);
			const trace = a.model.state$.subscribe();
			const view = a.model.viewModel$.subscribe();
			expect(test.connections).toHaveLength(2);
			trace.unsubscribe(); view.unsubscribe();
			const gate = order === 'HTTP first' ? test.holdSnapshots() : test.holdAcknowledgment();
			release = gate.release;
			a.create('From client A');
			await expect.poll(() => test.mutationResponses).toBe(1);
			if (order === 'HTTP first') {
				await expect.poll(() => a.current.pending.length).toBe(0);
				expect(a.current.todos).toEqual([]);
				expect(b.current.todos).toEqual([]);
				expect(a.collectionChanges).toEqual([]);
			} else {
				await expect.poll(() => a.current.todos.length).toBe(1);
				await expect.poll(() => b.current.todos.length).toBe(1);
				expect(a.current.pending).toHaveLength(1);
				expect(a.collectionChanges).toEqual(['LIVE_SNAPSHOT']);
			}
			gate.release();
			await expect.poll(() => a.current.pending.length).toBe(0);
			await expect.poll(() => a.current.todos.length).toBe(1);
			await expect.poll(() => b.current.todos.length).toBe(1);
			expect(a.current.todos).toEqual(b.current.todos);
			expect(a.current.live?.identity).toEqual(b.current.live?.identity);
			expect(a.current.live?.identity?.revision).toBe(1);
			expect(a.collectionChanges).toEqual(['LIVE_SNAPSHOT']);
			expect(b.collectionChanges).toEqual(['LIVE_SNAPSHOT']);
			b.create('From client B');
			await expect.poll(() => b.current.pending.length).toBe(0);
			await expect.poll(() => a.current.todos.length).toBe(2);
			await expect.poll(() => b.current.todos.length).toBe(2);
			expect(a.current.todos).toEqual(b.current.todos);
			expect(a.current.live?.identity?.revision).toBe(2);
			expect(a.collectionChanges).toEqual(['LIVE_SNAPSHOT', 'LIVE_SNAPSHOT']);
			expect(b.collectionChanges).toEqual(['LIVE_SNAPSHOT', 'LIVE_SNAPSHOT']);
			expect(test.handlers).toBe(4);
			expect(test.connections).toHaveLength(2);
			expect(a.failures).toEqual([]); expect(b.failures).toEqual([]);
		} finally { release?.(); a.dispose(); b.dispose(); }
		await expect.poll(() => test.active()).toBe(0);
	});

	it('resynchronizes mounted models after persisted reconstruction and explicit history replacement', async () => {
		const test = fixture();
		const a = mountModel(test);
		const b = mountModel(test);
		try {
			await expect.poll(() => a.current.connection).toBe('connected');
			await expect.poll(() => b.current.connection).toBe('connected');
			a.create('Retained across authority reconstruction');
			await expect.poll(() => a.current.todos.length).toBe(1);
			await expect.poll(() => b.current.todos.length).toBe(1);
			await expect.poll(() => a.current.pending.length).toBe(0);
			const original = a.current.live!.identity!;
			for (const connection of test.connections) connection.interrupt();
			expect(a.current).toMatchObject({ connection: 'disconnected', live: { stale: true } });
			await expect.poll(() => test.active()).toBe(0);
			await evictDurableObject(test.stub());
			a.reconnect(); b.reconnect();
			await expect.poll(() => a.current.connection).toBe('connected');
			await expect.poll(() => b.current.connection).toBe('connected');
			expect(a.current.live?.identity).toEqual(original);
			expect(b.current.live?.identity).toEqual(original);
			expect(a.collectionChanges).toEqual(['LIVE_SNAPSHOT']);
			expect(b.collectionChanges).toEqual(['LIVE_SNAPSHOT']);
			for (const connection of test.connections) connection.interrupt();
			await expect.poll(() => test.active()).toBe(0);
			// Test-only reset, with no public administration or migration route.
			await runInDurableObject(test.stub(), (_instance, state) => state.storage.deleteAll());
			await evictDurableObject(test.stub());
			a.reconnect(); b.reconnect();
			await expect.poll(() => a.current.connection).toBe('connected');
			await expect.poll(() => b.current.connection).toBe('connected');
			expect(a.current.todos).toEqual([]);
			expect(b.current.todos).toEqual([]);
			expect(a.current.live?.identity).toEqual(b.current.live?.identity);
			expect(a.current.live?.identity).toMatchObject({ collectionId: original.collectionId, revision: 0 });
			expect(a.current.live?.identity?.stateGeneration).not.toBe(original.stateGeneration);
			expect(a.collectionChanges).toEqual(['LIVE_SNAPSHOT', 'LIVE_SNAPSHOT']);
			expect(b.collectionChanges).toEqual(['LIVE_SNAPSHOT', 'LIVE_SNAPSHOT']);
			expect(test.connections).toHaveLength(6);
			expect(a.failures).toEqual([]); expect(b.failures).toEqual([]);
		} finally { a.dispose(); b.dispose(); }
		await expect.poll(() => test.active()).toBe(0);
	});
});
