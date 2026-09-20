import type { Action } from './todo.state';
import { Subject, defer } from 'rxjs';
import type { LiveConnectionEvent } from './live-connection';
import type { TodoLiveSnapshot } from '../shared/todo-live';
import { createTodoModel } from './todo.model';
import { todoEffects$ } from './todo.effects';
import * as defaultService from './todo.service';
import type { TodoService } from './todo.service';
import { bindTodoView, findTodoElements } from './todo.view';
import { createScope } from './runtime/scope';
import { domEvent$ } from './runtime/sources';

export type { TodoService } from './todo.service';

export interface TodoAppOptions {
	readonly mutationCapacity?: number;
	readonly reportError?: (error: unknown) => void;
}

function reportRuntimeError(error: unknown): void {
	console.error('Todo app runtime failed:', error);
}

/** Inert construction. The host owns one effect subscription and one model. */
export function createTodoApp(service: TodoService = defaultService, options: TodoAppOptions = {}) {
	const app = createScope();
	const model = createTodoModel({ collectionSource: service.live$ ? 'live' : 'http' });
	const recovery = new Subject<void>();
	// Reject input first; release sources, view/rows, effects, then state.
	const sources = app.child();
	const view = app.child();
	const effects = app.child();
	effects.add(() => recovery.complete());
	app.add(model.dispose);
	let started = false;

	function accept(action: Action): void {
		if (!app.closed) model.dispatch(action);
	}

	function failRuntime(error: unknown): void {
		if (app.closed) return;
		try { app.dispose(); }
		finally { (options.reportError ?? reportRuntimeError)(error); }
	}

	function refresh(): void {
		if (app.closed || !started) return;
		if (service.live$) recovery.next();
		else accept({ type: 'LOAD_REQUESTED' });
	}

	function acceptLive(event: LiveConnectionEvent<TodoLiveSnapshot>): void {
		switch (event.type) {
			case 'connecting':
				accept({ type: 'LIVE_CONNECTING', connectionId: event.connectionId, attempt: event.attempt });
				return;
			case 'snapshot':
				accept({ type: 'LIVE_SNAPSHOT', connectionId: event.connectionId, snapshot: event.value });
				return;
			case 'reconnecting':
				accept({ type: 'LIVE_INTERRUPTED', connectionId: event.connectionId, attempt: event.attempt,
					retrying: true, delayMs: event.delayMs, message: event.message });
				return;
			case 'failed':
				accept({ type: 'LIVE_INTERRUPTED', connectionId: event.connectionId, attempt: event.attempt,
					retrying: false, message: event.message });
		}
	}

	function start(root: ParentNode): void {
		if (app.closed || started) return;
		const elements = findTodoElements(root);
		const { form, input, refresh: refreshButton } = elements;
		started = true;
		bindTodoView(view, elements, model.viewModel$, accept, failRuntime);

		// The host is the single owner of execution; traces read model transitions.
		effects.subscribe(todoEffects$(model.transitions$, service, options), {
			next: accept,
			error: failRuntime,
		});

		// Every consumer exists before initial state, DOM inputs or synchronous work.
		model.start();
		if (service.live$) {
			// State and rendering are attached before a synchronous initial snapshot.
			// This root keeps the one connection alive independently of UI consumers.
			effects.subscribe(defer(() => service.live$!(recovery.asObservable())), {
				next: acceptLive, error: failRuntime,
			});
		}
		sources.subscribe(domEvent$(input, 'input', () => input.value), {
			next: value => accept({ type: 'DRAFT_CHANGED', value }),
			error: failRuntime,
		});
		sources.subscribe(domEvent$(form, 'submit', event => {
			event.preventDefault();
			return input.value;
		}), {
			next: value => {
				accept({ type: 'DRAFT_CHANGED', value });
				accept({ type: 'CREATE_REQUESTED', title: value });
			},
			error: failRuntime,
		});
		if (refreshButton) {
			sources.subscribe(domEvent$(refreshButton, 'click', () => undefined), { next: refresh, error: failRuntime });
		}
		if (!service.live$) refresh();
	}

	return { start, refresh, dispose: app.dispose, state$: model.state$, viewModel$: model.viewModel$, transitions$: model.transitions$ };
}

/** Executable host boundary; the optional host owns hot-replacement disposal. */
export function mountTodoApp(root: ParentNode, options: TodoAppOptions & {
	service?: TodoService;
	hot?: { dispose(callback: () => void): void };
} = {}) {
	const app = createTodoApp(options.service, options);
	options.hot?.dispose(app.dispose);
	try {
		app.start(root);
		return app;
	} catch (error) {
		app.dispose();
		throw error;
	}
}
