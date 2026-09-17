import { h } from '../h';
import type { Todo } from '../../shared/types';
import type { Scope } from '../runtime/scope';
import { domEvent$ } from '../runtime/sources';
import type { Action } from '../todo.state';

export type TodoItemIntent = Extract<Action, { type: 'TOGGLE_REQUESTED' | 'DELETE_REQUESTED' }>;

interface Props {
	todo: Todo;
	scope: Scope;
	onIntent: (intent: TodoItemIntent) => void;
	onError?: (error: unknown) => void;
}

/** The component scope owns both its event listeners and the row DOM. */
export function TodoItem({ todo, scope, onIntent, onError }: Props): HTMLElement {
	const checkbox = <input type="checkbox" checked={todo.completed} /> as HTMLInputElement;
	const button = <button>Delete</button>;
	const row = (
		<li className={todo.completed ? 'completed' : undefined}>
			{checkbox}
			<span>{todo.title}</span>
			{button}
		</li>
	);

	function toggleIntent(): TodoItemIntent {
		return { type: 'TOGGLE_REQUESTED', id: todo.id, completed: checkbox.checked };
	}
	function deleteIntent(): TodoItemIntent {
		return { type: 'DELETE_REQUESTED', id: todo.id };
	}
	scope.subscribe(domEvent$(checkbox, 'change', toggleIntent), { next: onIntent, error: onError });
	scope.subscribe(domEvent$(button, 'click', deleteIntent), { next: onIntent, error: onError });
	scope.add(() => row.remove());
	return row;
}
