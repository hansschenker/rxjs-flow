import { Hono } from 'hono';
import {
	defer, firstValueFrom, fromEvent, of, takeUntil, timeout, TimeoutError,
	type Observable,
} from 'rxjs';
import { foundationPath, type FoundationResult } from '../shared/foundation';
import { get } from '../server/core/router';
import type { SseEvent } from '../server/core/types';
import { createTodoRoutes } from '../server/todos/todo.routes';
import type { TodoStore } from '../server/todos/todo.store-factory';
import type { TodoRepository } from '../server/todos/todo.repository';
import { HttpError } from '../server/core/errors';
import { cancelUnreadBody, createHonoApp } from './http-adapter';
import { authorizeTodoCollection, type TodoAccessBindings } from './todo-access';
import { createDurableTodoRepository } from './todo-repository';
import { createDurableTodoLive } from './todo-live';
import type { TodoCollection } from './todo-collection';
export { TodoCollection } from './todo-collection';

interface FoundationBindings {
	FOUNDATION_LABEL: string;
}

export type FoundationOperation = (label: string) => Observable<FoundationResult>;

/** A finite, subscription-driven probe; it does not touch the Todo authority. */
function foundation$(label: string): Observable<FoundationResult> {
	return of({ runtime: 'workerd', message: label });
}

function cancelledResponse(): Response {
	return Response.json({ error: 'request_cancelled' }, { status: 499 });
}

/** Route registration is inert. Each matching request owns one subscription. */
export function createFoundationApp(operation: FoundationOperation = foundation$) {
	const app = new Hono<{ Bindings: FoundationBindings }>();

	app.get(foundationPath, async function foundationRequest(context) {
		const signal = context.req.raw.signal;
		if (signal.aborted) return cancelledResponse();

		try {
			// Host-only Promise conversion. First value settles this probe and
			// unsubscribes; abort/error/empty/one-second deadline also release it.
			// takeUntil registers cancellation before synchronous source activation.
			const result = await firstValueFrom(
				defer(() => operation(context.env.FOUNDATION_LABEL)).pipe(
					timeout({ first: 1_000 }),
					takeUntil(fromEvent(signal, 'abort')),
				),
			);
			return context.json(result);
		} catch (error: unknown) {
			if (signal.aborted) return cancelledResponse();
			if (error instanceof TimeoutError) {
				return context.json({ error: 'foundation_timeout' }, 504);
			}
			return context.json({ error: 'foundation_operation_failed' }, 500);
		}
	});

	// Wrangler sends /api and /api/* here before its SPA asset fallback.
	// This isolated foundation probe intentionally exposes no Todo routes.
	app.notFound(function notFound(context) {
		return context.json({ error: 'not_found' }, 404);
	});
	return app;
}

export interface WorkerAppOptions {
	/** Explicitly injected capability; construction never creates a collection. */
	todoStore?: TodoStore;
	todoRepository?: TodoRepository;
	todoLive$?: Observable<SseEvent>;
	foundationLabel?: string;
}

/** Construction is inert; finite requests and live bodies own their capabilities. */
export function createWorkerApp(options: WorkerAppOptions = {}) {
	return createHonoApp([
		get('/foundation', () => of({ body: {
			runtime: 'workerd', message: options.foundationLabel ?? 'rxjs-flow foundation',
		} satisfies FoundationResult })),
		...createTodoRoutes(),
	], { services: {
		...(options.todoStore ? { todoStore: options.todoStore } : {}),
		...(options.todoRepository ? { todoRepository: options.todoRepository } : {}),
		...(options.todoLive$ ? { todoLive$: options.todoLive$ } : {}),
	} });
}

export interface ApplicationBindings extends TodoAccessBindings {
	FOUNDATION_LABEL: string;
	TODO_COLLECTIONS?: DurableObjectNamespace<TodoCollection>;
}

export default {
	fetch(request, env, context) {
		// Hono retains HTTP matching. Only Todo API requests acquire a capability.
		const path = new URL(request.url).pathname.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
		if (path === '/api/todos' || path.startsWith('/api/todos/')) {
			try {
				const collectionId = authorizeTodoCollection(request, env);
				if (!env.TODO_COLLECTIONS) throw new HttpError(503, 'Todo storage is not configured');
				const stub = env.TODO_COLLECTIONS.getByName(collectionId);
				return createWorkerApp({
					todoRepository: createDurableTodoRepository(stub, collectionId),
					todoLive$: createDurableTodoLive(stub, collectionId),
					foundationLabel: env.FOUNDATION_LABEL,
				}).fetch(request, env, context);
			} catch (error) {
				cancelUnreadBody(request);
				if (error instanceof HttpError) return Response.json({ error: error.message, details: error.details }, { status: error.status });
				return Response.json({ error: 'Todo authority is unavailable' }, { status: 503 });
			}
		}
		return createWorkerApp({ foundationLabel: env.FOUNDATION_LABEL }).fetch(request, env, context);
	},
} satisfies ExportedHandler<ApplicationBindings>;
