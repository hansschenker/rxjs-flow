import { PassThrough } from 'node:stream';
import type * as http from 'node:http';
import { Observable, Subject } from 'rxjs';
import { vi } from 'vitest';
import { BadRequestError, applySse, formatSseChunk, parseBody } from './http';
import type { SseEvent } from './types';

describe('parseBody()', () => {
	it('preserves the baseline rejection of a JSON byte-order mark', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const result = parseBody(req);
		req.emit('data', Buffer.from('\uFEFF{"title":"BOM"}'));
		req.emit('end');
		await expect(result).rejects.toMatchObject({ status: 400, message: 'Malformed JSON' });
	});

	it('rejects malformed UTF-8 bytes instead of replacing the payload', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const result = parseBody(req);
		req.emit('data', Buffer.from([0x22, 0xff, 0x22]));
		req.emit('end');
		await expect(result).rejects.toMatchObject({ status: 400, message: 'Malformed UTF-8 request body' });
	});

	it('removes body listeners immediately when the owner cancels', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const controller = new AbortController();
		const result = parseBody(req, controller.signal);
		req.emit('data', Buffer.from('{"title":'));
		controller.abort();
		await expect(result).rejects.toMatchObject({ status: 499 });
		for (const event of ['data', 'end', 'error', 'aborted']) expect(req.listenerCount(event)).toBe(0);
	});

	it('never attaches a body reader for an already canceled request', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const controller = new AbortController();
		controller.abort();
		await expect(parseBody(req, controller.signal)).rejects.toMatchObject({ status: 499 });
		expect(req.listenerCount('data')).toBe(0);
	});

	it('releases buffered bytes and listeners on overflow without waiting for end', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const result = parseBody(req);
		req.emit('data', Buffer.alloc(1024 * 1024 + 1));
		await expect(result).rejects.toMatchObject({ status: 413 });
		for (const event of ['data', 'end', 'error', 'aborted']) expect(req.listenerCount(event)).toBe(0);
	});

	it('preserves UTF-8 characters split across incoming chunks', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const result = parseBody(req);
		const bytes = Buffer.from('{"title":"☕"}');
		const split = bytes.indexOf(Buffer.from('☕')) + 1;
		req.emit('data', bytes.subarray(0, split));
		req.emit('data', bytes.subarray(split));
		req.emit('end');
		await expect(result).resolves.toEqual({ title: '☕' });
	});

	it('rejects when the request stream errors', async () => {
		const req = new PassThrough() as unknown as http.IncomingMessage;
		const result = parseBody(req);

		req.emit('error', new Error('boom'));

		await expect(result).rejects.toBeInstanceOf(BadRequestError);
	});
});

describe('formatSseChunk()', () => {
	it('serialises data as JSON with trailing double newline', () => {
		expect(formatSseChunk({ data: { id: '1' } })).toBe('data: {"id":"1"}\n\n');
	});

	it('includes event field when present', () => {
		expect(formatSseChunk({ event: 'todos', data: [] })).toBe('event: todos\ndata: []\n\n');
	});

	it('includes id field before event and data', () => {
		expect(formatSseChunk({ id: '42', event: 'ping', data: null })).toBe('id: 42\nevent: ping\ndata: null\n\n');
	});
});

describe('applySse()', () => {
	it('contains a throwing stream teardown at the response-close boundary', () => {
		let close!: () => void;
		const lifetime = { on: (_: string, listener: () => void) => { close = listener; }, off: vi.fn() };
		const response = { write: vi.fn(), end: vi.fn() };
		const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const stream = new Observable<SseEvent>(() => () => { throw new Error('teardown failure'); });
			const subscription = applySse(stream, lifetime, response);
			expect(() => close()).not.toThrow();
			expect(subscription.closed).toBe(true);
			expect(lifetime.off).toHaveBeenCalledOnce();
			expect(logger).toHaveBeenCalledOnce();
		} finally { logger.mockRestore(); }
	});

	it('registers ownership before a synchronous emission can close the response', () => {
		let close!: () => void;
		const lifetime = { on: (_: string, listener: () => void) => { close = listener; }, off: vi.fn() };
		const response = { write: vi.fn(() => close()), end: vi.fn() };
		const release = vi.fn();
		const stream = new Observable<SseEvent>(observer => {
			observer.next({ data: 'first' });
			observer.next({ data: 'after close' });
			return release;
		});
		const subscription = applySse(stream, lifetime, response);
		expect(response.write).toHaveBeenCalledOnce();
		expect(subscription.closed).toBe(true);
		expect(release).toHaveBeenCalledOnce();
		expect(lifetime.off).toHaveBeenCalledOnce();
	});

	it('writes a formatted chunk for each emission', () => {
		const source = new Subject<SseEvent>();
		const writes: string[] = [];
		const mockRes = { write: (chunk: string) => { writes.push(chunk); }, end: vi.fn() };
		const mockReq = { on: vi.fn() };

		applySse(source, mockReq, mockRes);
		source.next({ event: 'todos', data: [1, 2] });
		source.next({ data: 'ping' });

		expect(writes).toEqual(['event: todos\ndata: [1,2]\n\n', 'data: "ping"\n\n']);
		expect(mockRes.end).not.toHaveBeenCalled();
	});

	it('calls res.end() when the source completes', () => {
		const source = new Subject<SseEvent>();
		const mockRes = { write: vi.fn(), end: vi.fn() };
		const mockReq = { on: vi.fn() };

		applySse(source, mockReq, mockRes);
		source.complete();

		expect(mockRes.end).toHaveBeenCalledOnce();
	});

	it('calls res.end() when the source errors', () => {
		const source = new Subject<SseEvent>();
		const mockRes = { write: vi.fn(), end: vi.fn() };
		const mockReq = { on: vi.fn() };

		applySse(source, mockReq, mockRes);
		source.error(new Error('boom'));

		expect(mockRes.end).toHaveBeenCalledOnce();
	});

	it('stops writing after the client disconnects', () => {
		const source = new Subject<SseEvent>();
		const mockRes = { write: vi.fn(), end: vi.fn() };
		let closeHandler: (() => void) | undefined;
		const mockReq = { on: (_: string, handler: () => void) => { closeHandler = handler; } };

		applySse(source, mockReq, mockRes);
		closeHandler!();
		source.next({ data: 'after disconnect' });

		expect(mockRes.write).not.toHaveBeenCalled();
		expect(mockRes.end).not.toHaveBeenCalled();
	});
});
