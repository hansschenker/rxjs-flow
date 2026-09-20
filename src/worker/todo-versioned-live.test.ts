import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decodeTodoLiveSnapshot, TODO_LIVE_EVENT, type TodoLiveSnapshot } from '../shared/todo-live';
import type { TodoAuthority } from '../server/todos/todo.authority';
import { createWorkerApp } from './index';
import type { TodoCollection } from './todo-collection';
import { createDurableTodoSnapshots } from './todo-live';
import { createDurableTodoRepository } from './todo-repository';

function collection() {
	const id = `versioned-${crypto.randomUUID()}`;
	return { id, stub: env.TODO_COLLECTIONS.getByName(id) };
}

function handler(stub: DurableObjectStub<TodoCollection>, id: string) {
	return createWorkerApp({ todoRepository: createDurableTodoRepository(stub, id), todoSnapshots$: createDurableTodoSnapshots(stub, id) });
}

async function active(stub: DurableObjectStub<TodoCollection>): Promise<number> {
	return runInDurableObject(stub, instance => (instance as unknown as { authority: TodoAuthority }).authority.resourceCounts().subscribers);
}

async function subscribe(stub: DurableObjectStub<TodoCollection>, id: string) {
	const response = await handler(stub, id).request('/api/todos/live');
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('text/event-stream');
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let pending = '';
	return {
		cancel: () => reader.cancel().catch(() => {}),
		async next(): Promise<TodoLiveSnapshot> {
			while (!pending.includes('\n\n')) {
				const item = await reader.read();
				if (item.done) throw new Error('Versioned live response ended');
				pending += decoder.decode(item.value, { stream: true });
			}
			const end = pending.indexOf('\n\n');
			const lines = pending.slice(0, end).split('\n');
			pending = pending.slice(end + 2);
			expect(lines.find(line => line.startsWith('event:'))?.slice(6).trim()).toBe(TODO_LIVE_EVENT);
			return decodeTodoLiveSnapshot(JSON.parse(lines.find(line => line.startsWith('data:'))!.slice(5)));
		},
	};
}

async function create(stub: DurableObjectStub<TodoCollection>, id: string, title: string) {
	// Each operation deliberately constructs a different Hono request handler.
	const response = await handler(stub, id).request('/api/todos', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
	});
	expect(response.status).toBe(201);
	return await response.json() as { id: string; title: string };
}

describe('versioned Todo publication through real Durable Object and Hono responses', () => {
	it('supplies matching complete initial and committed snapshots to independent response owners', async () => {
		const { id, stub } = collection();
		const a = await subscribe(stub, id);
		const b = await subscribe(stub, id);
		try {
			const initial = await a.next();
			expect(initial).toMatchObject({ schemaVersion: 1, collectionId: id, revision: 0, todos: [] });
			expect(initial.stateGeneration).not.toBe('');
			expect(await b.next()).toEqual(initial);
			expect(await active(stub)).toBe(2);
			const written = await create(stub, id, 'One accepted mutation');
			const updated = await a.next();
			expect(updated.revision).toBe(1);
			expect(updated.stateGeneration).toBe(initial.stateGeneration);
			expect(updated.todos).toMatchObject([{ id: written.id, title: written.title }]);
			expect(await b.next()).toEqual(updated);
			await a.cancel();
			await expect.poll(() => active(stub)).toBe(1);
			await create(stub, id, 'Other consumer continues');
			expect((await b.next()).revision).toBe(2);
			const aAgain = await subscribe(stub, id);
			try {
				const current = await aAgain.next();
				expect(current.stateGeneration).toBe(initial.stateGeneration);
				expect(current.revision).toBe(2);
				expect(current.todos).toHaveLength(2);
			} finally { await aAgain.cancel(); }
		} finally { await a.cancel(); await b.cancel(); }
		await expect.poll(() => active(stub)).toBe(0);
	});

	it('reconstructs the same persisted history after authority eviction', async () => {
		const { id, stub } = collection();
		await create(stub, id, 'Before reconstruction');
		const first = await subscribe(stub, id);
		const previous = await first.next();
		await first.cancel();
		await expect.poll(() => active(stub)).toBe(0);
		await evictDurableObject(stub);
		const replacement = env.TODO_COLLECTIONS.getByName(id);
		const next = await subscribe(replacement, id);
		try {
			expect(await next.next()).toEqual(previous);
			await create(replacement, id, 'After reconstruction');
			const updated = await next.next();
			expect(updated.stateGeneration).toBe(previous.stateGeneration);
			expect(updated.revision).toBe(previous.revision + 1);
			expect(updated.todos).toHaveLength(2);
		} finally { await next.cancel(); }
		await expect.poll(() => active(replacement)).toBe(0);
	});

	it('creates a different generation only after explicit replacement of the persisted history', async () => {
		const { id, stub } = collection();
		await create(stub, id, 'Previous history');
		const first = await subscribe(stub, id);
		const previous = await first.next();
		await first.cancel();
		await expect.poll(() => active(stub)).toBe(0);
		// Test-only administration: M06 does not add a public reset or migration API.
		await runInDurableObject(stub, (_instance, state) => state.storage.deleteAll());
		await evictDurableObject(stub);
		const replacement = env.TODO_COLLECTIONS.getByName(id);
		const next = await subscribe(replacement, id);
		try {
			const reset = await next.next();
			expect(reset.collectionId).toBe(previous.collectionId);
			expect(reset.stateGeneration).not.toBe(previous.stateGeneration);
			expect(reset.revision).toBe(0);
			expect(reset.todos).toEqual([]);
		} finally { await next.cancel(); }
		await expect.poll(() => active(replacement)).toBe(0);
	});

	it('retains absence of capability as a finite 503 response', async () => {
		const response = await createWorkerApp().request('/api/todos/live');
		expect(response.status).toBe(503);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toMatchObject({ error: 'Todo live storage is not configured' });
	});
});
