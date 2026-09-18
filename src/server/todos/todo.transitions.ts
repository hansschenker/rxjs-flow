import type { Todo } from '../../shared/types';
import { HttpError, NotFound } from '../core/errors';
import type { CreateTodoInput, UpdateTodoInput } from './todo.validator';

export interface TodoTransition<T> {
	todos: Todo[];
	value: T;
}

/** Domain transitions receive identity/time as values and never mutate their input. */
export function createTodoTransition(
	todos: readonly Todo[], input: CreateTodoInput, metadata: { id: string; createdAt: string },
): TodoTransition<Todo> {
	if (todos.some(todo => todo.id === metadata.id)) throw new HttpError(409, 'Todo identity already exists');
	const value: Todo = { id: metadata.id, title: input.title, completed: false, createdAt: metadata.createdAt };
	return { todos: [...todos.map(copyTodo), { ...value }], value };
}

export function updateTodoTransition(
	todos: readonly Todo[], id: string, input: UpdateTodoInput,
): TodoTransition<Todo> {
	const existing = todos.find(todo => todo.id === id);
	if (!existing) throw new NotFound('Todo not found');
	const value: Todo = {
		...existing,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.completed === undefined ? {} : { completed: input.completed }),
	};
	return { todos: todos.map(todo => todo.id === id ? { ...value } : copyTodo(todo)), value };
}

export function deleteTodoTransition(todos: readonly Todo[], id: string): TodoTransition<null> {
	if (!todos.some(todo => todo.id === id)) throw new NotFound('Todo not found');
	return { todos: todos.filter(todo => todo.id !== id).map(copyTodo), value: null };
}

export function filterTodos(todos: readonly Todo[], completed?: boolean): Todo[] {
	return todos.filter(todo => completed === undefined || todo.completed === completed).map(copyTodo);
}

function copyTodo(todo: Todo): Todo { return { ...todo }; }
