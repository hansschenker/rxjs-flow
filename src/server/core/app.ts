import { map } from 'rxjs/operators';
import { bootstrapWithOptions, type BootstrapOptions, type ServerSubscription } from './bootstrap';
import { createRouter, get, type RouteDefinition } from './router';
import { json } from './response';
import type { AppContext, Effect, Middleware } from './types';

export interface AppOptions<TServices extends Record<string, unknown>> {
	services?: TServices;
	middlewares?: Middleware[];
	cors?: (effect: Effect) => Effect;
	auth?: (effect: Effect) => Effect;
	onStart?: Array<(context: AppContext<TServices>) => void | Promise<void>>;
	onStop?: Array<(context: AppContext<TServices>) => void | Promise<void>>;
	includeHealthRoutes?: boolean;
	request?: BootstrapOptions;
}

export interface App<TServices extends Record<string, unknown>> {
	context: AppContext<TServices>;
	routes: RouteDefinition[];
	router: Effect;
	start: (port: number) => Promise<ServerSubscription>;
	stop: () => Promise<void>;
}

export const createApp = <TServices extends Record<string, unknown> = Record<string, unknown>>(
	routes: RouteDefinition[],
	options: AppOptions<TServices> = {},
): App<TServices> => {
	const context: AppContext<TServices> = {
		services: (options.services ?? {}) as TServices,
		state: {},
	};
	const allRoutes = options.includeHealthRoutes === false
		? routes
		: [
			get('/health', req$ => req$.pipe(map(() => json({ status: 'ok' })))),
			get('/ready', req$ => req$.pipe(map(() => json({ status: 'ready' })))),
			...routes,
		];
	const baseRouter = createRouter(allRoutes, context);
	const authRouter = options.auth ? options.auth(baseRouter) : baseRouter;
	const router     = options.cors ? options.cors(authRouter) : authRouter;
	let subscription: ServerSubscription | null = null;
	let starting: Promise<ServerSubscription> | null = null;
	let stopping: Promise<void> | null = null;
	let stopRequested = false;
	let startedHooks = false;

	const start = (port: number): Promise<ServerSubscription> => {
		if (starting || subscription || stopping || startedHooks) return Promise.reject(new Error('Application already started or changing lifecycle'));
		stopRequested = false;
		const activate = async (): Promise<ServerSubscription> => {
			startedHooks = true;
			for (const hook of options.onStart ?? []) {
				if (stopRequested) throw new Error('Application start canceled');
				await hook(context);
			}
			if (stopRequested) throw new Error('Application start canceled');
			const server = bootstrapWithOptions(port, router, options.request ?? {}, ...(options.middlewares ?? []));
			subscription = server;
			try {
				await server.ready;
				if (stopRequested) throw new Error('Application start canceled');
				return server;
			} catch (error) {
				server.unsubscribe();
				await server.stopped;
				if (subscription === server) subscription = null;
				throw error;
			}
		};
		starting = Promise.resolve().then(activate).finally(() => { starting = null; });
		return starting;
	};

	const stop = (): Promise<void> => {
		if (stopping) return stopping;
		if (!starting && !subscription && !startedHooks) return Promise.resolve();
		stopRequested = true;
		// Abort transport immediately, then await any startup hook currently in
		// flight before running stop hooks. Arbitrary user hooks are not cancelable.
		subscription?.unsubscribe();
		const deactivate = async (): Promise<void> => {
			try { await starting; } catch { /* Startup failure is returned by start(). */ }
			const server = subscription;
			server?.unsubscribe();
			await server?.stopped;
			subscription = null;
			if (startedHooks) {
				startedHooks = false;
				const failures: unknown[] = [];
				for (const hook of options.onStop ?? []) {
					try { await hook(context); } catch (error) { failures.push(error); }
				}
				if (failures.length > 0) throw new AggregateError(failures, 'Application stop hooks failed');
			}
		};
		stopping = deactivate().finally(() => { stopping = null; });
		return stopping;
	};

	return {
		context,
		routes: allRoutes,
		router,
		start,
		stop,
	};
};
