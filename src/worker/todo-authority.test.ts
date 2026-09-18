import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { todoAuthorityResultSchema, type TodoAuthorityCommand, type TodoSnapshot } from '../server/todos/todo.authority';
import type { Todo } from '../shared/types';
import worker, { createWorkerApp, type ApplicationBindings } from './index';
import { createDurableTodoRepository } from './todo-repository';
import { createDurableTodoStorage, TODO_SNAPSHOT_KEY } from './todo-storage';
import type { TodoCollection } from './todo-collection';

function collection() {
	const id = `test-${crypto.randomUUID()}`;
	return { id, stub: env.TODO_COLLECTIONS.getByName(id) };
}

async function execute(stub: DurableObjectStub<TodoCollection>, command: TodoAuthorityCommand) {
	using reply = await stub.execute(command);
	expect(reply.ok).toBe(true);
	if (!reply.ok) throw new Error('Authority operation failed');
	return todoAuthorityResultSchema.parse(reply.result);
}

function caller(id: string) {
	return createWorkerApp({ todoRepository: createDurableTodoRepository(env.TODO_COLLECTIONS.getByName(id), id) });
}

function post(title: string): Request {
	return new Request('http://localhost/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
}

function snapshotWithTitle(snapshot: TodoSnapshot, title: string): TodoSnapshot {
	return { ...snapshot, revision: snapshot.revision + 1, todos: [...snapshot.todos, {
		id: crypto.randomUUID(), title, completed: false, createdAt: new Date().toISOString(),
	}] };
}

describe('SQLite Todo authority in workerd', () => {
	it('independent request handlers share the same named committed collection', async () => {
		const { id, stub } = collection();
		const first = caller(id);
		const second = caller(id);
		const response = await first.fetch(post('Shared between handlers'));
		expect(response.status).toBe(201);
		const created: Todo = await response.json();
		expect(await (await second.request('/api/todos')).json()).toEqual([created]);
		const current = await execute(stub, { kind: 'snapshot' });
		expect(current.snapshot).toMatchObject({ collectionId: id, revision: 1, todos: [created] });
	});

	it('different configured collection identities remain isolated', async () => {
		const first = collection();
		const second = collection();
		await caller(first.id).fetch(post('Only the first collection'));
		expect(await (await caller(second.id).request('/api/todos')).json()).toEqual([]);
		expect((await execute(first.stub, { kind: 'snapshot' })).snapshot.todos).toHaveLength(1);
		expect((await execute(second.stub, { kind: 'snapshot' })).snapshot.revision).toBe(0);
	});

	it('concurrent independent callers commit every accepted create without losing updates', async () => {
		const { id, stub } = collection();
		const replies = await Promise.all(Array.from({ length: 20 }, (_, index) =>
			caller(id).fetch(post(`Concurrent ${index}`)),
		));
		expect(replies.map(reply => reply.status)).toEqual(Array(20).fill(201));
		const current = (await execute(stub, { kind: 'snapshot' })).snapshot;
		expect(current.revision).toBe(20);
		expect(new Set(current.todos.map(todo => todo.title))).toEqual(new Set(Array.from({ length: 20 }, (_, index) => `Concurrent ${index}`)));
		expect(new Set(current.todos.map(todo => todo.id)).size).toBe(20);
	});

	it('concurrent field changes to one Todo read the latest committed state', async () => {
		const { stub } = collection();
		const created = await execute(stub, { kind: 'create', input: { title: 'Initial' } });
		if (created.kind !== 'create') throw new Error('Unexpected result kind');
		await Promise.all([
			execute(stub, { kind: 'update', id: created.value.id, input: { title: 'Renamed' } }),
			execute(stub, { kind: 'update', id: created.value.id, input: { completed: true } }),
		]);
		const current = (await execute(stub, { kind: 'snapshot' })).snapshot;
		expect(current.revision).toBe(3);
		expect(current.todos).toEqual([{ ...created.value, title: 'Renamed', completed: true }]);
	});

	it('reconstructs state, schema, generation and revision after actual local runtime eviction', async () => {
		const { id, stub } = collection();
		await execute(stub, { kind: 'create', input: { title: 'Survives eviction' } });
		const before = (await execute(stub, { kind: 'snapshot' })).snapshot;
		await evictDurableObject(stub);
		const replacement = env.TODO_COLLECTIONS.getByName(id);
		const after = (await execute(replacement, { kind: 'snapshot' })).snapshot;
		expect(after).toEqual(before);
		await execute(replacement, { kind: 'create', input: { title: 'After eviction' } });
		const next = (await execute(replacement, { kind: 'snapshot' })).snapshot;
		expect(next.stateGeneration).toBe(before.stateGeneration);
		expect(next.revision).toBe(before.revision + 1);
		expect(next.todos).toHaveLength(2);
	});

	it('persists collection state and ordering metadata as one attached record', async () => {
		const { stub } = collection();
		const result = await execute(stub, { kind: 'create', input: { title: 'One envelope' } });
		await runInDurableObject(stub, (_instance, state) => {
			expect(Array.from(state.storage.kv.list(), ([key]) => key)).toEqual([TODO_SNAPSHOT_KEY]);
			expect(state.storage.kv.get(TODO_SNAPSHOT_KEY)).toEqual(result.snapshot);
		});
	});

	it('rolls back a real SQLite write if the synchronous transaction throws after putting it', async () => {
		const { stub } = collection();
		const committed = (await execute(stub, { kind: 'create', input: { title: 'Committed before failure' } })).snapshot;
		await runInDurableObject(stub, async (_instance, state) => {
			const storage = state.storage;
			const failing = new Proxy(storage, { get(target, key) {
				if (key === 'kv') return new Proxy(target.kv, { get(kv, operation) {
					if (operation === 'put') return (key: string, value: unknown) => { kv.put(key, value); throw new Error('Injected after write'); };
					const value = Reflect.get(kv, operation); return typeof value === 'function' ? value.bind(kv) : value;
				} });
				const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
			} });
			const adapter = createDurableTodoStorage(failing);
			await expect(firstValueFrom(adapter.transaction$(() => ({ next: snapshotWithTitle(committed, 'Rolled back'), result: null })))).rejects.toMatchObject({ status: 503, details: { outcome: 'not-committed' } });
			expect(storage.kv.get(TODO_SNAPSHOT_KEY)).toEqual(committed);
		});
		expect((await execute(stub, { kind: 'snapshot' })).snapshot).toEqual(committed);
		await execute(stub, { kind: 'create', input: { title: 'Healthy after rollback' } });
		expect((await execute(stub, { kind: 'snapshot' })).snapshot.revision).toBe(2);
	});

	it('emits no storage result until the explicit durable flush settles', async () => {
		const { stub } = collection();
		const committed = (await execute(stub, { kind: 'snapshot' })).snapshot;
		await runInDurableObject(stub, async (_instance, state) => {
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			const proxy = new Proxy(state.storage, { get(target, key) {
				if (key === 'sync') return async () => { await gate; await target.sync(); };
				const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
			} });
			const values: string[] = [];
			const result = firstValueFrom(createDurableTodoStorage(proxy).transaction$(() => ({ next: snapshotWithTitle(committed, 'Flushed'), result: 'committed' })));
			void result.then(value => values.push(value));
			await Promise.resolve();
			expect(values).toEqual([]);
			release();
			expect(await result).toBe('committed');
		});
	});

	it('quarantines an activation after an injected flush failure instead of advertising buffered state', async () => {
		const { stub } = collection();
		const committed = (await execute(stub, { kind: 'snapshot' })).snapshot;
		await runInDurableObject(stub, async (_instance, state) => {
			const sync = vi.fn(async () => { throw new Error('Injected uncertain flush'); });
			const proxy = new Proxy(state.storage, { get(target, key) {
				if (key === 'sync') return sync;
				const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
			} });
			const adapter = createDurableTodoStorage(proxy);
			await expect(firstValueFrom(adapter.transaction$(() => ({ next: snapshotWithTitle(committed, 'Uncertain'), result: null })))).rejects.toMatchObject({ status: 503, details: { outcome: 'unknown' } });
			const read = vi.fn(value => ({ result: value }));
			await expect(firstValueFrom(adapter.transaction$(read))).rejects.toMatchObject({ status: 503, details: { outcome: 'unknown' } });
			expect(read).not.toHaveBeenCalled();
			expect(sync).toHaveBeenCalledTimes(1);
		});
	});

	it('rejects corrupted or unsupported persisted state rather than silently resetting history', async () => {
		const { stub } = collection();
		const before = (await execute(stub, { kind: 'snapshot' })).snapshot;
		await runInDurableObject(stub, (_instance, state) => state.storage.kv.put(TODO_SNAPSHOT_KEY, { ...before, schemaVersion: 99 }));
		await evictDurableObject(stub);
		using reply = await stub.execute({ kind: 'snapshot' });
		expect(reply).toMatchObject({ ok: false, status: 503, details: { outcome: 'not-committed' } });
		await runInDurableObject(stub, (_instance, state) => expect(state.storage.kv.get(TODO_SNAPSHOT_KEY)).toMatchObject({ schemaVersion: 99, stateGeneration: before.stateGeneration }));
	});

	it('does not replay a committed mutation whose RPC response was lost', async () => {
		const { id, stub } = collection();
		const executeLost = vi.fn(async (command: TodoAuthorityCommand) => {
			using reply = await stub.execute(command);
			expect(reply.ok).toBe(true);
			throw new Error('Injected response loss after commit');
		});
		const transport = { execute: executeLost } as unknown as DurableObjectStub<TodoCollection>;
		const repository = createDurableTodoRepository(transport, id);
		await expect(firstValueFrom(repository.create$({ title: 'Committed once' }))).rejects.toMatchObject({ status: 503, details: { outcome: 'unknown' } });
		expect(executeLost).toHaveBeenCalledTimes(1);
		const after = (await execute(stub, { kind: 'snapshot' })).snapshot;
		expect(after.revision).toBe(1);
		expect(after.todos.map(todo => todo.title)).toEqual(['Committed once']);
	});
});

describe('collection access before Durable Object selection', () => {
	function bindings(overrides: Partial<ApplicationBindings> = {}) {
		const getByName = vi.fn((name: string) => env.TODO_COLLECTIONS.getByName(name));
		return {
			getByName,
			env: { FOUNDATION_LABEL: 'test', TODO_ACCESS_POLICY: 'local-loopback', TODO_COLLECTION_ID: `policy-${crypto.randomUUID()}`, TODO_COLLECTIONS: { getByName } as unknown as DurableObjectNamespace<TodoCollection>, ...overrides },
		};
	}
	function fetch(request: Request, configuration: ApplicationBindings) {
		return worker.fetch(request as Parameters<typeof worker.fetch>[0], configuration, createExecutionContext());
	}

	it('default deployment policy stays closed even for a localhost request URL', async () => {
		const response = await exports.default.fetch('http://localhost/api/todos');
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'Todo access is not configured' });
	});

	it.each([
		['non-loopback', 'https://example.test/api/todos', {}],
		['foreign origin', 'http://localhost/api/todos', { origin: 'https://example.test' }],
		['cross-site browser request', 'http://localhost/api/todos', { 'sec-fetch-site': 'cross-site' }],
		['collection query', 'http://localhost/api/todos?collectionId=other', {}],
		['collection header', 'http://localhost/api/todos', { 'x-collection-id': 'other' }],
	])('denies %s before namespace selection', async (_label, url, headers) => {
		const configuration = bindings();
		const response = await fetch(new Request(url, { headers }), configuration.env);
		expect(response.status).toBe(403);
		expect(configuration.getByName).not.toHaveBeenCalled();
	});

	it('uses only the trusted configured collection and allows same-origin local requests', async () => {
		const configuration = bindings();
		const response = await fetch(new Request('http://localhost/api/todos', { headers: { origin: 'http://localhost' } }), configuration.env);
		expect(response.status).toBe(200);
		expect(configuration.getByName).toHaveBeenCalledExactlyOnceWith(configuration.env.TODO_COLLECTION_ID);
	});

	it('keeps health and unrelated routes independent of authority acquisition', async () => {
		const configuration = bindings();
		for (const path of ['/api/health', '/api/foundation', '/api/missing', '/api/collections/other/todos']) {
			const response = await fetch(new Request(`http://localhost${path}`), configuration.env);
			expect([200, 404]).toContain(response.status);
		}
		expect(configuration.getByName).not.toHaveBeenCalled();
	});

	it('returns a controlled failure when the namespace binding is absent', async () => {
		const configuration = bindings({ TODO_COLLECTIONS: undefined });
		const response = await fetch(new Request('http://localhost/api/todos'), configuration.env);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'Todo storage is not configured' });
	});

	it('releases an unread streaming body when the access policy rejects before execution', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream({ cancel });
		const configuration = bindings({ TODO_ACCESS_POLICY: 'disabled' });
		const response = await fetch(new Request('http://localhost/api/todos', { method: 'POST', body }), configuration.env);
		expect(response.status).toBe(503);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(configuration.getByName).not.toHaveBeenCalled();
	});

	it('opens the authorized live collection and releases it when its body is cancelled', async () => {
		const configuration = bindings();
		const response = await fetch(new Request('http://localhost/api/todos/stream'), configuration.env);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: todos');
		await reader.cancel();
		const stub = env.TODO_COLLECTIONS.getByName(configuration.env.TODO_COLLECTION_ID);
		await expect.poll(() => runInDurableObject(stub, instance =>
			(instance as unknown as { authority: { resourceCounts(): { subscribers: number } } }).authority.resourceCounts().subscribers,
		)).toBe(0);
	});
});
