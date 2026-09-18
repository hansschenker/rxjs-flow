import { defer, of, type Observable } from 'rxjs';
import type { CreateTodoBody, Todo, UpdateTodoBody } from '../../shared/types';
import type { TodoStore } from './todo.store-factory';
import { createTodoTransition, deleteTodoTransition, filterTodos, updateTodoTransition } from './todo.transitions';

/** Finite domain operations; the adapter owns storage and commits before emitting. */
export interface TodoRepository {
	list$(completed?: boolean): Observable<Todo[]>;
	create$(input: CreateTodoBody): Observable<Todo>;
	update$(id: string, input: UpdateTodoBody): Observable<Todo>;
	delete$(id: string): Observable<void>;
}

export interface TodoMetadata {
	newTodoId(): string;
	now(): string;
}

/** Retained Node/test adapter. Construction neither reads nor changes the store. */
export function createMemoryTodoRepository(store: TodoStore, metadata: TodoMetadata = {
	newTodoId: () => crypto.randomUUID(),
	now: () => new Date().toISOString(),
}): TodoRepository {
	return {
		list$: completed => defer(() => of(filterTodos(store.getTodos(), completed))),
		create$: input => defer(() => {
			const transition = createTodoTransition(store.getTodos(), input, {
				id: metadata.newTodoId(), createdAt: metadata.now(),
			});
			store.setTodos(transition.todos);
			return of(transition.value);
		}),
		update$: (id, input) => defer(() => {
			const transition = updateTodoTransition(store.getTodos(), id, input);
			store.setTodos(transition.todos);
			return of(transition.value);
		}),
		delete$: id => defer(() => {
			const transition = deleteTodoTransition(store.getTodos(), id);
			store.setTodos(transition.todos);
			return of(undefined);
		}),
	};
}
