import { firstValueFrom, of, take } from 'rxjs';
import { createRouter } from '../core/router';
import { createTodoRoutes } from './todo.routes';
import { createTodoStore, NODE_MEMORY_PENDING_SNAPSHOTS } from './todo.store-factory';
import { createMemoryTodoRepository } from './todo.repository';
import { createTodoEffects } from './todo.effect';
import type { HttpRequest } from '../core/types';
import { TODO_LIVE_EVENT, type TodoLiveSnapshot } from '../../shared/todo-live';

function request(store: ReturnType<typeof createTodoStore>, url = '/todos/live'): HttpRequest {
	return { method: 'GET', url, params: {}, query: {}, body: undefined, headers: {}, signal: new AbortController().signal,
		context: { services: { todoStore: store }, state: {} }, requestContext: { state: {} } };
}

describe('retained Node in-memory versioned history', () => {
	it('rotates generation on factory reconstruction while keeping the logical collection name', async () => {
		const first = await firstValueFrom(createTodoStore().snapshot$);
		const next = await firstValueFrom(createTodoStore().snapshot$);
		expect(first.collectionId).toBe('node-memory');
		expect(next.collectionId).toBe(first.collectionId);
		expect(next.stateGeneration).not.toBe(first.stateGeneration);
		expect(first.revision).toBe(0);
		expect(next.revision).toBe(0);
	});

	it('publishes each committed mutation once with one increasing revision', async () => {
		const store = createTodoStore();
		const repo = createMemoryTodoRepository(store, { newTodoId: () => 'created', now: () => '2026-09-20T00:00:00.000Z' });
		const values: TodoLiveSnapshot[] = [];
		const subscription = store.snapshot$.subscribe(snapshot => values.push(snapshot));
		await firstValueFrom(repo.create$({ title: 'Created' }));
		await firstValueFrom(repo.update$('created', { completed: true }));
		await firstValueFrom(repo.delete$('created'));
		subscription.unsubscribe();
		expect(values.map(snapshot => snapshot.revision)).toEqual([0, 1, 2, 3]);
		expect(new Set(values.map(snapshot => snapshot.stateGeneration)).size).toBe(1);
		expect(values[1].todos.filter(todo => todo.id === 'created')).toHaveLength(1);
		expect(values[2].todos.find(todo => todo.id === 'created')?.completed).toBe(true);
		expect(values[3].todos.some(todo => todo.id === 'created')).toBe(false);
		await expect(firstValueFrom(repo.delete$('missing'))).rejects.toMatchObject({ status: 404 });
		expect((await firstValueFrom(store.snapshot$)).revision).toBe(3);
	});

	it('interrupts old versioned registrations on reset and replays a new history on reconnect', async () => {
		let generation = 0;
		const store = createTodoStore({ newStateGeneration: () => `history-${++generation}` });
		const old: TodoLiveSnapshot[] = [];
		const failures: unknown[] = [];
		const subscription = store.snapshot$.subscribe({ next: value => old.push(value), error: error => failures.push(error) });
		store.setTodos([]);
		store.reset();
		expect(subscription.closed).toBe(true);
		expect(old.map(value => value.revision)).toEqual([0, 1]);
		expect(failures).toHaveLength(1);
		const replacement = await firstValueFrom(store.snapshot$);
		expect(replacement.stateGeneration).toBe('history-2');
		expect(replacement.revision).toBe(0);
		expect(replacement.todos).toHaveLength(1);
	});

	it('keeps legacy subscribers alive across a reset', () => {
		const store = createTodoStore();
		const lengths: number[] = [];
		const subscription = store.todos$.subscribe(todos => lengths.push(todos.length));
		store.setTodos([]);
		store.reset();
		expect(lengths).toEqual([1, 0, 1]);
		expect(subscription.closed).toBe(false);
		subscription.unsubscribe();
	});

	it('prevents consumers and caller aliases from mutating committed snapshot contents', async () => {
		const store = createTodoStore();
		const external = store.getTodos();
		store.setTodos(external);
		external[0].title = 'Changed outside authority';
		const snapshot = await firstValueFrom(store.snapshot$);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.todos)).toBe(true);
		expect(Object.isFrozen(snapshot.todos[0])).toBe(true);
		const legacy = await firstValueFrom(store.todos$);
		legacy[0].title = 'Changed legacy view';
		expect(store.getTodos()[0].title).toBe('Learn rxjs-stack');
	});

	it('registers distinct legacy and versioned endpoints without reinterpreting arrays', async () => {
		const store = createTodoStore();
		const context = { services: { todoStore: store }, state: {} };
		const router = createRouter(createTodoRoutes(), context);
		const versioned = await firstValueFrom(router(of(request(store))));
		const legacy = await firstValueFrom(router(of(request(store, '/todos/stream'))));
		const liveEvent = await firstValueFrom(versioned.stream!.pipe(take(1)));
		expect(liveEvent).toMatchObject({ event: TODO_LIVE_EVENT, data: { schemaVersion: 1, collectionId: 'node-memory', revision: 0 } });
		expect((await firstValueFrom(legacy.stream!)).data).toEqual(store.getTodos());
		expect(versioned.streamPolicy).toBe('latest-snapshot');
	});

	it('rejects a missing live capability before opening the stream', async () => {
		const store = createTodoStore();
		const input = { ...request(store), context: { services: {}, state: {} } };
		await expect(firstValueFrom(createTodoEffects().todoLive$(of(input)))).rejects.toMatchObject({ status: 503 });
	});

	it('delivers reentrant writes in increasing revision order to every observer', () => {
		const store = createTodoStore();
		const aValues: number[] = [];
		const bValues: number[] = [];
		const a = store.snapshot$.subscribe(snapshot => {
			aValues.push(snapshot.revision);
			if (snapshot.revision === 1) store.setTodos([]);
		});
		const b = store.snapshot$.subscribe(snapshot => bValues.push(snapshot.revision));
		store.setTodos(store.getTodos());
		expect(aValues).toEqual([0, 1, 2]);
		expect(bValues).toEqual([0, 1, 2]);
		a.unsubscribe(); b.unsubscribe();
	});

	it('replays the latest commit to a reentrant registration without duplicate or missed setup writes', () => {
		const store = createTodoStore();
		const lateValues: number[] = [];
		let late: ReturnType<typeof store.snapshot$.subscribe> | undefined;
		const first = store.snapshot$.subscribe(snapshot => {
			if (snapshot.revision !== 1) return;
			store.setTodos([]);
			late = store.snapshot$.subscribe(value => {
				lateValues.push(value.revision);
				if (value.revision === 2) store.setTodos([]);
			});
		});
		store.setTodos(store.getTodos());
		expect(lateValues).toEqual([2, 3]);
		first.unsubscribe(); late?.unsubscribe();
	});

	it('rejects capacity overflow before changing state or advertising a revision', async () => {
		const store = createTodoStore();
		const repository = createMemoryTodoRepository(store);
		const before = await firstValueFrom(store.snapshot$);
		const revisions: number[] = [];
		const subscription = store.snapshot$.subscribe(snapshot => revisions.push(snapshot.revision));
		await expect(firstValueFrom(repository.create$({ title: 'x'.repeat(120 * 1_024) }))).rejects.toMatchObject({ status: 507, details: { outcome: 'not-committed' } });
		expect(await firstValueFrom(store.snapshot$)).toEqual(before);
		expect(revisions).toEqual([0]);
		subscription.unsubscribe();
	});

	it('bounds active and queued reentrant publications without committing a rejected write', async () => {
		const store = createTodoStore();
		const failures: unknown[] = [];
		const revisions: number[] = [];
		const subscription = store.snapshot$.subscribe(snapshot => {
			revisions.push(snapshot.revision);
			if (snapshot.revision !== 1) return;
			for (let index = 0; index < NODE_MEMORY_PENDING_SNAPSHOTS; index++) {
				try { store.setTodos([]); } catch (error) { failures.push(error); }
			}
		});
		store.setTodos([]);
		expect(failures).toMatchObject([{ status: 503, details: { outcome: 'not-committed' } }]);
		expect(revisions).toEqual(Array.from({ length: NODE_MEMORY_PENDING_SNAPSHOTS + 1 }, (_, index) => index));
		expect((await firstValueFrom(store.snapshot$)).revision).toBe(NODE_MEMORY_PENDING_SNAPSHOTS);
		subscription.unsubscribe();
	});
});
