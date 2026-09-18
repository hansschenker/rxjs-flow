import { EMPTY, Observable, ReplaySubject, Subject, defer, type Subscription } from 'rxjs';
import { catchError, concatMap, finalize, single, tap } from 'rxjs/operators';
import { z } from 'zod';
import type { Todo } from '../../shared/types';
import { HttpError, UnprocessableEntity } from '../core/errors';
import { createTodoTransition, deleteTodoTransition, filterTodos, updateTodoTransition } from './todo.transitions';

export const TODO_AUTHORITY_LIMITS = Object.freeze({
	maxPendingOperations: 32,
	maxTodos: 1_000,
	maxSnapshotBytes: 120 * 1_024,
	maxActiveSubscribers: 0,
});

const identitySchema = z.string().min(1).max(200);
const strictTodoSchema = z.strictObject({
	id: identitySchema, title: z.string().min(1), completed: z.boolean(), createdAt: z.iso.datetime(),
});

/** Internal durable representation; the application live wire protocol remains M06. */
export const todoSnapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	collectionId: identitySchema,
	stateGeneration: identitySchema,
	revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	todos: z.array(strictTodoSchema).max(TODO_AUTHORITY_LIMITS.maxTodos),
}).superRefine((snapshot, context) => {
	if (new Set(snapshot.todos.map(todo => todo.id)).size !== snapshot.todos.length) {
		context.addIssue({ code: 'custom', message: 'Duplicate Todo identity' });
	}
});

export type TodoSnapshot = z.infer<typeof todoSnapshotSchema>;

export const todoAuthorityCommandSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('snapshot') }),
	z.strictObject({ kind: z.literal('list'), completed: z.boolean().optional() }),
	z.strictObject({ kind: z.literal('create'), input: z.strictObject({ title: z.string().min(1) }) }),
	z.strictObject({ kind: z.literal('update'), id: identitySchema, input: z.strictObject({
		title: z.string().min(1).optional(), completed: z.boolean().optional(),
	}) }),
	z.strictObject({ kind: z.literal('delete'), id: identitySchema }),
]);

export type TodoAuthorityCommand = z.infer<typeof todoAuthorityCommandSchema>;

export const todoAuthorityResultSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('snapshot'), snapshot: todoSnapshotSchema, value: z.null() }),
	z.strictObject({ kind: z.literal('list'), snapshot: todoSnapshotSchema, value: z.array(strictTodoSchema) }),
	z.strictObject({ kind: z.literal('create'), snapshot: todoSnapshotSchema, value: strictTodoSchema }),
	z.strictObject({ kind: z.literal('update'), snapshot: todoSnapshotSchema, value: strictTodoSchema }),
	z.strictObject({ kind: z.literal('delete'), snapshot: todoSnapshotSchema, value: z.null() }),
]);

export type TodoAuthorityResult = z.infer<typeof todoAuthorityResultSchema>;

export interface TodoAuthorityStorage {
	/**
	 * Run read + this synchronous callback + optional single-envelope write in one
	 * atomic storage transaction. Emit exactly once and complete AFTER durable
	 * settlement. Rollback on callback/write failure. Never retry the callback.
	 */
	transaction$: <T>(transition: (persisted: unknown | undefined) => {
		next?: TodoSnapshot;
		result: T;
	}) => Observable<T>;
}

export interface TodoAuthorityOptions {
	collectionId: string;
	storage: TodoAuthorityStorage;
	newTodoId: () => string;
	now: () => string;
	newStateGeneration: () => string;
	seedTodos?: () => Todo[];
	/** Total active + waiting operations, not just the concatMap waiting buffer. */
	maxPendingOperations?: number;
}

export interface TodoAuthority {
	execute$: (command: TodoAuthorityCommand | unknown) => Observable<TodoAuthorityResult>;
	dispose: () => void;
	resourceCounts: () => { active: number; queued: number; pending: number; subscribers: 0 };
}

interface AcceptedOperation {
	command: TodoAuthorityCommand;
	reply: ReplaySubject<TodoAuthorityResult>;
}

/** A single activation owns the bounded queue; atomic attached storage owns history. */
export function createTodoAuthority(options: TodoAuthorityOptions): TodoAuthority {
	identitySchema.parse(options.collectionId);
	const capacity = options.maxPendingOperations ?? TODO_AUTHORITY_LIMITS.maxPendingOperations;
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > TODO_AUTHORITY_LIMITS.maxPendingOperations) {
		throw new RangeError('Authority capacity must be between 1 and 32');
	}
	const ingress = new Subject<AcceptedOperation>();
	const pending = new Set<AcceptedOperation>();
	let active: AcceptedOperation | undefined;
	let owner: Subscription | undefined;
	let disposed = false;

	function executeOperation(operation: AcceptedOperation): Observable<TodoAuthorityResult> {
		return defer(() => {
			active = operation;
			return options.storage.transaction$(persisted => transitionStoredSnapshot(options, persisted, operation.command));
		}).pipe(
			// A storage adapter returning EMPTY/multiple values cannot acknowledge commit.
			single(),
			tap(result => { operation.reply.next(freezeResult(result)); operation.reply.complete(); }),
			catchError(error => {
				operation.reply.error(error instanceof HttpError ? error : todoStorageFailure('unknown'));
				return EMPTY;
			}),
			finalize(() => { pending.delete(operation); if (active === operation) active = undefined; }),
		);
	}

	function admit(commandValue: unknown, reply: ReplaySubject<TodoAuthorityResult>): void {
		if (disposed) { reply.error(todoStorageFailure('not-committed', 'Todo authority is inactive')); return; }
		const parsed = todoAuthorityCommandSchema.safeParse(commandValue);
		if (!parsed.success) { reply.error(new UnprocessableEntity('Invalid Todo operation', parsed.error.issues)); return; }
		if (pending.size >= capacity) {
			reply.error(new HttpError(503, 'Todo authority is busy', { code: 'TODO_AUTHORITY_BUSY', outcome: 'not-committed' }));
			return;
		}
		const operation = { command: parsed.data, reply };
		pending.add(operation);
		owner ??= ingress.pipe(concatMap(executeOperation)).subscribe();
		ingress.next(operation);
	}

	return {
		execute$: command => {
			const reply = new ReplaySubject<TodoAuthorityResult>(1);
			let started = false;
			return new Observable(observer => {
				const subscription = reply.subscribe(observer);
				if (!started) { started = true; admit(command, reply); }
				// The authority retains admitted operations even when a response disappears.
				return subscription;
			});
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const operation of pending) {
				operation.reply.error(todoStorageFailure(operation === active ? 'unknown' : 'not-committed', 'Todo authority is inactive'));
			}
			owner?.unsubscribe();
			ingress.complete();
			pending.clear();
			active = undefined;
		},
		resourceCounts: () => ({ active: active ? 1 : 0, queued: pending.size - (active ? 1 : 0), pending: pending.size, subscribers: 0 }),
	};
}

/** Known rollback and an uncertain storage/transport result are deliberately distinct. */
export function todoStorageFailure(outcome: 'not-committed' | 'unknown', message = 'Todo storage is unavailable'): HttpError {
	return new HttpError(503, message, { code: 'TODO_STORAGE_UNAVAILABLE', outcome });
}

export function decodeTodoSnapshot(value: unknown, collectionId?: string): TodoSnapshot {
	const parsed = todoSnapshotSchema.safeParse(value);
	if (!parsed.success || (collectionId !== undefined && parsed.data.collectionId !== collectionId)) {
		throw todoStorageFailure('not-committed', 'Stored Todo state is invalid');
	}
	assertSnapshotBudget(parsed.data, false);
	return parsed.data;
}

function transitionStoredSnapshot(
	options: TodoAuthorityOptions, persisted: unknown | undefined, command: TodoAuthorityCommand,
): { next?: TodoSnapshot; result: TodoAuthorityResult } {
	const initial = persisted === undefined;
	const snapshot = initial ? decodeTodoSnapshot({
		schemaVersion: 1, collectionId: options.collectionId, stateGeneration: options.newStateGeneration(), revision: 0,
		todos: options.seedTodos?.() ?? [],
	}, options.collectionId) : decodeTodoSnapshot(persisted, options.collectionId);

	if (command.kind === 'snapshot' || command.kind === 'list') {
		const result: TodoAuthorityResult = command.kind === 'snapshot'
			? { kind: 'snapshot', snapshot, value: null }
			: { kind: 'list', snapshot, value: filterTodos(snapshot.todos, command.completed) };
		return initial ? { next: snapshot, result } : { result };
	}
	if (snapshot.revision >= Number.MAX_SAFE_INTEGER) {
		throw new HttpError(507, 'Todo revision capacity reached', { outcome: 'not-committed' });
	}
	const transition = command.kind === 'create'
		? createTodoTransition(snapshot.todos, command.input, { id: options.newTodoId(), createdAt: options.now() })
		: command.kind === 'update'
			? updateTodoTransition(snapshot.todos, command.id, command.input)
			: deleteTodoTransition(snapshot.todos, command.id);
	const next: TodoSnapshot = { ...snapshot, revision: snapshot.revision + 1, todos: transition.todos };
	assertSnapshotBudget(next, true);
	// IDs/time are boundary inputs too: reject invalid injected values before commit.
	decodeTodoSnapshot(next, options.collectionId);
	const result: TodoAuthorityResult = command.kind === 'delete'
		? { kind: 'delete', snapshot: next, value: null }
		: { kind: command.kind, snapshot: next, value: transition.value as Todo };
	return { next, result };
}

function assertSnapshotBudget(snapshot: TodoSnapshot, mutation: boolean): void {
	if (snapshot.todos.length > TODO_AUTHORITY_LIMITS.maxTodos
		|| new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > TODO_AUTHORITY_LIMITS.maxSnapshotBytes) {
		throw mutation
			? new HttpError(507, 'Todo collection capacity reached', { outcome: 'not-committed' })
			: todoStorageFailure('not-committed', 'Stored Todo state exceeds capacity');
	}
}

function freezeResult(result: TodoAuthorityResult): TodoAuthorityResult {
	for (const todo of result.snapshot.todos) Object.freeze(todo);
	Object.freeze(result.snapshot.todos);
	Object.freeze(result.snapshot);
	if (Array.isArray(result.value)) { for (const todo of result.value) Object.freeze(todo); Object.freeze(result.value); }
	else if (result.value !== null) Object.freeze(result.value);
	return Object.freeze(result);
}
