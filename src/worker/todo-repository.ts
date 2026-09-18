import { defer, map } from 'rxjs';
import { z } from 'zod';
import { HttpError } from '../server/core/errors';
import type { TodoRepository } from '../server/todos/todo.repository';
import { todoAuthorityResultSchema, type TodoAuthorityCommand, type TodoAuthorityResult } from '../server/todos/todo.authority';
import { todoListSchema, todoSchema } from '../shared/todo.schema';
import type { TodoCollection } from './todo-collection';

const authorityReplySchema = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), result: todoAuthorityResultSchema }),
	z.object({ ok: z.literal(false), status: z.number().int().min(400).max(599), message: z.string(), details: z.unknown().optional() }),
]);

/** A request receives a cold capability, never a fresh database or cached snapshot. */
export function createDurableTodoRepository(stub: DurableObjectStub<TodoCollection>, collectionId: string): TodoRepository {
	const execute$ = (command: TodoAuthorityCommand) => defer(async (): Promise<TodoAuthorityResult> => {
		let decodedReply;
		try {
			// RPC has no rollback/cancel protocol. Unsubscribe stops local delivery;
			// an operation accepted by the authority retains ownership to settlement.
			using reply = await stub.execute(command);
			decodedReply = authorityReplySchema.safeParse(reply);
		} catch {
			// The response may have been lost after commit. Never retry a mutation.
			throw new HttpError(503, 'Todo authority response was lost', { outcome: 'unknown' });
		}
		if (!decodedReply.success) throw new HttpError(503, 'Todo authority response is invalid', { outcome: 'unknown' });
		const reply = decodedReply.data;
		if (!reply.ok) throw new HttpError(reply.status, reply.message, reply.details);
		const decoded = todoAuthorityResultSchema.safeParse(reply.result);
		if (!decoded.success || decoded.data.kind !== command.kind || decoded.data.snapshot.collectionId !== collectionId) {
			throw new HttpError(503, 'Todo authority response is invalid', { outcome: 'unknown' });
		}
		return decoded.data;
	});
	return {
		list$: completed => execute$({ kind: 'list', completed }).pipe(map(result => todoListSchema.parse(result.value))),
		create$: input => execute$({ kind: 'create', input }).pipe(map(result => todoSchema.parse(result.value))),
		update$: (id, input) => execute$({ kind: 'update', id, input }).pipe(map(result => todoSchema.parse(result.value))),
		delete$: id => execute$({ kind: 'delete', id }).pipe(map(() => undefined)),
	};
}
