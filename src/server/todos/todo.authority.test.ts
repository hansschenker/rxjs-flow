import { Observable, Subject, defer, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { Todo } from '../../shared/types';
import {
	TODO_AUTHORITY_LIMITS, createTodoAuthority, decodeTodoSnapshot, todoStorageFailure,
	type TodoAuthorityOptions, type TodoAuthorityResult, type TodoAuthorityStorage, type TodoSnapshot,
} from './todo.authority';

const time = '2026-09-18T10:00:00.000Z';
const seed: Todo = { id: 'seed', title: 'Learn rxjs-stack', completed: false, createdAt: time };

function envelope(overrides: Partial<TodoSnapshot> = {}): TodoSnapshot {
	return { schemaVersion: 1, collectionId: 'test', stateGeneration: 'history-one', revision: 0, todos: [], ...overrides };
}

/** Test-only atomic storage model. Production atomicity is separately verified in workerd. */
function storageModel(initial?: unknown) {
	let persisted = initial === undefined ? undefined : structuredClone(initial);
	let reads = 0;
	let writes = 0;
	let holds = false;
	let failNext = false;
	let loseNextResponse = false;
	let held: { release: () => void; fail: () => void } | undefined;
	const storage: TodoAuthorityStorage = {
		transaction$: transition => new Observable(observer => {
			reads += 1;
			const change = transition(persisted === undefined ? undefined : structuredClone(persisted));
			function finish() {
				if (failNext) { failNext = false; observer.error(todoStorageFailure('not-committed')); return; }
				if (change.next !== undefined) { persisted = structuredClone(change.next); writes += 1; }
				if (loseNextResponse) { loseNextResponse = false; observer.error(todoStorageFailure('unknown')); return; }
				observer.next(change.result);
				observer.complete();
			}
			if (holds) held = { release: finish, fail: () => observer.error(todoStorageFailure('not-committed')) };
			else finish();
		}),
	};
	return {
		storage, get: () => structuredClone(persisted), reads: () => reads, writes: () => writes,
		hold: () => { holds = true; },
		release: () => { const current = held; held = undefined; current?.release(); },
		failHeld: () => { const current = held; held = undefined; current?.fail(); },
		runImmediately: () => { holds = false; },
		failNext: () => { failNext = true; }, loseNextResponse: () => { loseNextResponse = true; },
	};
}

function authority(model: ReturnType<typeof storageModel>, overrides: Partial<TodoAuthorityOptions> = {}) {
	let id = 0;
	const options: TodoAuthorityOptions = {
		collectionId: 'test', storage: model.storage, newTodoId: vi.fn(() => `todo-${++id}`),
		now: vi.fn(() => time), newStateGeneration: vi.fn(() => 'history-one'), ...overrides,
	};
	return { core: createTodoAuthority(options), options };
}

const create = (title: string) => ({ kind: 'create' as const, input: { title } });

describe('durable Todo authority', () => {
	it('constructs authority and operation without reading storage or generating identity', async () => {
		const model = storageModel();
		const { core, options } = authority(model, { seedTodos: () => [seed] });
		const operation = core.execute$({ kind: 'list' });
		expect(model.reads()).toBe(0);
		expect(options.newStateGeneration).not.toHaveBeenCalled();
		const result = await firstValueFrom(operation);
		expect(result).toEqual({ kind: 'list', value: [seed], snapshot: envelope({ todos: [seed] }) });
		expect(model.get()).toEqual(result.snapshot);
		expect(model.writes()).toBe(1);
		expect(core.resourceCounts()).toEqual({ active: 0, queued: 0, pending: 0, subscribers: 0 });
	});

	it('reconstructs generation/revision/state without invoking fresh seed or generation factories', async () => {
		const model = storageModel();
		const first = authority(model);
		const created = await firstValueFrom(first.core.execute$(create('Persisted')));
		first.core.dispose();
		const seedTodos = vi.fn(() => [seed]);
		const second = authority(model, { newStateGeneration: vi.fn(() => 'wrong-history'), seedTodos });
		const restored = await firstValueFrom(second.core.execute$({ kind: 'snapshot' }));
		expect(restored.snapshot).toEqual(created.snapshot);
		expect(second.options.newStateGeneration).not.toHaveBeenCalled();
		expect(seedTodos).not.toHaveBeenCalled();
		expect(model.writes()).toBe(1);
	});

	it('independent storage instances and distinct collection identities remain isolated', async () => {
		const left = authority(storageModel());
		const right = authority(storageModel(), { collectionId: 'other' });
		await firstValueFrom(left.core.execute$(create('Only left')));
		const empty = await firstValueFrom(right.core.execute$({ kind: 'snapshot' }));
		expect(empty.snapshot).toMatchObject({ collectionId: 'other', revision: 0, todos: [] });
	});

	it('serializes a held commit and the next read/transition without losing concurrent writes', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core } = authority(model);
		const first = firstValueFrom(core.execute$(create('First')));
		const second = firstValueFrom(core.execute$(create('Second')));
		const read = firstValueFrom(core.execute$({ kind: 'snapshot' }));
		expect(model.reads()).toBe(1);
		expect(model.get()).toEqual(envelope());
		expect(core.resourceCounts()).toEqual({ active: 1, queued: 2, pending: 3, subscribers: 0 });
		model.release();
		expect((await first).snapshot.revision).toBe(1);
		expect(model.reads()).toBe(2);
		expect((model.get() as TodoSnapshot).todos.map(todo => todo.title)).toEqual(['First']);
		model.release();
		expect((await second).snapshot.revision).toBe(2);
		model.release();
		expect((await read).snapshot).toMatchObject({ revision: 2, todos: [{ title: 'First' }, { title: 'Second' }] });
		expect(core.resourceCounts().pending).toBe(0);
	});

	it('shares one accepted execution across simultaneous and late consumers', async () => {
		const model = storageModel();
		model.hold();
		const { core, options } = authority(model);
		const operation = core.execute$(create('Once'));
		const first = firstValueFrom(operation);
		const second = firstValueFrom(operation);
		model.release();
		expect(await first).toBe(await second);
		expect(await firstValueFrom(operation)).toBe(await first);
		expect(model.reads()).toBe(1);
		expect(model.writes()).toBe(1);
		expect(options.newTodoId).toHaveBeenCalledTimes(1);
	});

	it('caches operation failure instead of retrying when another observer subscribes', async () => {
		const model = storageModel(envelope());
		model.failNext();
		const { core } = authority(model);
		const operation = core.execute$(create('Failed'));
		await expect(firstValueFrom(operation)).rejects.toMatchObject({ status: 503, details: { outcome: 'not-committed' } });
		await expect(firstValueFrom(operation)).rejects.toMatchObject({ status: 503 });
		expect(model.reads()).toBe(1);
		expect(model.writes()).toBe(0);
	});

	it('retains active admission and completes a mutation after its caller unsubscribes', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core } = authority(model, { maxPendingOperations: 1 });
		const values: TodoAuthorityResult[] = [];
		const operation = core.execute$(create('Response lost'));
		const subscription = operation.subscribe(value => values.push(value));
		subscription.unsubscribe();
		expect(core.resourceCounts().pending).toBe(1);
		await expect(firstValueFrom(core.execute$(create('Rejected')))).rejects.toMatchObject({
			status: 503, details: { code: 'TODO_AUTHORITY_BUSY', outcome: 'not-committed' },
		});
		model.release();
		expect(values).toEqual([]);
		expect((model.get() as TodoSnapshot).todos[0].title).toBe('Response lost');
		expect((await firstValueFrom(operation)).snapshot.revision).toBe(1);
		expect(core.resourceCounts().pending).toBe(0);
	});

	it('retains accepted queued mutations after their response observers disconnect', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core } = authority(model);
		core.execute$(create('Active')).subscribe();
		const second = core.execute$(create('Queued')).subscribe();
		second.unsubscribe();
		model.release();
		model.release();
		expect((model.get() as TodoSnapshot).todos.map(todo => todo.title)).toEqual(['Active', 'Queued']);
		expect(core.resourceCounts().pending).toBe(0);
	});

	it('bounds active plus queued admission before any excess transition executes', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core, options } = authority(model, { maxPendingOperations: 2 });
		core.execute$(create('First')).subscribe();
		core.execute$(create('Second')).subscribe();
		await expect(firstValueFrom(core.execute$(create('Too many')))).rejects.toMatchObject({ status: 503 });
		expect(options.newTodoId).toHaveBeenCalledTimes(1);
		expect(core.resourceCounts()).toEqual({ active: 1, queued: 1, pending: 2, subscribers: 0 });
		model.release();
		model.release();
		expect(options.newTodoId).toHaveBeenCalledTimes(2);
	});

	it('never exposes an uncommitted snapshot and continues queued work after rollback', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core } = authority(model);
		const values: TodoAuthorityResult[] = [];
		const errors: unknown[] = [];
		core.execute$(create('Rolled back')).subscribe({ next: value => values.push(value), error: error => errors.push(error) });
		const next = firstValueFrom(core.execute$(create('Committed')));
		expect(values).toEqual([]);
		expect(model.get()).toEqual(envelope());
		model.failHeld();
		expect(errors).toMatchObject([{ status: 503, details: { outcome: 'not-committed' } }]);
		model.release();
		expect((await next).snapshot).toMatchObject({ revision: 1, todos: [{ title: 'Committed' }] });
		expect(values).toEqual([]);
	});

	it('distinguishes storage rollback from a commit whose response was lost without retry', async () => {
		const model = storageModel(envelope());
		const first = authority(model);
		model.loseNextResponse();
		const operation = first.core.execute$(create('Already committed'));
		await expect(firstValueFrom(operation)).rejects.toMatchObject({ details: { outcome: 'unknown' } });
		await expect(firstValueFrom(operation)).rejects.toMatchObject({ details: { outcome: 'unknown' } });
		expect(model.writes()).toBe(1);
		first.core.dispose();
		const restored = await firstValueFrom(authority(model).core.execute$({ kind: 'snapshot' }));
		expect(restored.snapshot).toMatchObject({ revision: 1, todos: [{ title: 'Already committed' }] });
	});

	it.each([
		['unknown version', { ...envelope(), schemaVersion: 2 }],
		['wrong collection', envelope({ collectionId: 'elsewhere' })],
		['missing generation', { ...envelope(), stateGeneration: '' }],
		['fractional revision', envelope({ revision: 0.5 })],
		['unsafe revision', envelope({ revision: Number.MAX_SAFE_INTEGER + 1 })],
		['invalid date', envelope({ todos: [{ ...seed, createdAt: 'today' }] })],
		['duplicate IDs', envelope({ todos: [seed, { ...seed }] })],
		['unknown persisted fields', { ...envelope(), transientSubscriptions: [] }],
		['null', null],
	])('rejects %s without resetting or overwriting stored history', async (_label, persisted) => {
		const model = storageModel(persisted);
		const { core, options } = authority(model);
		await expect(firstValueFrom(core.execute$({ kind: 'snapshot' }))).rejects.toMatchObject({ status: 503 });
		expect(model.get()).toEqual(persisted);
		expect(model.writes()).toBe(0);
		expect(options.newStateGeneration).not.toHaveBeenCalled();
	});

	it.each([
		{ kind: 'create', input: { title: '' } },
		{ kind: 'create', input: { title: 'Valid', id: 'untrusted' } },
		{ kind: 'delete', id: '' },
		{ kind: 'list', completed: 'true' },
		{ kind: 'reset' },
	])('validates untrusted operation %j before admitting or reading storage', async command => {
		const model = storageModel();
		await expect(firstValueFrom(authority(model).core.execute$(command))).rejects.toMatchObject({ status: 422 });
		expect(model.reads()).toBe(0);
	});

	it('copies accepted command data so callers cannot mutate a waiting operation', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core } = authority(model);
		core.execute$(create('First')).subscribe();
		const command = create('Accepted');
		const next = firstValueFrom(core.execute$(command));
		command.input.title = 'Changed after admission';
		model.release();
		model.release();
		expect((await next).value).toMatchObject({ title: 'Accepted' });
	});

	it('preserves existing CRUD/filter behavior and increments revision for each accepted mutation', async () => {
		const model = storageModel(envelope({ todos: [seed] }));
		const { core } = authority(model);
		const created = await firstValueFrom(core.execute$(create('Second')));
		expect(created.snapshot.revision).toBe(1);
		const updated = await firstValueFrom(core.execute$({ kind: 'update', id: 'seed', input: { completed: true } }));
		expect(updated.snapshot.revision).toBe(2);
		const filtered = await firstValueFrom(core.execute$({ kind: 'list', completed: true }));
		expect(filtered.value).toEqual([{ ...seed, completed: true }]);
		expect(filtered.snapshot.todos).toHaveLength(2);
		expect(filtered.snapshot.revision).toBe(2);
		const unchanged = await firstValueFrom(core.execute$({ kind: 'update', id: 'seed', input: {} }));
		expect(unchanged.snapshot.revision).toBe(3);
		const deleted = await firstValueFrom(core.execute$({ kind: 'delete', id: 'seed' }));
		expect(deleted.value).toBe(null);
		expect(deleted.snapshot.revision).toBe(4);
		await expect(firstValueFrom(core.execute$({ kind: 'delete', id: 'seed' }))).rejects.toMatchObject({ status: 404 });
		expect((model.get() as TodoSnapshot).revision).toBe(4);
	});

	it('freezes replayed responses so one consumer cannot change later committed observations', async () => {
		const model = storageModel();
		const operation = authority(model).core.execute$(create('Immutable replay'));
		const result = await firstValueFrom(operation);
		expect(() => { result.snapshot.todos[0].title = 'Corrupt'; }).toThrow();
		expect(() => { result.snapshot.revision = 700; }).toThrow();
		expect((await firstValueFrom(operation)).snapshot.todos[0].title).toBe('Immutable replay');
	});

	it('rejects full collection and UTF-8 byte overflow before storage is written', async () => {
		const todos = Array.from({ length: TODO_AUTHORITY_LIMITS.maxTodos }, (_, index) => ({ ...seed, id: `id-${index}`, title: 'x' }));
		const full = storageModel(envelope({ todos }));
		await expect(firstValueFrom(authority(full).core.execute$(create('One too many')))).rejects.toMatchObject({ status: 507 });
		expect(full.writes()).toBe(0);
		const oversized = storageModel(envelope());
		const title = '🦊'.repeat(TODO_AUTHORITY_LIMITS.maxSnapshotBytes / 4);
		await expect(firstValueFrom(authority(oversized).core.execute$(create(title)))).rejects.toMatchObject({ status: 507 });
		expect(oversized.writes()).toBe(0);
	});

	it('fails closed for an oversized persisted snapshot instead of resetting it', async () => {
		const initial = envelope({ todos: [{ ...seed, title: 'x'.repeat(TODO_AUTHORITY_LIMITS.maxSnapshotBytes) }] });
		const model = storageModel(initial);
		await expect(firstValueFrom(authority(model).core.execute$({ kind: 'snapshot' }))).rejects.toMatchObject({ status: 503 });
		expect(model.get()).toEqual(initial);
		expect(model.writes()).toBe(0);
	});

	it('rejects revision exhaustion without wrapping ordering metadata', async () => {
		const model = storageModel(envelope({ revision: Number.MAX_SAFE_INTEGER }));
		await expect(firstValueFrom(authority(model).core.execute$(create('No wrap')))).rejects.toMatchObject({ status: 507 });
		expect(model.writes()).toBe(0);
	});

	it('validates injected identity/time and rejects ID collision before commit', async () => {
		const invalid = storageModel(envelope());
		await expect(firstValueFrom(authority(invalid, { now: () => 'invalid' }).core.execute$(create('Bad clock')))).rejects.toMatchObject({ status: 503 });
		expect(invalid.writes()).toBe(0);
		const collision = storageModel(envelope({ todos: [seed] }));
		await expect(firstValueFrom(authority(collision, { newTodoId: () => seed.id }).core.execute$(create('Duplicate')))).rejects.toMatchObject({ status: 409 });
		expect(collision.writes()).toBe(0);
	});

	it('releases queued resources on dispose and labels active work uncertain', async () => {
		const model = storageModel(envelope());
		model.hold();
		const { core } = authority(model);
		const first = firstValueFrom(core.execute$(create('Active')));
		const second = firstValueFrom(core.execute$(create('Waiting')));
		core.dispose();
		core.dispose();
		await expect(first).rejects.toMatchObject({ details: { outcome: 'unknown' } });
		await expect(second).rejects.toMatchObject({ details: { outcome: 'not-committed' } });
		await expect(firstValueFrom(core.execute$(create('Inactive')))).rejects.toMatchObject({ status: 503 });
		expect(core.resourceCounts()).toEqual({ active: 0, queued: 0, pending: 0, subscribers: 0 });
		model.release(); // A platform commit may finish despite subscription disposal.
		expect((model.get() as TodoSnapshot).todos.map(todo => todo.title)).toEqual(['Active']);
		expect(model.reads()).toBe(1);
	});

	it('contains synchronous storage construction faults and permits a later operation', async () => {
		const model = storageModel(envelope());
		const real = model.storage.transaction$;
		let fail = true;
		model.storage.transaction$ = transition => {
			if (fail) { fail = false; throw new Error('Storage construction failed'); }
			return real(transition);
		};
		const { core } = authority(model);
		await expect(firstValueFrom(core.execute$(create('Failed')))).rejects.toMatchObject({ details: { outcome: 'unknown' } });
		expect((await firstValueFrom(core.execute$(create('Recovered')))).snapshot.revision).toBe(1);
	});

	it('requires storage to complete before acknowledging its candidate result', async () => {
		const results = new Subject<TodoAuthorityResult>();
		const storage: TodoAuthorityStorage = { transaction$: <T>() => results as unknown as Observable<T> };
		const { core } = authority(storageModel(), { storage });
		const seen: TodoAuthorityResult[] = [];
		core.execute$({ kind: 'snapshot' }).subscribe(value => seen.push(value));
		results.next({ kind: 'snapshot', snapshot: envelope(), value: null });
		expect(seen).toEqual([]);
		results.complete();
		expect(seen).toHaveLength(1);
		expect(core.resourceCounts().pending).toBe(0);
	});

	it.each(['empty', 'multiple'] as const)('rejects %s storage settlement without a committed response', async cardinality => {
		const storage: TodoAuthorityStorage = { transaction$: <T>() => defer(() => {
			return cardinality === 'empty' ? of() : of({} as T, {} as T);
		}) };
		const { core } = authority(storageModel(), { storage });
		await expect(firstValueFrom(core.execute$({ kind: 'snapshot' }))).rejects.toMatchObject({ status: 503 });
		expect(core.resourceCounts().pending).toBe(0);
	});

	it('withholds a candidate followed by storage failure instead of advertising a committed snapshot', async () => {
		const results = new Subject<TodoAuthorityResult>();
		const storage: TodoAuthorityStorage = { transaction$: <T>() => results as unknown as Observable<T> };
		const { core } = authority(storageModel(), { storage });
		const seen: TodoAuthorityResult[] = [];
		const errors: unknown[] = [];
		core.execute$({ kind: 'snapshot' }).subscribe({ next: value => seen.push(value), error: error => errors.push(error) });
		results.next({ kind: 'snapshot', snapshot: envelope(), value: null });
		results.error(todoStorageFailure('unknown'));
		expect(seen).toEqual([]);
		expect(errors).toMatchObject([{ status: 503, details: { outcome: 'unknown' } }]);
		expect(core.resourceCounts().pending).toBe(0);
	});

	it.each([0, -1, 1.5, 33, Infinity])('rejects invalid admission capacity %s at construction', capacity => {
		expect(() => authority(storageModel(), { maxPendingOperations: capacity })).toThrow(RangeError);
	});

	it('decodes snapshot identity strictly without accepting arbitrary structural assertions', () => {
		expect(decodeTodoSnapshot(envelope(), 'test')).toEqual(envelope());
		expect(() => decodeTodoSnapshot(envelope(), 'wrong')).toThrow('Stored Todo state is invalid');
	});
});
