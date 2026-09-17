import { h } from '../h';
import type { Todo } from '../../shared/types';
import type { Scope } from '../runtime/scope';
import { domEvent$ } from '../runtime/sources';
import type { Action } from '../todo.state';
import { type Observable, filter, map, of } from 'rxjs';
import { bindAttribute, bindClass, bindProperty, bindText } from '../dom/bindings';

export type TodoItemIntent = Extract<Action, { type: 'TOGGLE_REQUESTED' | 'DELETE_REQUESTED' }>;

export interface TodoRowView {
	readonly todo: Readonly<Todo>;
	readonly busy: boolean;
}

interface Props {
	todo: Readonly<Todo>;
	view$?: Observable<TodoRowView>;
	scope: Scope;
	onIntent: (intent: TodoItemIntent) => void;
	onError?: (error: unknown) => void;
}

/** The component scope owns both its event listeners and the row DOM. */
export function TodoItem({ todo, view$ = of({ todo, busy: false }), scope, onIntent, onError }: Props): HTMLElement {
	const checkbox = <input type="checkbox" checked={todo.completed} /> as HTMLInputElement;
	const button = <button type="button">Delete</button>;
	const title = <span>{todo.title}</span>;
	const row = (
		<li data-todo-id={todo.id} className={todo.completed ? 'completed' : undefined}>
			{checkbox}
			{title}
			{button}
		</li>
	);
	scope.add(() => row.remove());
	bindText(scope, title, view$.pipe(map(rowTitle)), onError);
	bindAttribute(scope, checkbox, 'aria-label', view$.pipe(map(toggleLabel)), onError);
	bindAttribute(scope, button, 'aria-label', view$.pipe(map(deleteLabel)), onError);
	bindAttribute(scope, row, 'aria-busy', view$.pipe(map(rowBusy)), onError);
	bindClass(scope, row, 'completed', view$.pipe(map(rowCompleted)), onError);
	// The browser captures a toggle immediately. While accepted work is pending,
	// preserve that native choice; settlement restores the confirmed model value.
	bindProperty(scope, checkbox, 'checked', view$.pipe(filter(rowSettled), map(rowCompleted)), onError);

	function toggleIntent(): TodoItemIntent {
		return { type: 'TOGGLE_REQUESTED', id: todo.id, completed: checkbox.checked };
	}
	function deleteIntent(): TodoItemIntent {
		return { type: 'DELETE_REQUESTED', id: todo.id };
	}
	scope.subscribe(domEvent$(checkbox, 'change', toggleIntent), { next: onIntent, error: onError });
	scope.subscribe(domEvent$(button, 'click', deleteIntent), { next: onIntent, error: onError });
	return row;
}

function rowTitle(view: TodoRowView): string { return view.todo.title; }
function rowCompleted(view: TodoRowView): boolean { return view.todo.completed; }
function rowSettled(view: TodoRowView): boolean { return !view.busy; }
function rowBusy(view: TodoRowView): string { return String(view.busy); }
function toggleLabel(view: TodoRowView): string { return `Complete ${view.todo.title}`; }
function deleteLabel(view: TodoRowView): string { return `Delete ${view.todo.title}`; }
