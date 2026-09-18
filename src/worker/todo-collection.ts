import { DurableObject } from 'cloudflare:workers';
import { firstValueFrom } from 'rxjs';
import { HttpError } from '../server/core/errors';
import { createTodoAuthority, type TodoAuthorityCommand, type TodoAuthorityResult } from '../server/todos/todo.authority';
import { createDurableTodoStorage } from './todo-storage';
import { createTodoLiveResponse } from './todo-live-response';
import { TODO_WATCH_PATH } from './todo-live';

export type TodoAuthorityReply =
	| { ok: true; result: TodoAuthorityResult }
	| { ok: false; status: number; message: string; details?: unknown };

/** The platform entry delegates all state transitions and ownership to functions. */
export class TodoCollection extends DurableObject<unknown> {
	private readonly authority;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		const collectionId = ctx.id.name;
		if (!collectionId) throw new Error('Todo authorities require a named collection');
		this.authority = createTodoAuthority({
			collectionId,
			storage: createDurableTodoStorage(ctx.storage),
			newTodoId: () => crypto.randomUUID(),
			newStateGeneration: () => crypto.randomUUID(),
			now: () => new Date().toISOString(),
		});
	}

	async execute(command: TodoAuthorityCommand): Promise<TodoAuthorityReply> {
		try {
			// Required RPC Promise conversion stays in this platform boundary.
			return { ok: true, result: await firstValueFrom(this.authority.execute$(command)) };
		} catch (error) {
			if (error instanceof HttpError) {
				return { ok: false, status: error.status, message: error.message, details: error.details };
			}
			return { ok: false, status: 503, message: 'Todo authority is unavailable', details: { outcome: 'unknown' } };
		}
	}

	/** Reachable only through a namespace capability selected after access policy. */
	fetch(request: Request): Response {
		if (request.method !== 'GET' || new URL(request.url).pathname !== TODO_WATCH_PATH) {
			return Response.json({ error: 'not_found' }, { status: 404 });
		}
		return createTodoLiveResponse(this.authority.watch$(), request.signal);
	}
}
