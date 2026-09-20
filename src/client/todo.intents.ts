import { createRequestFailure, isRequestFailure } from '../shared/http-error';
import { todoListSchema, todoSchema } from '../shared/todo.schema';
import type { Transition } from './runtime/program';
import type { Action, Operation, State } from './todo.state';

export type TodoIntent =
	| { readonly kind: 'load' }
	| { readonly kind: 'create'; readonly title: string }
	| { readonly kind: 'update'; readonly todoId: string; readonly completed: boolean }
	| { readonly kind: 'delete'; readonly todoId: string };

export type MutationIntent = Exclude<TodoIntent, { readonly kind: 'load' }>;

/** Interpret the message with its own coherent state, before queueing any work. */
export function interpretTodoIntent({ message, state }: Transition<State, Action>): TodoIntent | null {
	switch (message.type) {
		case 'LOAD_REQUESTED':
			return state.live ? null : { kind: 'load' };
		case 'CREATE_REQUESTED': {
			const title = message.title.trim();
			return title ? { kind: 'create', title } : null;
		}
		case 'TOGGLE_REQUESTED':
			return state.todos.some(todo => todo.id === message.id)
				? { kind: 'update', todoId: message.id, completed: message.completed } : null;
		case 'DELETE_REQUESTED':
			return state.todos.some(todo => todo.id === message.id)
				? { kind: 'delete', todoId: message.id } : null;
		default:
			return null;
	}
}

export function describeOperation(intent: TodoIntent, id: string): Operation {
	switch (intent.kind) {
		case 'load': return { id, kind: 'load' };
		case 'create': return { id, kind: 'create', title: intent.title };
		case 'update': return { id, kind: 'update', todoId: intent.todoId };
		case 'delete': return { id, kind: 'delete', todoId: intent.todoId };
	}
}

export function operationFailed(operation: Operation, cause: unknown): Extract<Action, { type: 'OPERATION_FAILED' }> {
	const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
	const failure = isRequestFailure(cause) ? cause : createRequestFailure({
		kind: 'network',
		message: message.trim() ? message : 'Request failed.',
		cause,
	});
	return { type: 'OPERATION_FAILED', operationId: operation.id, message: failure.message, failure };
}

function invalidResult(operation: Operation, details?: unknown): Action {
	return operationFailed(operation, createRequestFailure({
		kind: 'decode', message: `Invalid ${operation.kind} response.`, details,
	}));
}

/** Validate even injected service capabilities before admitting their result to state. */
export function operationSucceeded(operation: Operation, value: unknown): Action {
	if (operation.kind === 'delete') {
		return value === undefined
			? { type: 'DELETE_SUCCEEDED', operationId: operation.id, id: operation.todoId }
			: invalidResult(operation);
	}
	if (operation.kind === 'load') {
		const decoded = todoListSchema.safeParse(value);
		return decoded.success
			? { type: 'LOAD_SUCCEEDED', operationId: operation.id, todos: decoded.data }
			: invalidResult(operation, decoded.error.issues);
	}
	const decoded = todoSchema.safeParse(value);
	if (!decoded.success) return invalidResult(operation, decoded.error.issues);
	if (operation.kind === 'update' && decoded.data.id !== operation.todoId) {
		return invalidResult(operation, { expectedId: operation.todoId, actualId: decoded.data.id });
	}
	return {
		type: operation.kind === 'create' ? 'CREATE_SUCCEEDED' : 'UPDATE_SUCCEEDED',
		operationId: operation.id,
		todo: decoded.data,
	};
}
