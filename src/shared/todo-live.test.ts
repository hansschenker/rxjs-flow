import { decodeTodoLiveSnapshot, TODO_SNAPSHOT_LIMITS, type TodoLiveSnapshot } from './todo-live';

const snapshot: TodoLiveSnapshot = {
	schemaVersion: 1, collectionId: 'local-reference', stateGeneration: 'persisted-history', revision: 12,
	todos: [{ id: '1', title: 'Shared live state', completed: false, createdAt: '2026-09-20T00:00:00.000Z' }],
};

describe('version 1 public Todo snapshots', () => {
	it('decodes a full history identity and copies the external object', () => {
		const decoded = decodeTodoLiveSnapshot(snapshot);
		expect(decoded).toEqual(snapshot);
		expect(decoded).not.toBe(snapshot);
		expect(decoded.todos[0]).not.toBe(snapshot.todos[0]);
	});

	it.each([
		['legacy bare array', snapshot.todos],
		['unknown version', { ...snapshot, schemaVersion: 2 }],
		['missing generation', { ...snapshot, stateGeneration: undefined }],
		['empty collection', { ...snapshot, collectionId: '' }],
		['oversized identity', { ...snapshot, stateGeneration: 'x'.repeat(201) }],
		['negative revision', { ...snapshot, revision: -1 }],
		['fractional revision', { ...snapshot, revision: 1.5 }],
		['unsafe revision', { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 }],
		['duplicate Todo identity', { ...snapshot, todos: [snapshot.todos[0], snapshot.todos[0]] }],
		['malformed Todo', { ...snapshot, todos: [{ ...snapshot.todos[0], completed: 'false' }] }],
		['extra envelope field', { ...snapshot, workerEpoch: 'not-authority' }],
		['extra Todo field', { ...snapshot, todos: [{ ...snapshot.todos[0], surprise: true }] }],
	])('rejects %s before admission', (_label, value) => {
		expect(() => decodeTodoLiveSnapshot(value)).toThrow();
	});

	it('bounds encoded bytes and Todo count before admission', () => {
		const oversize = { ...snapshot, todos: [{ ...snapshot.todos[0], title: '🌱'.repeat(TODO_SNAPSHOT_LIMITS.maxSnapshotBytes / 4) }] };
		expect(() => decodeTodoLiveSnapshot(oversize)).toThrow('exceeds capacity');
		const tooMany = { ...snapshot, todos: Array.from({ length: TODO_SNAPSHOT_LIMITS.maxTodos + 1 }, (_, index) => ({ ...snapshot.todos[0], id: String(index) })) };
		expect(() => decodeTodoLiveSnapshot(tooMany)).toThrow();
	});
});
