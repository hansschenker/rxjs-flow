import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { HttpError } from '../core/errors';
import { createTestRequest } from '../core/testing';
import { createTodoEffects } from './todo.effect';
import { createMemoryTodoRepository, type TodoRepository } from './todo.repository';
import { createTodoStore } from './todo.store-factory';
import type { Todo } from '../../shared/types';

const todo: Todo = { id: 'committed', title: 'Saved', completed: false, createdAt: '2026-09-18T00:00:00.000Z' };

function repository(overrides: Partial<TodoRepository> = {}): TodoRepository {
	return {
		list$: () => of([todo]), create$: () => of(todo),
		update$: () => of(todo), delete$: () => of(undefined), ...overrides,
	};
}

function request(capability: TodoRepository, body: unknown = { title: 'Saved' }) {
	return createTestRequest({ body, params: { id: todo.id }, context: { services: { todoRepository: capability }, state: {} } });
}

describe('Todo effects with a finite repository capability', () => {
	it('does not acknowledge a create before the repository reports its committed result', () => {
		const commit = new Subject<Todo>();
		const next = vi.fn();
		const error = vi.fn();
		const subscription = createTodoEffects().create$(of(request(repository({ create$: () => commit })))).subscribe({ next, error });
		expect(error).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
		commit.next(todo);
		commit.complete();
		expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 201, body: todo }));
		expect(subscription.closed).toBe(true);
	});

	it('reports a failed storage operation without a successful response or retry', async () => {
		const fail = vi.fn(() => throwError(() => new HttpError(503, 'Storage unavailable')));
		await expect(firstValueFrom(createTodoEffects().create$(of(request(repository({ create$: fail }))))))
			.rejects.toMatchObject({ status: 503, message: 'Storage unavailable' });
		expect(fail).toHaveBeenCalledTimes(1);
	});

	it('forwards the validated completed filter to the capability', async () => {
		const list = vi.fn(() => of([]));
		await firstValueFrom(createTodoEffects().getAll$(of({ ...request(repository({ list$: list })), query: { completed: 'true' } })));
		expect(list).toHaveBeenCalledExactlyOnceWith(true);
	});

	it('waits for the delete result before producing the empty 204 response', () => {
		const commit = new Subject<void>();
		const next = vi.fn();
		const error = vi.fn();
		createTodoEffects().delete$(of(request(repository({ delete$: () => commit })))).subscribe({ next, error });
		expect(error).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
		commit.next();
		commit.complete();
		expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 204 }));
	});

	it('releases its repository subscription on request disposal', () => {
		const commit = new Subject<Todo>();
		const subscription = createTodoEffects().create$(of(request(repository({ create$: () => commit })))).subscribe({ error: () => undefined });
		expect(commit.observed).toBe(true);
		subscription.unsubscribe();
		expect(commit.observed).toBe(false);
	});

	it('rejects malformed input before the storage capability runs', async () => {
		const create = vi.fn(() => of(todo));
		await expect(firstValueFrom(createTodoEffects().create$(of(request(repository({ create$: create }), { title: 42 })))))
			.rejects.toMatchObject({ status: 422 });
		expect(create).not.toHaveBeenCalled();
	});
});

describe('retained in-memory repository', () => {
	it('remains inert until subscribed and uses injected IDs and time', async () => {
		const store = createTodoStore();
		const before = store.getTodos();
		const metadata = { newTodoId: vi.fn(() => 'test-id'), now: vi.fn(() => todo.createdAt) };
		const capability = createMemoryTodoRepository(store, metadata);
		const operation = capability.create$({ title: 'New' });
		expect(metadata.newTodoId).not.toHaveBeenCalled();
		expect(store.getTodos()).toEqual(before);
		expect(await firstValueFrom(operation)).toEqual({ id: 'test-id', title: 'New', completed: false, createdAt: todo.createdAt });
		expect(metadata.newTodoId).toHaveBeenCalledTimes(1);
	});

	it('keeps independent factories isolated across create, update, and delete', async () => {
		const firstStore = createTodoStore();
		const secondStore = createTodoStore();
		const first = createMemoryTodoRepository(firstStore, { newTodoId: () => 'only-first', now: () => todo.createdAt });
		const second = createMemoryTodoRepository(secondStore);
		const unchanged = await firstValueFrom(second.list$());
		const created = await firstValueFrom(first.create$({ title: 'Only first' }));
		await firstValueFrom(first.update$(created.id, { completed: true }));
		expect(await firstValueFrom(first.list$(true))).toEqual([{ ...created, completed: true }]);
		expect(await firstValueFrom(second.list$())).toEqual(unchanged);
		await firstValueFrom(first.delete$(created.id));
		expect(await firstValueFrom(second.list$())).toEqual(unchanged);
	});
});
