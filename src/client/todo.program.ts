import type { Action, TodoFilter } from './todo.state';
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
import { allocateTraceId, emitTrace, traceObservable, type Trace } from '../shared/trace';

export type { TodoService } from './todo.service';

export interface TodoAppOptions {
	readonly mutationCapacity?: number;
	readonly reportError?: (error: unknown) => void;
	/** Opt-in synchronous metadata observer; no work is activated by construction. */
	readonly trace?: Trace;
	readonly traceScope?: string;
}

function reportRuntimeError(error: unknown): void {
	console.error('Todo app runtime failed:', error);
}

/** Inert construction. The host owns one effect subscription and one model. */
export function createTodoProgram(service: TodoService = defaultService, options: TodoAppOptions = {}) {
	const traceScope = options.traceScope ?? allocateTraceId(options.trace, 'todo.app');
	const app = createScope({ trace: options.trace, id: traceScope });
	const model = createTodoModel({ collectionSource: service.live$ ? 'live' : 'http', trace: options.trace, traceScope });
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
		if (service.live$) {
			emitTrace(options.trace, { event: 'source.received', scopeId: traceScope, sourceId: 'todo.recovery',
				metadata: { kind: 'RECONNECT_REQUESTED' } });
			if (!app.closed) recovery.next();
		}
		else accept({ type: 'LOAD_REQUESTED' });
	}

	function acceptLive(event: LiveConnectionEvent<TodoLiveSnapshot>): void {
		emitTrace(options.trace, { event: 'connection.change', scopeId: traceScope, sourceId: 'todo.live-owner',
			connectionId: String(event.connectionId),
			...(event.type === 'snapshot' ? { collectionId: event.value.collectionId,
				stateGeneration: event.value.stateGeneration, revision: event.value.revision } : {}),
			metadata: { kind: event.type, ...('attempt' in event ? { attempt: event.attempt } : {}),
				...(event.type === 'reconnecting' ? { delayMs: event.delayMs } : {}) },
		});
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

	function renderCommitted(): void {
		emitTrace(options.trace, { event: 'render.commit', scopeId: traceScope, sourceId: 'todo.view', ...model.traceDetails });
	}

	function start(root: ParentNode): void {
		if (app.closed || started) return;
		const elements = findTodoElements(root);
		const { form, input, refresh: refreshButton, filters, errorDismiss } = elements;
		started = true;
		bindTodoView(view, elements, model.viewModel$, accept, failRuntime, options.trace ? renderCommitted : undefined);

		// The host is the single owner of execution; traces read model transitions.
		effects.subscribe(todoEffects$(model.transitions$, service, { ...options, traceScope }), {
			next: accept,
			error: failRuntime,
		});

		// Every consumer exists before initial state, DOM inputs or synchronous work.
		model.start();
		if (service.live$) {
			// State and rendering are attached before a synchronous initial snapshot.
			// This root keeps the one connection alive independently of UI consumers.
			effects.subscribe(traceObservable(defer(() => service.live$!(recovery.asObservable())), options.trace,
				{ scopeId: traceScope, sourceId: 'todo.live-owner' }), {
				next: acceptLive, error: failRuntime,
			});
		}
		sources.subscribe(domEvent$(input, 'input', () => input.value), {
			next: value => accept({ type: 'DRAFT_CHANGED', value }),
			error: failRuntime,
		});
		sources.subscribe(domEvent$(input, 'blur', draftBlurred), { next: accept, error: failRuntime });
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
		for (const control of filters) {
			function readFilter(): string | null { return control.checked ? control.value : null; }
			function changeFilter(value: string | null): void {
				if (value !== null && isTodoFilter(value)) accept({ type: 'FILTER_CHANGED', filter: value });
			}
			sources.subscribe(domEvent$(control, 'change', readFilter), { next: changeFilter, error: failRuntime });
		}
		if (errorDismiss) {
			sources.subscribe(domEvent$(errorDismiss, 'click', dismissError), { next: accept, error: failRuntime });
		}
		if (!service.live$) refresh();
	}

	return { start, refresh, dispose: app.dispose, state$: model.state$, viewModel$: model.viewModel$, transitions$: model.transitions$ };
}

function draftBlurred(): Action { return { type: 'DRAFT_BLURRED' }; }
function dismissError(): Action { return { type: 'ERROR_DISMISSED' }; }
function isTodoFilter(value: string): value is TodoFilter {
	return value === 'all' || value === 'active' || value === 'completed';
}
