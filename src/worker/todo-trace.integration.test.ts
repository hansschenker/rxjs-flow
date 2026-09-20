import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { Observable, Subject, firstValueFrom, map } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { createTodoModel } from '../client/todo.model';
import { todoEffects$ } from '../client/todo.effects';
import { createTodoService } from '../client/todo.service';
import { createScope } from '../client/runtime/scope';
import type { EventSourceConnection } from '../client/sse';
import type { LiveConnectionEvent } from '../client/live-connection';
import type { Action, State } from '../client/todo.state';
import { createTrace, createTraceRecorder, type Trace, type TraceRecord } from '../shared/trace';
import type { TodoLiveSnapshot } from '../shared/todo-live';
import type { Todo } from '../shared/types';
import { createTodoAuthority, type TodoAuthority, type TodoAuthorityOptions } from '../server/todos/todo.authority';
import type { TodoRepository } from '../server/todos/todo.repository';
import { createWorkerApp } from './index';
import { createDurableTodoStorage, TODO_SNAPSHOT_KEY } from './todo-storage';
import { createOwnedByteStream } from './owned-byte-stream';

function latch() {
	let release!: () => void;
	const ready = new Promise<void>(resolve => { release = resolve; });
	return { ready, release };
}

/** Real workerd response bytes; EventSource's reconnect policy is not simulated. */
function responseConnection(request: (request: Request) => Response | Promise<Response>, url: string): EventSourceConnection {
	const lifetime = new AbortController();
	const listeners = new Map<string, Set<Parameters<EventSourceConnection['addEventListener']>[1]>>();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let stopped = false;
	const connection: EventSourceConnection = {
		onerror: null,
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
		},
		removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
		close() {
			if (stopped) return;
			stopped = true;
			if (reader) void reader.cancel().catch(() => {});
			else lifetime.abort();
		},
	};
	async function consume() {
		try {
			const response = await request(new Request(new URL(url, 'https://local-trace.test'), { signal: lifetime.signal }));
			if (stopped) { await response.body?.cancel(); return; }
			if (!response.ok || !response.body) throw new Error('Expected live body');
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = '';
			while (!stopped) {
				const chunk = await reader.read();
				if (stopped) return;
				if (chunk.done) throw new Error('Live response ended');
				pending += decoder.decode(chunk.value, { stream: true });
				if (pending.length > 256 * 1_024) throw new Error('Test reader exceeded its bound');
				let end: number;
				while (!stopped && (end = pending.indexOf('\n\n')) !== -1) {
					const lines = pending.slice(0, end).split('\n');
					pending = pending.slice(end + 2);
					const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
					const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
					for (const listener of listeners.get(event) ?? []) listener(new MessageEvent(event, { data }));
				}
			}
		} catch { if (!stopped) connection.onerror?.(new Event('error')); }
		finally { try { reader?.releaseLock(); } catch { /* Cancellation owns pending reads. */ } }
	}
	void consume();
	return connection;
}

function repository(authority: TodoAuthority, operationId?: string): TodoRepository {
	return {
		list$: completed => authority.execute$({ kind: 'list', completed }, operationId).pipe(map(result => result.value as Todo[])),
		create$: input => authority.execute$({ kind: 'create', input }, operationId).pipe(map(result => result.value as Todo)),
		update$: (id, input) => authority.execute$({ kind: 'update', id, input }, operationId).pipe(map(result => result.value as Todo)),
		delete$: id => authority.execute$({ kind: 'delete', id }, operationId).pipe(map(() => undefined)),
	};
}

function options(storage: DurableObjectStorage, trace?: Trace): TodoAuthorityOptions {
	let todoId = 0;
	return { collectionId: 'local-trace', storage: createDurableTodoStorage(storage), trace,
		newTodoId: () => `todo-${++todoId}`, now: () => '2026-09-20T00:00:00.000Z', newStateGeneration: () => 'persisted-generation' };
}

function events(records: readonly TraceRecord[], operationId: string): string[] {
	return records.filter(record => record.operationId === operationId).map(record => record.event);
}

async function clientAuthorityScenario(storage: DurableObjectStorage, traced: boolean) {
	const recorder = createTraceRecorder({ capacity: 1000 });
	const clientTrace = traced ? createTrace({ runtimeId: 'client', now: () => 100, sink: recorder.sink }) : undefined;
	const workerTrace = traced ? createTrace({ runtimeId: 'worker', now: () => 20, sink: recorder.sink }) : undefined;
	const authorityTrace = traced ? createTrace({ runtimeId: 'authority-first', now: () => 7, sink: recorder.sink }) : undefined;
	const authority = createTodoAuthority(options(storage, authorityTrace));
	let requests = 0;
	let mutations = 0;
	let holdReply: ReturnType<typeof latch> | undefined;
	const requestIds: string[] = [];
	function request(input: Request, operationId?: string) {
		requests++;
		if (input.method === 'POST') { mutations++; if (operationId) requestIds.push(operationId); }
		// Independent local handlers, not a claim about remote Worker placement.
		return createWorkerApp({ trace: workerTrace, operationId,
			todoRepository: repository(authority, operationId), todoSnapshots$: authority.watch$(),
		}).fetch(input);
	}
	const service = createTodoService({ collectionId: 'local-trace',
		fetch: async (input, init, context) => {
			const response = await request(new Request(new URL(String(input), 'https://local-trace.test'), init), context?.operationId);
			if (init?.method === 'POST' && holdReply) await holdReply.ready;
			return response;
		},
		live: { retryDelaysMs: [], initialSnapshotTimeoutMs: 5_000,
			createEventSource: url => responseConnection(request, url) },
	});
	const model = createTodoModel({ collectionSource: 'live', collectionId: 'local-trace', trace: clientTrace, traceScope: 'app' });
	const scope = createScope();
	const recovery = new Subject<void>();
	let current!: State;
	const failures: unknown[] = [];
	function dispatch(action: Action) { model.dispatch(action); }
	function accept(event: LiveConnectionEvent<TodoLiveSnapshot>) {
		switch (event.type) {
			case 'connecting': dispatch({ type: 'LIVE_CONNECTING', connectionId: event.connectionId, attempt: event.attempt }); break;
			case 'snapshot': dispatch({ type: 'LIVE_SNAPSHOT', connectionId: event.connectionId, snapshot: event.value }); break;
			case 'reconnecting': dispatch({ type: 'LIVE_INTERRUPTED', connectionId: event.connectionId, attempt: event.attempt, retrying: true, delayMs: event.delayMs, message: event.message }); break;
			case 'failed': dispatch({ type: 'LIVE_INTERRUPTED', connectionId: event.connectionId, attempt: event.attempt, retrying: false, message: event.message }); break;
		}
	}
	const errors = { error: (error: unknown) => failures.push(error) };
	scope.subscribe(model.state$, { next: value => { current = value; }, ...errors });
	// More readers of already-owned state must not create another effect execution.
	scope.subscribe(model.state$, errors);
	scope.subscribe(model.viewModel$, errors);
	scope.subscribe(todoEffects$(model.transitions$, service, { trace: clientTrace, traceScope: 'app' }), { next: dispatch, ...errors });
	model.start();
	scope.subscribe(service.live$!(recovery), { next: accept, ...errors });
	try {
		await expect.poll(() => current.connection).toBe('connected');
		dispatch({ type: 'DRAFT_CHANGED', value: 'Private title one' });
		dispatch({ type: 'CREATE_REQUESTED', title: 'Private title one' });
		await expect.poll(() => [current.todos.length, current.pending.length]).toEqual([1, 0]);
		const completed = recorder.records();
		holdReply = latch();
		dispatch({ type: 'DRAFT_CHANGED', value: 'Private title two' });
		dispatch({ type: 'CREATE_REQUESTED', title: 'Private title two' });
		await expect.poll(() => current.todos.length).toBe(2);
		expect(current.pending).toHaveLength(1);
		scope.dispose(); recovery.complete(); model.dispose();
		holdReply.release();
		await expect.poll(() => authority.resourceCounts()).toEqual({ active: 0, queued: 0, pending: 0, subscribers: 0 });
		const cancelled = recorder.records().slice(completed.length);
		const stored = storage.kv.get(TODO_SNAPSHOT_KEY);
		authority.dispose();
		const replacementTrace = traced ? createTrace({ runtimeId: 'authority-replacement', now: () => 2, sink: recorder.sink }) : undefined;
		const replacement = createTodoAuthority({ ...options(storage, replacementTrace), newStateGeneration: () => { throw new Error('Recovery must not reset history'); } });
		const restored = await firstValueFrom(replacement.watch$());
		expect(restored).toEqual(stored);
		replacement.dispose();
		expect(failures).toEqual([]);
		expect({ requests, mutations }).toEqual({ requests: 3, mutations: 2 });
		expect(JSON.stringify(recorder.records())).not.toContain('Private title');
		if (traced) {
			expect(requestIds).toHaveLength(2);
			const commit = completed.find(record => record.event === 'authority.commit' && record.operationId === requestIds[0])!;
			const publication = completed.find(record => record.event === 'authority.publish' && record.operationId === requestIds[0])!;
			expect(commit.sequence).toBeLessThan(publication.sequence);
			expect(commit).toMatchObject({ stateGeneration: 'persisted-generation', revision: 1 });
			expect(events(completed.filter(record => record.runtimeId === 'client'), requestIds[0])).toContain('effect.complete');
			expect(events(cancelled.filter(record => record.runtimeId === 'client'), requestIds[1])).toContain('effect.cancel');
			expect(events(cancelled.filter(record => record.runtimeId === 'client'), requestIds[1])).not.toContain('effect.complete');
			const recovered = recorder.records().filter(record => record.runtimeId === 'authority-replacement');
			expect(recovered.find(record => record.event === 'authority.recovered')).toMatchObject({ stateGeneration: 'persisted-generation', revision: 2 });
			expect(recovered.some(record => record.event === 'authority.commit')).toBe(false);
			const liveResources = recorder.records().filter(record => record.sourceId === 'http.live' && record.event === 'resource.state');
			expect(liveResources.at(-1)?.metadata).toMatchObject({ active: 0, listeners: 0, pendingEvents: 0, pendingBytes: 0 });

		}
		return { requests, mutations, restored, capture: traced ? { description: 'Local workerd: constructed client/Hono/authority core with real SQLite; fixed independent clocks; no remote routing assertion.', requests, mutations, completeOperation: completed, cancelledReply: cancelled, recovered: recorder.records().filter(record => record.runtimeId === 'authority-replacement'), finalAuthorityResources: authority.resourceCounts() } : undefined };
	} finally {
		holdReply?.release(); scope.dispose(); recovery.complete(); model.dispose(); authority.dispose();
	}
}

describe('M08 local causal trace through real workerd HTTP bodies and SQLite', () => {
	it('keeps complete-operation, lost-reply and reconstruction behavior identical with tracing enabled', async ({ task }) => {
		const plain = env.TODO_COLLECTIONS.getByName(`trace-control-${crypto.randomUUID()}`);
		const traced = env.TODO_COLLECTIONS.getByName(`trace-enabled-${crypto.randomUUID()}`);
		const control = await runInDurableObject(plain, (_instance, state) => clientAuthorityScenario(state.storage, false));
		const observed = await runInDurableObject(traced, (_instance, state) => clientAuthorityScenario(state.storage, true));
		expect({ ...observed, capture: undefined }).toEqual(control);
		// A reporter can export this actual bounded capture; no product logging or endpoint.
		(task.meta as { m08TraceCapture?: unknown }).m08TraceCapture = observed.capture;
	});

	it('does not trace commit/publication before flush settlement, even after its reply is canceled', async () => {
		const stub = env.TODO_COLLECTIONS.getByName(`trace-flush-${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			const recorder = createTraceRecorder();
			const trace = createTrace({ runtimeId: 'authority', now: () => 1, sink: recorder.sink });
			let hold: ReturnType<typeof latch> | undefined;
			const storage = new Proxy(state.storage, { get(target, key) {
				if (key === 'sync') return async () => { if (hold) await hold.ready; await target.sync(); };
				const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
			} });
			const authority = createTodoAuthority(options(storage, trace));
			const revisions: number[] = [];
			const watcher = authority.watch$().subscribe(snapshot => revisions.push(snapshot.revision));
			await expect.poll(() => revisions).toEqual([0]);
			hold = latch();
			const reply = authority.execute$({ kind: 'create', input: { title: 'Private held draft' } }, 'cancelled-operation').subscribe();
			reply.unsubscribe();
			expect(authority.resourceCounts()).toEqual({ active: 1, queued: 0, pending: 1, subscribers: 1 });
			expect(events(recorder.records(), 'cancelled-operation')).not.toContain('authority.commit');
			expect(revisions).toEqual([0]);
			hold.release();
			await expect.poll(() => revisions).toEqual([0, 1]);
			expect(events(recorder.records(), 'cancelled-operation')).toContain('authority.commit');
			watcher.unsubscribe(); authority.dispose();
			expect(authority.resourceCounts()).toEqual({ active: 0, queued: 0, pending: 0, subscribers: 0 });
		});
	});

	it('records rollback failure with no false commit/publication and releases affected live owners', async () => {
		const stub = env.TODO_COLLECTIONS.getByName(`trace-rollback-${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			const recorder = createTraceRecorder();
			const trace = createTrace({ runtimeId: 'authority', sink: recorder.sink });
			let failWrite = false;
			const storage = new Proxy(state.storage, { get(target, key) {
				if (key === 'kv') return new Proxy(target.kv, { get(kv, member) {
					if (member === 'put') return (key: string, value: unknown) => { kv.put(key, value); if (failWrite) throw new Error('Injected rollback after write'); };
					const value = Reflect.get(kv, member); return typeof value === 'function' ? value.bind(kv) : value;
				} });
				const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
			} });
			const authority = createTodoAuthority(options(storage, trace));
			const errors: unknown[] = [];
			const snapshots: TodoLiveSnapshot[] = [];
			authority.watch$().subscribe({ next: snapshot => snapshots.push(snapshot), error: error => errors.push(error) });
			await expect.poll(() => snapshots.length).toBe(1);
			failWrite = true;
			await expect(firstValueFrom(authority.execute$({ kind: 'create', input: { title: 'Private rollback' } }, 'rolled-back'))).rejects.toMatchObject({ status: 503, details: { outcome: 'not-committed' } });
			expect(storage.kv.get(TODO_SNAPSHOT_KEY)).toEqual(snapshots[0]);
			expect(events(recorder.records(), 'rolled-back')).not.toContain('authority.commit');
			expect(events(recorder.records(), 'rolled-back')).not.toContain('authority.publish');
			expect(recorder.records().find(record => record.event === 'authority.error')).toMatchObject({ operationId: 'rolled-back', metadata: { status: '503', outcome: 'not-committed' } });
			expect(errors).toHaveLength(1);
			expect(authority.resourceCounts()).toEqual({ active: 0, queued: 0, pending: 0, subscribers: 0 });
			authority.dispose();
		});
	});

	it('observes the actual bounded byte queue and signal listener without adding source subscriptions', async () => {
		for (const traced of [false, true]) {
			const recorder = createTraceRecorder();
			const trace = traced ? createTrace({ runtimeId: 'worker', sink: recorder.sink }) : undefined;
			const values = new Subject<number>();
			let subscriptions = 0;
			let active = 0;
			const source = new Observable<number>(observer => {
				subscriptions++; active++;
				const subscription = values.subscribe(observer);
				return () => { active--; subscription.unsubscribe(); };
			});
			const owner = createOwnedByteStream(source, { trace, signal: new AbortController().signal,
				encode: value => new TextEncoder().encode(String(value)), policy: 'latest-snapshot', maxPendingEvents: 1, maxPendingBytes: 4, maxFrameBytes: 4 });
			owner.start();
			for (let value = 0; value < 100; value++) values.next(value);
			expect(owner.resourceCounts()).toEqual({ active: 1, listener: 1, pendingEvents: 1, pendingBytes: 2 });
			const reader = owner.body.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe('99');
			await reader.cancel();
			expect({ subscriptions, active }).toEqual({ subscriptions: 1, active: 0 });
			expect(owner.resourceCounts()).toEqual({ active: 0, listener: 0, pendingEvents: 0, pendingBytes: 0 });
			if (traced) {
				const resources = recorder.records().filter(record => record.event === 'resource.state');
				expect(Math.max(...resources.map(record => record.metadata?.pendingEvents ?? 0))).toBe(1);
				expect(resources.at(-1)?.metadata).toMatchObject({ active: 0, listeners: 0, pendingEvents: 0, pendingBytes: 0 });
			}
		}
	});

	it.each(['throwing-context', 'reentrant-dispose'] as const)('keeps body cleanup safe for a %s diagnostic observer', async fault => {
		let owner!: ReturnType<typeof createOwnedByteStream<number>>;
		const trace = createTrace({ runtimeId: 'worker', sink(record) {
			if (fault === 'reentrant-dispose' && record.event === 'resource.state' && record.metadata?.reason === 'delivered') {
				owner.dispose(new Error('Intentional diagnostic disposal'));
			}
		} });
		const source = new Subject<number>();
		owner = createOwnedByteStream(source, { trace,
			traceContext: fault === 'throwing-context' ? { get scopeId(): string { throw new Error('Invalid context'); }, sourceId: 'test' } : undefined,
			encode: value => new TextEncoder().encode(String(value)), signal: new AbortController().signal });
		expect(() => owner.start()).not.toThrow();
		source.next(1); source.complete();
		const reader = owner.body.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('1');
		if (fault === 'reentrant-dispose') await expect(reader.read()).rejects.toThrow('Intentional diagnostic disposal');
		else expect((await reader.read()).done).toBe(true);
		expect(owner.resourceCounts()).toEqual({ active: 0, listener: 0, pendingEvents: 0, pendingBytes: 0 });
	});
});
