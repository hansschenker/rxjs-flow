import { Hono } from 'hono';
import {
	defer, firstValueFrom, fromEvent, of, takeUntil, timeout, TimeoutError,
	type Observable,
} from 'rxjs';
import { foundationPath, type FoundationResult } from '../shared/foundation';
import { get, flattenRoutes } from '../server/core/router';
import { createTodoRoutes } from '../server/todos/todo.routes';
import { createTodoStore, type TodoStore } from '../server/todos/todo.store-factory';
import { createHonoApp } from './http-adapter';

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
	foundationLabel?: string;
}

/** M05b migrates finite HTTP only. Durable authority and live bodies follow later. */
export function createWorkerApp(options: WorkerAppOptions = {}) {
	const todoRoutes = flattenRoutes(createTodoRoutes()).map(route => ({
		...route,
		effect: route.path === '/todos/stream'
			? () => of({ status: 501, body: { error: 'Streaming responses are not supported by this adapter' } })
			: options.todoStore
				? route.effect
				: () => of({ status: 503, body: { error: 'Todo storage is not configured' } }),
	}));
	return createHonoApp([
		get('/foundation', () => of({ body: {
			runtime: 'workerd', message: options.foundationLabel ?? 'rxjs-flow foundation',
		} satisfies FoundationResult })),
		...todoRoutes,
	], { services: options.todoStore ? { todoStore: options.todoStore } : {} });
}

// An explicit development-only binding enables a volatile local demo. The
// deployment configuration leaves this disabled; it is never durable authority.
let localDemo: ReturnType<typeof createWorkerApp> | undefined;

interface ApplicationBindings {
	FOUNDATION_LABEL: string;
	LOCAL_TODO_DEMO: string;
}

export default {
	fetch(request, env, context) {
		if (env.LOCAL_TODO_DEMO === 'enabled') {
			localDemo ??= createWorkerApp({
				todoStore: createTodoStore(), foundationLabel: env.FOUNDATION_LABEL,
			});
			return localDemo.fetch(request, env, context);
		}
		return createWorkerApp({ foundationLabel: env.FOUNDATION_LABEL }).fetch(request, env, context);
	},
} satisfies ExportedHandler<ApplicationBindings>;
