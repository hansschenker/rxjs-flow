import { Observable, Subject, Subscriber, map, queueScheduler } from 'rxjs';
import type { Todo } from '../../shared/types';
import { decodeTodoLiveSnapshot, TODO_SNAPSHOT_LIMITS, type TodoLiveSnapshot } from '../../shared/todo-live';
import { HttpError } from '../core/errors';

export const NODE_MEMORY_PENDING_SNAPSHOTS = 32;

export interface TodoStore {
	getTodos: () => Todo[];
	setTodos: (todos: Todo[]) => void;
	reset: () => void;
	todos$: Observable<Todo[]>;
	/** One registration per response; reset interrupts the old history. */
	snapshot$: Observable<TodoLiveSnapshot>;
}

export interface TodoStoreOptions {
	collectionId?: string;
	newStateGeneration?: () => string;
}

const createSeed = (): Todo[] => [
	{ id: '1', title: 'Learn rxjs-stack', completed: false, createdAt: new Date().toISOString() },
];

interface MemoryCommit {
	/** Local delivery order only; never advertised as a collection generation. */
	sequence: number;
	snapshot: TodoLiveSnapshot;
}

export const createTodoStore = (options: TodoStoreOptions = {}): TodoStore => {
	const seed = createSeed();
	const newStateGeneration = options.newStateGeneration ?? (() => crypto.randomUUID());
	const collectionId = options.collectionId ?? 'node-memory';
	function createHistory(): TodoLiveSnapshot {
		return freezeSnapshot(decodeTodoLiveSnapshot({
			schemaVersion: 1, collectionId, stateGeneration: newStateGeneration(), revision: 0, todos: seed,
		}));
	}
	let current: MemoryCommit = { sequence: 0, snapshot: createHistory() };
	const publications = new Subject<MemoryCommit>();
	let pending = 0;

	function commit(snapshot: TodoLiveSnapshot): void {
		if (pending >= NODE_MEMORY_PENDING_SNAPSHOTS) throw new HttpError(503, 'Node memory publication capacity reached', { outcome: 'not-committed' });
		if (current.sequence >= Number.MAX_SAFE_INTEGER) throw new HttpError(507, 'Node memory sequence capacity reached', { outcome: 'not-committed' });
		current = { sequence: current.sequence + 1, snapshot };
		pending++;
		// Zero-delay queue scheduling serializes reentrant notifications. State is
		// already committed before setTodos returns and the finite reply settles.
		queueScheduler.schedule(function publish(value: MemoryCommit | undefined) {
			try { if (value) publications.next(value); } finally { pending--; }
		}, 0, current);
	}

	function snapshots(interruptOnReset: boolean): Observable<TodoLiveSnapshot> {
		return new Observable(observer => {
			const generation = current.snapshot.stateGeneration;
			let lastSequence = -1;
			function deliver(value: MemoryCommit): void {
				// A reentrant subscription may already replay a committed value whose
				// queued publication is still behind another consumer's notification.
				if (value.sequence <= lastSequence) return;
				if (interruptOnReset && value.snapshot.stateGeneration !== generation) {
					observer.error(new Error('Node memory history was reset; reconnect for the current snapshot'));
					return;
				}
				lastSequence = value.sequence;
				observer.next(value.snapshot);
			}
			const owner = new Subscriber<MemoryCommit>({ next: deliver, error: (error: unknown) => observer.error(error), complete: () => observer.complete() });
			observer.add(owner);
			publications.subscribe(owner);
			// Register first: a subscriber may synchronously issue a write while
			// consuming its initial snapshot, and that commit must remain visible.
			deliver(current);
		});
	}

	return {
		getTodos: () => copyTodos(current.snapshot.todos),
		setTodos: (todos: Todo[]) => {
			const next = { ...current.snapshot, revision: current.snapshot.revision + 1, todos };
			if (next.revision > Number.MAX_SAFE_INTEGER || todos.length > TODO_SNAPSHOT_LIMITS.maxTodos
				|| new TextEncoder().encode(JSON.stringify(next)).byteLength > TODO_SNAPSHOT_LIMITS.maxSnapshotBytes) {
				throw new HttpError(507, 'Todo collection capacity reached', { outcome: 'not-committed' });
			}
			commit(freezeSnapshot(decodeTodoLiveSnapshot(next)));
		},
		reset: () => {
			const next = createHistory();
			if (next.stateGeneration === current.snapshot.stateGeneration) throw new Error('Reset requires a new state generation');
			commit(next);
		},
		todos$: snapshots(false).pipe(map(snapshot => copyTodos(snapshot.todos))),
		snapshot$: snapshots(true),
	};
};

function copyTodos(todos: Todo[]): Todo[] {
	return todos.map(todo => ({ ...todo }));
}

function freezeSnapshot(snapshot: TodoLiveSnapshot): TodoLiveSnapshot {
	for (const todo of snapshot.todos) Object.freeze(todo);
	Object.freeze(snapshot.todos);
	return Object.freeze(snapshot);
}
