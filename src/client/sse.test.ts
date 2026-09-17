import { firstValueFrom } from 'rxjs';
import { afterEach, vi } from 'vitest';
import { z } from 'zod';
import { todoListSchema } from '../shared/todo.schema';
import { fromEventSource } from './sse';

function decodeTodos(value: unknown) {
	return todoListSchema.parse(value);
}

function decodeNumber(value: unknown) {
	return z.number().parse(value);
}

function createMockEventSource() {
	const listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
	const mock = {
		addEventListener: vi.fn((type: string, listener: (event: MessageEvent<string>) => void) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)?.add(listener);
		}),
		removeEventListener: vi.fn((type: string, listener: (event: MessageEvent<string>) => void) => {
			listeners.get(type)?.delete(listener);
		}),
		onerror: null as ((event: Event) => void) | null,
		close: vi.fn(),
		emitRaw(type: string, data: string) {
			listeners.get(type)?.forEach(listener => listener(new MessageEvent(type, { data })));
		},
		emit(type: string, data: unknown) {
			mock.emitRaw(type, JSON.stringify(data));
		},
		triggerError() { mock.onerror?.(new Event('error')); },
	};
	return mock;
}

function expectConnectionReleased(connection: ReturnType<typeof createMockEventSource>) {
	expect(connection.removeEventListener).toHaveBeenCalledExactlyOnceWith(
		'todos', connection.addEventListener.mock.calls[0][1],
	);
	expect(connection.onerror).toBeNull();
	expect(connection.close).toHaveBeenCalledOnce();
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('fromEventSource()', () => {
	it('emits decoded data for the named event type and cleans up after firstValueFrom', async () => {
		const connection = createMockEventSource();
		const todos = [{ id: '1', title: 'Test', completed: false, createdAt: '2026-09-17T00:00:00Z' }];
		const result = firstValueFrom(fromEventSource('/api/todos/stream', 'todos', decodeTodos, {
			createEventSource: () => connection,
		}));
		connection.emit('todos', todos);
		expect(await result).toEqual(todos);
		expectConnectionReleased(connection);
	});

	it('closes the EventSource when unsubscribed and ignores retained callbacks', () => {
		const connection = createMockEventSource();
		const decode = vi.fn(decodeNumber);
		const receive = vi.fn();
		const onError = vi.fn();
		const subscription = fromEventSource('/api/todos/stream', 'todos', decode, {
			createEventSource: () => connection,
		}).subscribe({ next: receive, error: onError });
		const retainedMessage = connection.addEventListener.mock.calls[0][1];
		const retainedError = connection.onerror;
		subscription.unsubscribe();
		subscription.unsubscribe();
		retainedMessage(new MessageEvent('todos', { data: '1' }));
		retainedError?.(new Event('error'));
		expect(decode).not.toHaveBeenCalled();
		expect(receive).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		expectConnectionReleased(connection);
	});

	it('closes the EventSource when the observable errors', () => {
		const connection = createMockEventSource();
		const onError = vi.fn();
		const subscription = fromEventSource('/api/todos/stream', 'todos', decodeNumber, {
			createEventSource: () => connection,
		}).subscribe({ error: onError });
		const retainedError = connection.onerror;
		connection.triggerError();
		retainedError?.(new Event('error'));
		subscription.unsubscribe();
		expect(subscription.closed).toBe(true);
		expect(onError).toHaveBeenCalledOnce();
		expectConnectionReleased(connection);
	});

	it('errors the Observable when EventSource fires onerror', () => {
		const connection = createMockEventSource();
		const onError = vi.fn();
		fromEventSource('/api/todos/stream', 'todos', decodeNumber, {
			createEventSource: () => connection,
		}).subscribe({ error: onError });
		connection.triggerError();
		expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('EventSource error'));
	});

	it('does not emit for unregistered event types', () => {
		const connection = createMockEventSource();
		const receive = vi.fn();
		const subscription = fromEventSource('/api/todos/stream', 'todos', decodeNumber, {
			createEventSource: () => connection,
		}).subscribe({ next: receive });
		connection.emit('other', 1);
		expect(receive).not.toHaveBeenCalled();
		subscription.unsubscribe();
	});

	it('rejects malformed JSON before decoding and releases its connection', () => {
		const connection = createMockEventSource();
		const decode = vi.fn(decodeTodos);
		const onError = vi.fn();
		const receive = vi.fn();
		fromEventSource('/api/todos/stream', 'todos', decode, {
			createEventSource: () => connection,
		}).subscribe({ next: receive, error: onError });
		connection.emitRaw('todos', '{invalid');
		connection.emit('todos', []);
		expect(decode).not.toHaveBeenCalled();
		expect(receive).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(SyntaxError));
		expectConnectionReleased(connection);
	});

	it.each([
		{ payload: { todos: [] } },
		{ payload: [{ id: '1', title: 'Missing date', completed: false }] },
		{ payload: [{ id: '1', title: 'Wrong type', completed: 'false', createdAt: '2026-09-17T00:00:00Z' }] },
	])('rejects invalid Todo payload %# without emitting a value', ({ payload }) => {
		const connection = createMockEventSource();
		const receive = vi.fn();
		const onError = vi.fn();
		fromEventSource('/api/todos/stream', 'todos', decodeTodos, {
			createEventSource: () => connection,
		}).subscribe({ next: receive, error: onError });
		connection.emit('todos', payload);
		connection.emit('todos', []);
		expect(receive).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(z.ZodError));
		expectConnectionReleased(connection);
	});

	it('creates one injected connection per subscription and disposes them independently', () => {
		const firstConnection = createMockEventSource();
		const secondConnection = createMockEventSource();
		const createEventSource = vi.fn()
			.mockReturnValueOnce(firstConnection)
			.mockReturnValueOnce(secondConnection);
		const source = fromEventSource('/api/todos/stream', 'todos', decodeNumber, { createEventSource });
		expect(createEventSource).not.toHaveBeenCalled();
		const firstReceive = vi.fn();
		const secondReceive = vi.fn();
		const first = source.subscribe(firstReceive);
		const second = source.subscribe(secondReceive);
		expect(createEventSource).toHaveBeenCalledTimes(2);
		expect(createEventSource).toHaveBeenNthCalledWith(1, '/api/todos/stream');
		expect(createEventSource).toHaveBeenNthCalledWith(2, '/api/todos/stream');
		first.unsubscribe();
		firstConnection.emit('todos', 1);
		secondConnection.emit('todos', 2);
		expect(firstReceive).not.toHaveBeenCalled();
		expect(secondReceive).toHaveBeenCalledExactlyOnceWith(2);
		expect(secondConnection.close).not.toHaveBeenCalled();
		second.unsubscribe();
		expectConnectionReleased(firstConnection);
		expectConnectionReleased(secondConnection);
	});

	it('constructs the default browser EventSource only when subscribed', () => {
		const connection = createMockEventSource();
		const construct = vi.fn(function EventSource() { return connection; });
		vi.stubGlobal('EventSource', construct);
		const source = fromEventSource('/api/todos/stream', 'todos', decodeNumber);
		expect(construct).not.toHaveBeenCalled();
		const subscription = source.subscribe();
		expect(construct).toHaveBeenCalledExactlyOnceWith('/api/todos/stream');
		subscription.unsubscribe();
		expectConnectionReleased(connection);
	});

	it('releases handlers when firstValueFrom unsubscribes during listener attachment', async () => {
		const connection = createMockEventSource();
		const attach = connection.addEventListener.getMockImplementation()!;
		connection.addEventListener.mockImplementation((type, listener) => {
			attach(type, listener);
			connection.emit(type, 1);
		});
		const result = firstValueFrom(fromEventSource('/api/todos/stream', 'todos', decodeNumber, {
			createEventSource: () => connection,
		}));
		expect(await result).toBe(1);
		expectConnectionReleased(connection);
	});
});
