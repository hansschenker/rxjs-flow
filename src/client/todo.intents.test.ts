import { describe, expect, it } from 'vitest';
import type { RequestFailure } from '../shared/http-error';
import type { Todo } from '../shared/types';
import type { Transition } from './runtime/program';
import {
	describeOperation,
	interpretTodoIntent,
	operationFailed,
	operationSucceeded,
	type TodoIntent,
} from './todo.intents';
import { createInitialState, type Action, type Operation, type State } from './todo.state';

const todo: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };
const populated = (): State => ({ ...createInitialState(), todos: [{ ...todo }], draft: 'A newer draft' });

function transition(message: Action, state = populated(), previous = state): Transition<State, Action> {
	return { message, previous, state };
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}

describe('interpretTodoIntent()', () => {
	it('captures the submitted title independently of the current draft without mutating its transition', () => {
		const input = freeze(transition({ type: 'CREATE_REQUESTED', title: '  Submitted title\n' }));
		const original = structuredClone(input);
		expect(interpretTodoIntent(input)).toEqual({ kind: 'create', title: 'Submitted title' });
		expect(input).toEqual(original);
		expect(interpretTodoIntent(transition({ type: 'CREATE_REQUESTED', title: ' \t\n' }))).toBeNull();
	});

	it('accepts a load even when the collection is empty', () => {
		expect(interpretTodoIntent(transition({ type: 'LOAD_REQUESTED' }, createInitialState())))
			.toEqual({ kind: 'load' });
	});

	it.each<Action>([
		{ type: 'TOGGLE_REQUESTED', id: todo.id, completed: true },
		{ type: 'DELETE_REQUESTED', id: todo.id },
	])('checks the coherent current collection for $type instead of the previous collection', message => {
		const empty = createInitialState();
		const current = populated();
		expect(interpretTodoIntent(freeze(transition(message, empty, current)))).toBeNull();
		expect(interpretTodoIntent(freeze(transition(message, current, empty)))).toMatchObject({ todoId: todo.id });
	});

	it('captures requested completion rather than recomputing a toggle from later state', () => {
		const message = { type: 'TOGGLE_REQUESTED' as const, id: todo.id, completed: false };
		const input = transition(message);
		const intent = interpretTodoIntent(input);
		// An unchanged requested value is valid; queued work retains that value.
		expect(intent).toEqual({ kind: 'update', todoId: todo.id, completed: false });
		message.completed = true;
		message.id = 'a different target';
		expect(intent).toEqual({ kind: 'update', todoId: todo.id, completed: false });
	});

	it.each<Action>([
		{ type: 'DRAFT_CHANGED', value: 'Unsubmitted' },
		{ type: 'OPERATION_STARTED', operation: { id: 'load', kind: 'load' } },
		{ type: 'LOAD_SUCCEEDED', operationId: 'load', todos: [todo] },
		{ type: 'CREATE_SUCCEEDED', operationId: 'create', todo },
		{ type: 'UPDATE_SUCCEEDED', operationId: 'update', todo },
		{ type: 'DELETE_SUCCEEDED', operationId: 'delete', id: todo.id },
		{ type: 'OPERATION_FAILED', operationId: 'failed', message: 'Offline' },
		{ type: 'OPERATION_CANCELLED', operationId: 'cancelled' },
		{ type: 'SERVER_SNAPSHOT', todos: [todo] },
		{ type: 'CONNECTION_CHANGED', status: 'connected' },
		{ type: 'ERROR_DISMISSED' },
	])('does not turn $type into external work', message => {
		expect(interpretTodoIntent(freeze(transition(message)))).toBeNull();
	});
});

describe('describeOperation()', () => {
	it.each<{ intent: TodoIntent; operation: Operation }>([
		{ intent: { kind: 'load' }, operation: { id: 'request', kind: 'load' } },
		{ intent: { kind: 'create', title: 'Captured' }, operation: { id: 'request', kind: 'create', title: 'Captured' } },
		{ intent: { kind: 'update', todoId: todo.id, completed: true }, operation: { id: 'request', kind: 'update', todoId: todo.id } },
		{ intent: { kind: 'delete', todoId: todo.id }, operation: { id: 'request', kind: 'delete', todoId: todo.id } },
	])('describes a correlated $intent.kind operation without changing its intent', ({ intent, operation }) => {
		const input = freeze(intent);
		expect(describeOperation(input, 'request')).toEqual(operation);
		expect(input).toEqual(intent);
	});
});

describe('operationSucceeded()', () => {
	it.each<{ operation: Operation; value: unknown; expected: Action }>([
		{
			operation: { id: 'load', kind: 'load' }, value: [todo],
			expected: { type: 'LOAD_SUCCEEDED', operationId: 'load', todos: [todo] },
		},
		{
			operation: { id: 'empty', kind: 'load' }, value: [],
			expected: { type: 'LOAD_SUCCEEDED', operationId: 'empty', todos: [] },
		},
		{
			operation: { id: 'create', kind: 'create', title: todo.title }, value: todo,
			expected: { type: 'CREATE_SUCCEEDED', operationId: 'create', todo },
		},
		{
			operation: { id: 'update', kind: 'update', todoId: todo.id }, value: { ...todo, completed: true },
			expected: { type: 'UPDATE_SUCCEEDED', operationId: 'update', todo: { ...todo, completed: true } },
		},
		{
			operation: { id: 'delete', kind: 'delete', todoId: todo.id }, value: undefined,
			expected: { type: 'DELETE_SUCCEEDED', operationId: 'delete', id: todo.id },
		},
	])('returns the validated correlated result for $operation.id', ({ operation, value, expected }) => {
		expect(operationSucceeded(freeze(operation), freeze(value))).toEqual(expected);
	});

	it.each<{ name: string; operation: Operation; value: unknown }>([
		{ name: 'non-list load', operation: { id: 'load', kind: 'load' }, value: todo },
		{ name: 'malformed list item', operation: { id: 'load', kind: 'load' }, value: [{ ...todo, completed: 'false' }] },
		{ name: 'missing create value', operation: { id: 'create', kind: 'create', title: todo.title }, value: undefined },
		{ name: 'invalid update date', operation: { id: 'update', kind: 'update', todoId: todo.id }, value: { ...todo, createdAt: 'not a date' } },
		{ name: 'different update target', operation: { id: 'update', kind: 'update', todoId: todo.id }, value: { ...todo, id: '2' } },
		{ name: 'null delete result', operation: { id: 'delete', kind: 'delete', todoId: todo.id }, value: null },
		{ name: 'unexpected delete body', operation: { id: 'delete', kind: 'delete', todoId: todo.id }, value: { id: todo.id } },
	])('turns $name into a correlated decode failure', ({ operation, value }) => {
		const result = operationSucceeded(freeze(operation), freeze(value));
		expect(result).toMatchObject({ type: 'OPERATION_FAILED', operationId: operation.id, failure: { kind: 'decode' } });
		if (result.type !== 'OPERATION_FAILED') throw new Error('Expected failure');
		expect(result.message.trim().length).toBeGreaterThan(0);
		expect(result.failure?.message).toBe(result.message);
	});

	it('owns decoded Todo values so later transport mutation cannot alter the returned fact', () => {
		const incoming = { ...todo };
		const result = operationSucceeded({ id: 'load', kind: 'load' }, [incoming]);
		incoming.title = 'Changed after decoding';
		expect(result).toEqual({ type: 'LOAD_SUCCEEDED', operationId: 'load', todos: [todo] });
	});
});

describe('operationFailed()', () => {
	it.each<RequestFailure['kind']>(['http', 'network', 'decode', 'unsupported-response'])(
		'preserves the exact structured %s failure with diagnostic fields', kind => {
			const failure: RequestFailure = freeze({
				kind, message: 'Cannot complete request', status: 422,
				details: [{ path: 'title', message: 'Required' }], body: { error: 'Rejected' },
				cause: new Error('Original failure'),
			});
			const result = operationFailed({ id: 'request', kind: 'load' }, failure);
			expect(result).toEqual({ type: 'OPERATION_FAILED', operationId: 'request', message: failure.message, failure });
			expect(result.failure).toBe(failure);
		},
	);

	it('normalizes an ordinary error while keeping its useful message and original cause', () => {
		const cause = new Error('Connection lost');
		const result = operationFailed({ id: 'request', kind: 'load' }, cause);
		expect(result).toMatchObject({
			type: 'OPERATION_FAILED', operationId: 'request', message: 'Connection lost',
			failure: { kind: 'network', message: 'Connection lost', cause },
		});
		expect(result.failure?.cause).toBe(cause);
	});

	it.each([null, undefined, { message: 123 }, 'Transport unavailable'])('normalizes a non-error cause without throwing', cause => {
		const result = operationFailed({ id: 'request', kind: 'load' }, cause);
		expect(result).toMatchObject({ type: 'OPERATION_FAILED', operationId: 'request', failure: { kind: 'network' } });
		expect(result.message.trim().length).toBeGreaterThan(0);
		expect(result.failure?.message).toBe(result.message);
	});
});
