import { defer } from 'rxjs';
import { HttpError } from '../server/core/errors';
import { todoStorageFailure, type TodoAuthorityStorage } from '../server/todos/todo.authority';

export const TODO_SNAPSHOT_KEY = 'snapshot';

/** SQLite supplies atomicity; the authority's FIFO supplies bounded admission. */
export function createDurableTodoStorage(storage: DurableObjectStorage): TodoAuthorityStorage {
	let uncertain = false;
	return {
		transaction$: transition => defer(async () => {
			// A failed flush cannot turn a buffered record into an advertised commit.
			// Reject this activation until the runtime reconstructs it from storage.
			if (uncertain) throw todoStorageFailure('unknown');
			let result;
			try {
				result = storage.transactionSync(() => {
					const transaction = transition(storage.kv.get(TODO_SNAPSHOT_KEY));
					if (transaction.next !== undefined) storage.kv.put(TODO_SNAPSHOT_KEY, transaction.next);
					return transaction.result;
				});
			} catch (error) {
				// transactionSync rolls back when its synchronous callback throws.
				if (error instanceof HttpError) throw error;
				throw todoStorageFailure('not-committed');
			}
			try {
				await storage.sync();
			} catch {
				uncertain = true;
				throw todoStorageFailure('unknown');
			}
			return result;
		}),
	};
}
