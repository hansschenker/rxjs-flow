// Each source emission activates exactly one finite request operation. Extra
// outcome consumers observe its replay; they never execute the router again.
import { defer, map, mergeMap, of, Subscription, type SchedulerLike } from 'rxjs';
import type { AddressInfo } from 'node:net';
import { createServer, prepareNodeResponse } from './http';
import { createRequestOperation } from './request-operation';
import type { Effect, Middleware } from './types';

export interface BootstrapOptions {
	deadlineMs?: number;
	scheduler?: SchedulerLike;
}

export interface ServerSubscription extends Subscription {
	ready: Promise<void>;
	stopped: Promise<void>;
	address: () => AddressInfo | null;
}

export const bootstrapWithOptions = (
	port: number,
	router: Effect,
	options: BootstrapOptions,
	...middlewares: Middleware[]
): ServerSubscription => {
	let address: AddressInfo | null = null;
	let ready = false;
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	let resolveStopped!: () => void;
	const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	// Legacy bootstrap callers may only use unsubscribe(); still expose startup
	// failure through ready without causing an unhandled rejected promise.
	void readyPromise.catch(() => undefined);
	const stoppedPromise = new Promise<void>(resolve => { resolveStopped = resolve; });
	const root = new Subscription();
	const subscription: ServerSubscription = Object.assign(root, {
		ready: readyPromise, stopped: stoppedPromise, address: () => address,
	});
	root.add(() => {
		if (!ready) rejectReady(new Error('Server stopped before listening'));
	});
	root.add(createServer(port, {
		onListening: actual => { address = actual; ready = true; resolveReady(); },
		onClosed: () => { address = null; resolveStopped(); },
		onListenError: rejectReady,
	}).subscribe({
		next: event => {
			const operation = createRequestOperation({
				signal: event.request.signal,
				deadlineMs: options.deadlineMs,
				scheduler: options.scheduler,
				execute: signal => defer(() => event.readBody(signal)).pipe(
					mergeMap(body => defer(() => {
						const request = { ...event.request, body, signal };
						const input$ = middlewares.reduce((source$, middleware) => source$.pipe(middleware), of(request));
						return router(input$);
					})),
					map(prepareNodeResponse),
				),
			});
			const requestOwner = new Subscription(() => operation.dispose());
			event.own(requestOwner);
			requestOwner.add(operation.result$.subscribe(outcome => {
				if (outcome.kind === 'success') event.respondPrepared(outcome.value);
				else event.respond({ status: outcome.status, body: outcome.body });
			}));
			operation.start();
		},
		error: error => { rejectReady(error); root.unsubscribe(); },
	}));
	return subscription;
};

export const bootstrap = (port: number, router: Effect, ...middlewares: Middleware[]): ServerSubscription =>
	bootstrapWithOptions(port, router, {}, ...middlewares);
