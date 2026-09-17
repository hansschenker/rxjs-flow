import { h } from '../h';
import type { Todo } from '../../shared/types';
import type { Scope } from '../runtime/scope';
import { domEvent$ } from '../runtime/sources';

interface Props {
	todo: Todo;
	scope: Scope;
	onToggle: (completed: boolean) => void;
	onDelete: (id: string) => void;
}

/** The component scope owns both its event listeners and the row DOM. */
export function TodoItem({ todo, scope, onToggle, onDelete }: Props): HTMLElement {
	const checkbox = <input type="checkbox" checked={todo.completed} /> as HTMLInputElement;
	const button = <button>Delete</button>;
	const row = (
		<li className={todo.completed ? 'completed' : undefined}>
			{checkbox}
			<span>{todo.title}</span>
			{button}
		</li>
	);

	scope.subscribe(domEvent$(checkbox, 'change', () => checkbox.checked), { next: onToggle });
	scope.subscribe(domEvent$(button, 'click', () => todo.id), { next: onDelete });
	scope.add(() => row.remove());
	return row;
}
