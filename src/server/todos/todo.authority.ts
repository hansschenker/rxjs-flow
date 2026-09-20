import { EMPTY, Observable, ReplaySubject, Subject, defer, type Subscriber, type Subscription } from 'rxjs';
import { catchError, concatMap, finalize, single, tap } from 'rxjs/operators';
import { z } from 'zod';
import type { Todo } from '../../shared/types';
import { TODO_SNAPSHOT_LIMITS, todoIdentitySchema, strictLiveTodoSchema, todoLiveSnapshotSchema } from '../../shared/todo-live';
import { HttpError, UnprocessableEntity } from '../core/errors';
import { createTodoTransition, deleteTodoTransition, filterTodos, updateTodoTransition } from './todo.transitions';

export const TODO_AUTHORITY_LIMITS = Object.freeze({
	maxPendingOperations: 32,
	...TODO_SNAPSHOT_LIMITS,
	maxActiveSubscribers: 32,
});

const identitySchema = todoIdentitySchema;
const strictTodoSchema = strictLiveTodoSchema;

/** Persistence and the versioned public snapshot use the same validated shape. */
export const todoSnapshotSchema = todoLiveSnapshotSchema;

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
	/** Includes subscriptions whose serialized initial snapshot is still waiting. */
	maxActiveSubscribers?: number;
}

export interface TodoAuthority {
	execute$: (command: TodoAuthorityCommand | unknown) => Observable<TodoAuthorityResult>;
	/** Each subscription owns a fresh registration, never the persisted state. */
	watch$: () => Observable<TodoSnapshot>;
	dispose: () => void;
	resourceCounts: () => { active: number; queued: number; pending: number; subscribers: number };
}

interface LiveRegistration {
	observer: Subscriber<TodoSnapshot>;
	ready: boolean;
}

type AcceptedOperation = {
	kind: 'execute';
	command: TodoAuthorityCommand;
	reply: ReplaySubject<TodoAuthorityResult>;
} | { kind: 'watch'; registration: LiveRegistration };

/** A single activation owns the bounded queue; atomic attached storage owns history. */
export function createTodoAuthority(options: TodoAuthorityOptions): TodoAuthority {
	identitySchema.parse(options.collectionId);
	const capacity = options.maxPendingOperations ?? TODO_AUTHORITY_LIMITS.maxPendingOperations;
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > TODO_AUTHORITY_LIMITS.maxPendingOperations) {
		throw new RangeError('Authority capacity must be between 1 and 32');
	}
	const liveCapacity = options.maxActiveSubscribers ?? TODO_AUTHORITY_LIMITS.maxActiveSubscribers;
	if (!Number.isSafeInteger(liveCapacity) || liveCapacity < 1 || liveCapacity > TODO_AUTHORITY_LIMITS.maxActiveSubscribers) {
		throw new RangeError('Authority subscriber capacity must be between 1 and 32');
	}
	const ingress = new Subject<AcceptedOperation>();
	const pending = new Set<AcceptedOperation>();
	const registrations = new Set<LiveRegistration>();
	let active: AcceptedOperation | undefined;
	let owner: Subscription | undefined;
	let disposed = false;

	function interruptLive(error: HttpError): void {
		// Snapshot the set: an error observer may synchronously reconnect. Its new
		// registration gets a fresh serialized read, not the interrupted stream.
		for (const registration of [...registrations]) failConsumer(registration.observer, error);
	}

	function executeOperation(operation: AcceptedOperation): Observable<TodoAuthorityResult> {
		if (operation.kind === 'watch' && operation.registration.observer.closed) {
			pending.delete(operation);
			return EMPTY;
		}
		return defer(() => {
			active = operation;
			const command = operation.kind === 'execute' ? operation.command : { kind: 'snapshot' as const };
			return options.storage.transaction$(persisted => transitionStoredSnapshot(options, persisted, command));
		}).pipe(
			// A storage adapter returning EMPTY/multiple values cannot acknowledge commit.
			single(),
			tap(result => {
				const committed = freezeResult(result);
				if (operation.kind === 'watch') {
					// Registration and initial emission share this queue turn. No later
					// mutation can commit between its read and attachment to live updates.
					operation.registration.ready = true;
					operation.registration.observer.next(committed.snapshot);
				} else {
					if (operation.command.kind === 'create' || operation.command.kind === 'update' || operation.command.kind === 'delete') {
						for (const registration of [...registrations]) {
							if (registration.ready) registration.observer.next(committed.snapshot);
						}
					}
					operation.reply.next(committed);
					operation.reply.complete();
				}
			}),
			catchError(error => {
				const failure = error instanceof HttpError ? error : todoStorageFailure('unknown');
				if (isStorageFailure(failure)) interruptLive(failure);
				if (operation.kind === 'execute') failConsumer(operation.reply, failure);
				else failConsumer(operation.registration.observer, failure);
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
		enqueue({ kind: 'execute', command: parsed.data, reply });
	}

	function enqueue(operation: AcceptedOperation): void {
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
		watch$: () => new Observable(observer => {
			if (observer.closed) return;
			if (disposed) { observer.error(todoStorageFailure('not-committed', 'Todo authority is inactive')); return; }
			if (registrations.size >= liveCapacity) {
				observer.error(new HttpError(503, 'Todo live subscriber capacity reached', { code: 'TODO_LIVE_BUSY' }));
				return;
			}
			if (pending.size >= capacity) {
				observer.error(new HttpError(503, 'Todo authority is busy', { code: 'TODO_AUTHORITY_BUSY', outcome: 'not-committed' }));
				return;
			}
			const registration: LiveRegistration = { observer, ready: false };
			// Attach cleanup before admission can synchronously read, emit or fail.
			observer.add(() => registrations.delete(registration));
			registrations.add(registration);
			enqueue({ kind: 'watch', registration });
			// A canceled queued registration keeps its bounded queue slot until
			// drained, then skips storage. Removing just the count would hide an
			// unbounded concatMap backlog under repeated connect/cancel attempts.
		}),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			interruptLive(todoStorageFailure('unknown', 'Todo authority is inactive'));
			for (const operation of pending) {
				if (operation.kind === 'execute') {
					failConsumer(operation.reply, todoStorageFailure(operation === active ? 'unknown' : 'not-committed', 'Todo authority is inactive'));
				}
			}
			owner?.unsubscribe();
			ingress.complete();
			pending.clear();
			active = undefined;
		},
		resourceCounts: () => ({ active: active ? 1 : 0, queued: pending.size - (active ? 1 : 0), pending: pending.size, subscribers: registrations.size }),
	};
}

/** Known rollback and an uncertain storage/transport result are deliberately distinct. */
export function todoStorageFailure(outcome: 'not-committed' | 'unknown', message = 'Todo storage is unavailable'): HttpError {
	return new HttpError(503, message, { code: 'TODO_STORAGE_UNAVAILABLE', outcome });
}

function isStorageFailure(error: HttpError): boolean {
	return typeof error.details === 'object' && error.details !== null
		&& 'code' in error.details && error.details.code === 'TODO_STORAGE_UNAVAILABLE';
}

function failConsumer(consumer: { error: (error: unknown) => void }, error: HttpError): void {
	try { consumer.error(error); }
	catch {
		// RxJS closes the consumer before running its finalizers. A faulty
		// consumer finalizer must not retain other live owners or stop the queue.
	}
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
