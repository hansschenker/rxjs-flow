import { EventEmitter } from 'node:events';
import { Observable, Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { applySse, formatSseChunk, prepareNodeResponse } from './http';
import type { SseEvent } from './types';

const createTransport = () => {
	const lifetime = new EventEmitter();
	const response = Object.assign(new EventEmitter(), {
		write: vi.fn<(_chunk: string) => boolean>(() => true),
		end: vi.fn(),
		destroy: vi.fn(),
		destroyed: false,
		writableEnded: false,
	});
	return { lifetime, response };
};

const expectReleased = (lifetime: EventEmitter, response: EventEmitter): void => {
	expect(lifetime.listenerCount('close')).toBe(0);
	expect(response.listenerCount('drain')).toBe(0);
	expect(response.listenerCount('error')).toBe(0);
};

describe('retained Node bounded SSE owner', () => {
	it('removes fixed content lengths from prepared live responses', () => {
		const stream = new Subject<SseEvent>();
		const prepared = prepareNodeResponse({ stream, headers: { 'cOnTeNt-LeNgTh': '0' } });
		expect(Object.keys(prepared.headers).some(name => name.toLowerCase() === 'content-length')).toBe(false);
		expect(prepared.stream).toBe(stream);
		expect(stream.observed).toBe(false);
	});

	it('serializes FIFO writes, waits for drain, and flushes the accepted queue before completion', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValueOnce(false);
		const events = new Subject<SseEvent>();
		const owner = applySse(events, lifetime, response);
		events.next({ data: 1 });
		events.next({ data: 2 });
		events.next({ data: 3 });
		events.complete();
		expect(response.write.mock.calls).toEqual([['data: 1\n\n']]);
		expect(response.end).not.toHaveBeenCalled();
		expect(owner.closed).toBe(false);
		response.emit('drain');
		expect(response.write.mock.calls).toEqual([['data: 1\n\n'], ['data: 2\n\n'], ['data: 3\n\n']]);
		expect(response.end).toHaveBeenCalledOnce();
		expect(response.destroy).not.toHaveBeenCalled();
		expect(owner.closed).toBe(true);
		expectReleased(lifetime, response);
	});

	it('waits again when the next queued write also fills the transport', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValueOnce(false).mockReturnValueOnce(false);
		const owner = applySse(of({ data: 1 }, { data: 2 }, { data: 3 }), lifetime, response);
		response.emit('drain');
		expect(response.write).toHaveBeenCalledTimes(2);
		expect(response.end).not.toHaveBeenCalled();
		response.emit('drain');
		expect(response.write).toHaveBeenCalledTimes(3);
		expect(response.end).toHaveBeenCalledOnce();
		expect(owner.closed).toBe(true);
	});

	it('coalesces only when the route explicitly selects full latest snapshots', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValueOnce(false);
		const events = new Subject<SseEvent>();
		const owner = applySse(events, lifetime, response, { policy: 'latest-snapshot' });
		events.next({ data: { revision: 1 } });
		events.next({ data: { revision: 2 } });
		events.next({ data: { revision: 3 } });
		events.complete();
		response.emit('drain');
		expect(response.write.mock.calls).toEqual([
			[formatSseChunk({ data: { revision: 1 } })], [formatSseChunk({ data: { revision: 3 } })],
		]);
		expect(owner.closed).toBe(true);
	});

	it('fails FIFO overflow visibly rather than silently discarding domain events', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValue(false);
		const events = new Subject<SseEvent>();
		const owner = applySse(events, lifetime, response, { maxPendingEvents: 2 });
		for (let value = 1; value <= 4; value++) events.next({ data: value });
		expect(response.write).toHaveBeenCalledOnce();
		expect(response.destroy).toHaveBeenCalledOnce();
		expect(response.end).not.toHaveBeenCalled();
		expect(owner.closed).toBe(true);
		expect(events.observed).toBe(false);
		response.emit('drain');
		expect(response.write).toHaveBeenCalledOnce();
		expectReleased(lifetime, response);
	});

	it('bounds encoded pending bytes independently of the event count', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValue(false);
		const events = new Subject<SseEvent>();
		const owner = applySse(events, lifetime, response, { maxPendingBytes: 20 });
		events.next({ data: 'first' });
		events.next({ data: 'abcdefgh' });
		events.next({ data: 'abcdefgh' });
		expect(owner.closed).toBe(true);
		expect(response.destroy).toHaveBeenCalledOnce();
	});

	it('rejects a frame by encoded UTF-8 byte size before writing it', () => {
		const { lifetime, response } = createTransport();
		const owner = applySse(of({ data: '☕☕☕' }), lifetime, response, { maxFrameBytes: 16 });
		expect(response.write).not.toHaveBeenCalled();
		expect(response.destroy).toHaveBeenCalledOnce();
		expect(owner.closed).toBe(true);
	});

	it('closes canceled backpressure waits and releases source/listeners without another write', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValue(false);
		const events = new Subject<SseEvent>();
		const owner = applySse(events, lifetime, response);
		events.next({ data: 1 });
		events.next({ data: 2 });
		lifetime.emit('close');
		response.emit('drain');
		expect(events.observed).toBe(false);
		expect(response.write).toHaveBeenCalledOnce();
		expect(response.end).not.toHaveBeenCalled();
		expect(owner.closed).toBe(true);
		expectReleased(lifetime, response);
	});

	it('never subscribes to an already closed transport or aborted response signal', () => {
		for (const canceledBy of ['transport', 'signal'] as const) {
			const { lifetime, response } = createTransport();
			const controller = new AbortController();
			if (canceledBy === 'transport') response.destroyed = true;
			else controller.abort();
			const activate = vi.fn();
			const owner = applySse(new Observable(activate), lifetime, response, { signal: controller.signal });
			expect(activate).not.toHaveBeenCalled();
			expect(owner.closed).toBe(true);
			expectReleased(lifetime, response);
		}
	});

	it('handles synchronous error and producer failure after headers by destroying the response', () => {
		for (const stream of [throwError(() => new Error('source failed')), new Observable<SseEvent>(() => { throw new Error('setup failed'); })]) {
			const { lifetime, response } = createTransport();
			const owner = applySse(stream, lifetime, response);
			expect(owner.closed).toBe(true);
			expect(response.destroy).toHaveBeenCalledOnce();
			expect(response.end).not.toHaveBeenCalled();
			expectReleased(lifetime, response);
		}
	});

	it('handles write errors and malformed JSON frames without escaping the observer', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const badData of [cyclic, undefined, Symbol('bad-json')]) {
			const { lifetime, response } = createTransport();
			expect(() => applySse(of({ data: badData }), lifetime, response)).not.toThrow();
			expect(response.destroy).toHaveBeenCalledOnce();
			expectReleased(lifetime, response);
		}
		const { lifetime, response } = createTransport();
		response.write.mockImplementation(() => { throw new Error('write failed'); });
		expect(() => applySse(of({ data: 1 }), lifetime, response)).not.toThrow();
		expect(response.destroy).toHaveBeenCalledOnce();
		expectReleased(lifetime, response);
	});

	it('contains throwing synchronous finalizers and still releases transport listeners', () => {
		const { lifetime, response } = createTransport();
		const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const stream = new Observable<SseEvent>(observer => {
				observer.complete();
				return () => { throw new Error('finalizer failed'); };
			});
			expect(() => applySse(stream, lifetime, response)).not.toThrow();
			expect(response.end).toHaveBeenCalledOnce();
			expectReleased(lifetime, response);
		} finally { logger.mockRestore(); }
	});

	it('aborts a blocked response signal, releases its queue, and interrupts the transport', () => {
		const { lifetime, response } = createTransport();
		response.write.mockReturnValue(false);
		const events = new Subject<SseEvent>();
		const controller = new AbortController();
		const owner = applySse(events, lifetime, response, { signal: controller.signal });
		events.next({ data: 1 });
		events.next({ data: 2 });
		controller.abort();
		controller.abort();
		expect(owner.closed).toBe(true);
		expect(response.destroy).toHaveBeenCalledOnce();
		expect(events.observed).toBe(false);
		expectReleased(lifetime, response);
	});

	it('never attaches later listeners if lifetime registration synchronously closes', () => {
		const { response } = createTransport();
		const lifetime = { on: (_: string, close: () => void) => { close(); }, off: vi.fn() };
		const activate = vi.fn();
		const owner = applySse(new Observable(activate), lifetime, response);
		expect(owner.closed).toBe(true);
		expect(activate).not.toHaveBeenCalled();
		expect(lifetime.off).toHaveBeenCalledOnce();
		expect(response.listenerCount('drain')).toBe(0);
		expect(response.listenerCount('error')).toBe(0);
	});

	it('cleans up partially registered listeners when transport setup fails', () => {
		const { lifetime, response } = createTransport();
		const register = response.on.bind(response);
		vi.spyOn(response, 'on').mockImplementation((event, listener) => {
			register(event, listener);
			if (event === 'error') throw new Error('setup failed');
			return response;
		});
		const activate = vi.fn();
		const owner = applySse(new Observable(activate), lifetime, response);
		expect(owner.closed).toBe(true);
		expect(activate).not.toHaveBeenCalled();
		expect(response.destroy).toHaveBeenCalledOnce();
		expectReleased(lifetime, response);
	});

	it('serializes reentrant source emissions from the transport write callback', () => {
		const { lifetime, response } = createTransport();
		const events = new Subject<SseEvent>();
		let writesActive = 0;
		response.write.mockImplementation(chunk => {
			writesActive++;
			expect(writesActive).toBe(1);
			if (chunk === 'data: 1\n\n') events.next({ data: 2 });
			writesActive--;
			return true;
		});
		const owner = applySse(events, lifetime, response);
		events.next({ data: 1 });
		expect(response.write.mock.calls).toEqual([['data: 1\n\n'], ['data: 2\n\n']]);
		owner.unsubscribe();
		expectReleased(lifetime, response);
	});
});
