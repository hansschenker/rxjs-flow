import { EMPTY, defer } from 'rxjs';
import { catchError, exhaustMap, filter, tap } from 'rxjs/operators';
import { state$, dispatch, type Action } from './todo.state';
import * as defaultService from './todo.service';
import { TodoItem } from './components/todo-item';
import { createScope, type Scope } from './runtime/scope';
import { domEvent$ } from './runtime/sources';

export type TodoService = Pick<typeof defaultService, 'getAll$' | 'create$' | 'update$' | 'remove$'>;

/** Inert construction. Start once; after disposal construct a fresh app. */
export function createTodoApp(service: TodoService = defaultService) {
	const app = createScope();
	let started = false;

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

		// Teardown order: input sources, child views, operations, then state binding.
		const sources = app.child();
		const children = app.child();
		const operations = app.child();
		const binding = app.child();
		let rows: Scope | undefined;
		const accept = (action: Action): void => {
			if (!app.closed) dispatch(action);
		};

		// This binding owns the existing shared accumulation while mounted. M02
		// replaces the legacy global model with isolated instances and ordering.
		binding.subscribe(state$, {
			next: ({ todos, error: message }) => {
				rows?.dispose();
				rows = children.child();
				error.textContent = message ?? '';
				list.replaceChildren();
				for (const todo of todos) {
					list.appendChild(TodoItem({
						todo,
						scope: rows.child(),
						onToggle: completed => {
							operations.subscribe(defer(() => service.update$(todo.id, { completed })).pipe(
								catchError(() => EMPTY),
							), { next: updated => accept({ type: 'UPDATE_SUCCESS', todo: updated }) });
						},
						onDelete: id => {
							operations.subscribe(defer(() => service.remove$(id)).pipe(
								catchError(() => EMPTY),
							), { next: () => accept({ type: 'DELETE_SUCCESS', id }) });
						},
					}));
				}
			},
		});

		sources.subscribe(domEvent$(form, 'submit', event => {
			event.preventDefault();
			return input.value.trim();
		}).pipe(
			filter(title => title.length > 0),
			exhaustMap(title => defer(() => service.create$({ title })).pipe(
				tap(todo => accept({ type: 'CREATE_SUCCESS', todo })),
				tap(() => { if (!app.closed) input.value = ''; }),
				catchError(() => {
					accept({ type: 'SET_ERROR', message: 'Failed to create todo.' });
					return EMPTY;
				}),
			)),
		));

		// State and input consumers exist before a possibly synchronous effect.
		operations.subscribe(defer(() => service.getAll$()), {
			next: todos => accept({ type: 'LOAD_SUCCESS', todos }),
			error: () => accept({ type: 'SET_ERROR', message: 'Failed to load todos.' }),
		});
	}

	return { start, dispose: app.dispose };
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
