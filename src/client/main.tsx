import { EMPTY, defer, type Observable } from 'rxjs';
import { catchError, exhaustMap, filter, finalize, tap } from 'rxjs/operators';
import type { Action, Operation, State } from './todo.state';
import { createTodoModel } from './todo.model';
import * as defaultService from './todo.service';
import { TodoItem } from './components/todo-item';
import { createScope, type Scope } from './runtime/scope';
import { domEvent$ } from './runtime/sources';
import type { Transition } from './runtime/program';

export type TodoService = Pick<typeof defaultService, 'getAll$' | 'create$' | 'update$' | 'remove$'>;

function isCreateIntent(transition: Transition<State, Action>):
	transition is Transition<State, Extract<Action, { type: 'CREATE_REQUESTED' }>> {
	return transition.message.type === 'CREATE_REQUESTED';
}

/** Inert construction. Start once; after disposal construct a fresh app. */
export function createTodoApp(service: TodoService = defaultService) {
	const app = createScope();
	const model = createTodoModel();
	// Teardown order: inputs/feedback, child views, operations, binding, state owner.
	const sources = app.child();
	const children = app.child();
	const operations = app.child();
	const binding = app.child();
	app.add(model.dispose);
	let started = false;
	let nextOperationId = 0;

	function start(root: ParentNode): void {
		if (app.closed || started) return;
		const list = root.querySelector<HTMLElement>('#todo-list');
		const error = root.querySelector<HTMLElement>('#error-msg');
		const form = root.querySelector<HTMLFormElement>('#add-form');
		const input = root.querySelector<HTMLInputElement>('#title-input');
		if (!list || !error || !form || !input) {
			throw new Error('Todo app requires #todo-list, #error-msg, #add-form and #title-input.');
		}
		started = true;

		let rows: Scope | undefined;
		let renderedTodos: State['todos'] | undefined;
		let renderedError: string | null = null;
		const accept = (action: Action): void => {
			if (!app.closed) model.dispatch(action);
		};

		// Finite service operations report model facts. M03 owns transport decoding
		// and extraction of the complete effect/concurrency policy from this host.
		function operation$<T>(operation: Operation, request: () => Observable<T>,
			result: (value: T) => Action, failure: string): Observable<T> {
			return defer(() => {
				accept({ type: 'OPERATION_STARTED', operation });
				let settled = false;
				return defer(request).pipe(
					tap({
						next: value => { settled = true; accept(result(value)); },
						complete: () => {
							if (!settled) {
								settled = true;
								accept({ type: 'OPERATION_FAILED', operationId: operation.id, message: `${failure} No result received.` });
							}
						},
					}),
					catchError(() => {
						settled = true;
						accept({ type: 'OPERATION_FAILED', operationId: operation.id, message: failure });
						return EMPTY;
					}),
					finalize(() => {
						if (!settled) accept({ type: 'OPERATION_CANCELLED', operationId: operation.id });
					}),
				);
			});
		}

		binding.subscribe(model.viewModel$, {
			next: ({ todos, draft, error: message }) => {
				error.textContent = message ?? '';
				if (input.value !== draft) input.value = draft;
				// Keep the existing whole-list renderer for collection changes. New
				// UI-only state must not recreate rows on every keystroke/pending fact.
				// A new failure also restores DOM controls to the model's values.
				const newFailure = message !== null && message !== renderedError;
				renderedError = message;
				if (todos === renderedTodos && !newFailure) return;
				renderedTodos = todos;
				rows?.dispose();
				rows = children.child();
				list.replaceChildren();
				for (const todo of todos) {
					list.appendChild(TodoItem({
						todo,
						scope: rows.child(),
						onToggle: completed => accept({ type: 'TOGGLE_REQUESTED', id: todo.id, completed }),
						onDelete: id => accept({ type: 'DELETE_REQUESTED', id }),
					}));
				}
			},
		});

		// Effects consume the accepted intent and its own state snapshot. They
		// never join an independently subscribed actions$/state$ pair.
		sources.subscribe(model.transitions$.pipe(
			filter(isCreateIntent),
			filter(({ message }) => message.title.length > 0),
			exhaustMap(({ message }) => {
				const operation = { id: String(++nextOperationId), kind: 'create', title: message.title } as const;
				return operation$(operation, () => service.create$({ title: message.title }),
					todo => ({ type: 'CREATE_SUCCEEDED', operationId: operation.id, todo }), 'Failed to create todo.');
			}),
		));
		sources.subscribe(model.transitions$, {
			next: ({ message, state }) => {
				if (message.type === 'LOAD_REQUESTED') {
					const id = String(++nextOperationId);
					operations.subscribe(operation$({ id, kind: 'load' }, () => service.getAll$(),
						todos => ({ type: 'LOAD_SUCCEEDED', operationId: id, todos }), 'Failed to load todos.'));
				} else if (message.type === 'TOGGLE_REQUESTED' && state.todos.some(todo => todo.id === message.id)) {
					const id = String(++nextOperationId);
					operations.subscribe(operation$({ id, kind: 'update', todoId: message.id },
						() => service.update$(message.id, { completed: message.completed }),
						todo => ({ type: 'UPDATE_SUCCEEDED', operationId: id, todo }), 'Failed to update todo.'));
				} else if (message.type === 'DELETE_REQUESTED' && state.todos.some(todo => todo.id === message.id)) {
					const id = String(++nextOperationId);
					operations.subscribe(operation$({ id, kind: 'delete', todoId: message.id }, () => service.remove$(message.id),
						() => ({ type: 'DELETE_SUCCEEDED', operationId: id, id: message.id }), 'Failed to delete todo.'));
				}
			},
		});

		// Root accumulation and every feedback consumer precede external activation.
		model.start();
		sources.subscribe(domEvent$(input, 'input', () => input.value), {
			next: value => accept({ type: 'DRAFT_CHANGED', value }),
		});
		sources.subscribe(domEvent$(form, 'submit', event => {
			event.preventDefault();
			return input.value;
		}), {
			next: value => {
				accept({ type: 'DRAFT_CHANGED', value });
				accept({ type: 'CREATE_REQUESTED', title: value.trim() });
			},
		});
		accept({ type: 'LOAD_REQUESTED' });
	}

	return { start, dispose: app.dispose, state$: model.state$, viewModel$: model.viewModel$ };
}

/** Executable host boundary; the optional host owns hot-replacement disposal. */
export function mountTodoApp(root: ParentNode, options: {
	service?: TodoService;
	hot?: { dispose(callback: () => void): void };
} = {}) {
	const app = createTodoApp(options.service);
	options.hot?.dispose(app.dispose);
	try {
		app.start(root);
		return app;
	} catch (error) {
		app.dispose();
		throw error;
	}
}
