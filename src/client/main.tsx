import { tap } from 'rxjs';
import type { Action, State } from './todo.state';
import type { ViewModel } from './todo.selectors';
import { createTodoModel } from './todo.model';
import { todoEffects$ } from './todo.effects';
import * as defaultService from './todo.service';
import type { TodoService } from './todo.service';
import { TodoItem } from './components/todo-item';
import { createScope, type Scope } from './runtime/scope';
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
	const model = createTodoModel();
	// Reject input first; release sources, rows, effects, binding, then state.
	const sources = app.child();
	const children = app.child();
	const effects = app.child();
	const binding = app.child();
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
		accept({ type: 'LOAD_REQUESTED' });
	}

	function start(root: ParentNode): void {
		if (app.closed || started) return;
		const list = root.querySelector<HTMLElement>('#todo-list');
		const error = root.querySelector<HTMLElement>('#error-msg');
		const form = root.querySelector<HTMLFormElement>('#add-form');
		const input = root.querySelector<HTMLInputElement>('#title-input');
		if (!list || !error || !form || !input) {
			throw new Error('Todo app requires #todo-list, #error-msg, #add-form and #title-input.');
		}
		const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		const refreshButton = root.querySelector<HTMLButtonElement>('#refresh-todos');
		started = true;
		let rows: Scope | undefined;
		let renderedTodos: State['todos'] | undefined;
		let renderedError: string | null = null;

		const render = ({ todos, draft, creating, canSubmit, error: message }: ViewModel): void => {
			error.textContent = message ?? '';
			if (input.value !== draft) input.value = draft;
			form.setAttribute('aria-busy', String(creating));
			if (submit) {
				submit.disabled = !canSubmit;
				submit.textContent = creating ? 'Adding…' : 'Add';
			}
			// M04 will replace this coarse collection renderer with keyed bindings.
			const newFailure = message !== null && message !== renderedError;
			renderedError = message;
			if (todos === renderedTodos && !newFailure) return;
			renderedTodos = todos;
			rows?.dispose();
			rows = children.child();
			list.replaceChildren();
			for (const todo of todos) {
				list.appendChild(TodoItem({ todo, scope: rows.child(), onIntent: accept, onError: failRuntime }));
			}
		};
		// Rendering errors are stream errors; observer.next exceptions bypass its error handler.
		binding.subscribe(model.viewModel$.pipe(tap(render)), { error: failRuntime });

		// The host is the single owner of execution; traces read model transitions.
		effects.subscribe(todoEffects$(model.transitions$, service, options), {
			next: accept,
			error: failRuntime,
		});

		// Every consumer exists before initial state, DOM inputs or synchronous work.
		model.start();
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
		refresh();
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
