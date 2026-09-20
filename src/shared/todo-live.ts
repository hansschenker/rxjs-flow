import { z } from 'zod';

/** Version 1 publishes complete committed state, never a history of domain events. */
export const TODO_LIVE_PATH = '/todos/live';
export const TODO_LIVE_EVENT = 'todo-snapshot';
export const TODO_SNAPSHOT_LIMITS = Object.freeze({ maxTodos: 1_000, maxSnapshotBytes: 120 * 1_024 });

export const todoIdentitySchema = z.string().min(1).max(200);
export const strictLiveTodoSchema = z.strictObject({
	id: todoIdentitySchema,
	title: z.string().min(1),
	completed: z.boolean(),
	createdAt: z.iso.datetime(),
});

/** Logical history identity survives Durable Object reconstruction. */
export const todoLiveSnapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	collectionId: todoIdentitySchema,
	stateGeneration: todoIdentitySchema,
	revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	todos: z.array(strictLiveTodoSchema).max(TODO_SNAPSHOT_LIMITS.maxTodos),
}).superRefine((snapshot, context) => {
	if (new Set(snapshot.todos.map(todo => todo.id)).size !== snapshot.todos.length) {
		context.addIssue({ code: 'custom', message: 'Duplicate Todo identity' });
	}
});

export type TodoLiveSnapshot = z.infer<typeof todoLiveSnapshotSchema>;

/** Decode external values before they can enter the application state stream. */
export function decodeTodoLiveSnapshot(value: unknown): TodoLiveSnapshot {
	const snapshot = todoLiveSnapshotSchema.parse(value);
	if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > TODO_SNAPSHOT_LIMITS.maxSnapshotBytes) {
		throw new Error('Todo live snapshot exceeds capacity');
	}
	return snapshot;
}
