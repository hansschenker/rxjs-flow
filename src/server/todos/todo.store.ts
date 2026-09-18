// Compatibility exports for the retained Node baseline. Workers import the inert factory.
import { createTodoStore } from './todo.store-factory';
export { createTodoStore, type TodoStore } from './todo.store-factory';

const defaultStore = createTodoStore();
export const todoStore = defaultStore;
export const getTodos = defaultStore.getTodos;
export const setTodos = defaultStore.setTodos;
export const resetStore = defaultStore.reset;
