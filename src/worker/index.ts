import { Hono } from 'hono';
import {
	defer, firstValueFrom, fromEvent, of, takeUntil, timeout, TimeoutError,
	type Observable,
} from 'rxjs';
import { foundationPath, type FoundationResult } from '../shared/foundation';

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
	// In particular /api/todos is not a migrated or implicitly public route.
	app.notFound(function notFound(context) {
		return context.json({ error: 'not_found' }, 404);
	});
	return app;
}

export default { fetch: createFoundationApp().fetch } satisfies ExportedHandler<WorkerEnv>;
