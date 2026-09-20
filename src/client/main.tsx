import { createTodoProgram, type TodoAppOptions } from './todo.program';
import type { TodoService } from './todo.service';

// Retain the existing host API while feature wiring lives with the Todo program.
export { createTodoProgram as createTodoApp } from './todo.program';
export type { TodoAppOptions } from './todo.program';
export type { TodoService } from './todo.service';

/** Construct, mount and release one Todo program; construction alone is inert. */
export function mountTodoApp(root: ParentNode, options: TodoAppOptions & {
	service?: TodoService;
	hot?: { dispose(callback: () => void): void };
} = {}) {
	const program = createTodoProgram(options.service, options);
	options.hot?.dispose(program.dispose);
	try {
		program.start(root);
		return program;
	} catch (error) {
		program.dispose();
		throw error;
	}
}
