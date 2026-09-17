import { type Observable, Subject, map } from 'rxjs';
import { h } from './h';
import type { Scope } from './runtime/scope';
import type { Action } from './todo.state';
import type { ViewModel } from './todo.selectors';
import { TodoItem, type TodoRowView } from './components/todo-item';
import { bindAttribute, bindIf, bindProperty, bindText } from './dom/bindings';
import { bindKeyedList, type KeyedRow } from './dom/keyed-list';

/** Locate the stable host shell once, before activating any source. */
export function findTodoElements(root: ParentNode) {
	const list = root.querySelector<HTMLElement>('#todo-list');
	const error = root.querySelector<HTMLElement>('#error-msg');
	const form = root.querySelector<HTMLFormElement>('#add-form');
	const input = root.querySelector<HTMLInputElement>('#title-input');
	if (!list || !error || !form || !input) {
		throw new Error('Todo app requires #todo-list, #error-msg, #add-form and #title-input.');
	}
	return {
		list, error, form, input,
		submit: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
		refresh: root.querySelector<HTMLButtonElement>('#refresh-todos'),
		summary: root.querySelector<HTMLElement>('#todo-summary'),
		pending: root.querySelector<HTMLElement>('#pending-msg'),
		loading: root.querySelector<HTMLElement>('#loading-state'),
		empty: root.querySelector<HTMLElement>('#empty-state'),
	};
}

/** Subscribe DOM sinks to coherent projections of the model's owned state. */
export function bindTodoView(
	scope: Scope,
	elements: ReturnType<typeof findTodoElements>,
	viewModel$: Observable<ViewModel>,
	onIntent: (action: Action) => void,
	onError: (error: unknown) => void,
): void {
	const { list, error, form, input, submit, summary, pending, loading, empty } = elements;
	bindText(scope, error, viewModel$.pipe(map(errorText)), onError);
	bindProperty(scope, input, 'value', viewModel$.pipe(map(draftValue)), onError);
	bindAttribute(scope, form, 'aria-busy', viewModel$.pipe(map(formBusy)), onError);
	if (submit) {
		bindProperty(scope, submit, 'disabled', viewModel$.pipe(map(submitDisabled)), onError);
		bindText(scope, submit, viewModel$.pipe(map(submitText)), onError);
	}
	if (summary) bindText(scope, summary, viewModel$.pipe(map(remainingText)), onError);
	if (pending) bindText(scope, pending, viewModel$.pipe(map(pendingText)), onError);
	if (loading) bindIf(scope, loading, viewModel$.pipe(map(isLoading)), loadingContent, onError);
	if (empty) bindIf(scope, empty, viewModel$.pipe(map(isEmpty)), emptyContent, onError);

	function createRow(initial: TodoRowView, rowScope: Scope): KeyedRow<TodoRowView> {
		const updates = new Subject<TodoRowView>();
		const element = TodoItem({ todo: initial.todo, view$: updates.asObservable(), scope: rowScope, onIntent, onError });
		rowScope.add(() => updates.complete());
		return { element, update: value => { if (!rowScope.closed) updates.next(value); } };
	}
	bindKeyedList(scope, list, viewModel$.pipe(map(todoRows)), rowKey, createRow, onError);
}

export function remainingText(view: ViewModel): string {
	return `${view.remaining} remaining · ${view.completed} completed`;
}

function errorText(view: ViewModel): string { return view.error ?? ''; }
function draftValue(view: ViewModel): string { return view.draft; }
function formBusy(view: ViewModel): string { return String(view.creating); }
function submitDisabled(view: ViewModel): boolean { return !view.canSubmit; }
function submitText(view: ViewModel): string { return view.creating ? 'Adding…' : 'Add'; }
function pendingText(view: ViewModel): string {
	return view.pendingCount ? `${view.pendingCount} pending` : 'All changes settled';
}
function isLoading(view: ViewModel): boolean { return view.loading; }
function isEmpty(view: ViewModel): boolean { return view.empty; }
function loadingContent(): HTMLElement { return <p className="placeholder">Loading your tasks…</p>; }
function emptyContent(): HTMLElement { return <p className="placeholder">Your list is clear. Add a task above to get started.</p>; }
function rowKey(view: TodoRowView): string { return view.todo.id; }
function todoRows(view: ViewModel): readonly TodoRowView[] {
	const pending = new Set(view.pendingTodoIds);
	return view.todos.map(todo => ({ todo, busy: pending.has(todo.id) }));
}
