import { EMPTY, NEVER, Observable, Subject, finalize, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { encodeSseEvent } from '../server/core/sse-event';
import { createOwnedByteStream, type OwnedByteStreamOptions } from './owned-byte-stream';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);
const baseline = { active: 0, listener: 0, pendingEvents: 0, pendingBytes: 0 };
const options = (overrides: Partial<OwnedByteStreamOptions<string>> = {}): OwnedByteStreamOptions<string> => ({ encode, ...overrides });

describe('Response-owned bounded bytes in workerd', () => {
	it('construction and an idle reader are inert; start subscribes once', async () => {
		const subscribe = vi.fn(() => () => {});
		const live = createOwnedByteStream(new Observable<string>(subscribe), options());
		const reader = live.body.getReader();
		expect(live.resourceCounts()).toEqual(baseline);
		live.start(); live.start();
		expect(subscribe).toHaveBeenCalledTimes(1);
		await reader.cancel();
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('canceling before start permanently prevents activation', async () => {
		const subscribe = vi.fn();
		const live = createOwnedByteStream(new Observable<string>(subscribe), options());
		await live.body.cancel();
		live.start();
		expect(subscribe).not.toHaveBeenCalled();
	});

	it('already aborted input never subscribes and removes every resource', async () => {
		const subscribe = vi.fn();
		const abort = new AbortController(); abort.abort();
		const live = createOwnedByteStream(new Observable<string>(subscribe), options({ signal: abort.signal }));
		live.start();
		await expect(live.body.getReader().read()).rejects.toThrow('canceled');
		expect(subscribe).not.toHaveBeenCalled();
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('synchronous empty completion closes and releases its late returned teardown', async () => {
		const cleanup = vi.fn();
		const live = createOwnedByteStream(new Observable<string>(subscriber => {
			subscriber.complete(); return cleanup;
		}), options({ signal: new AbortController().signal }));
		live.start();
		expect(await live.body.getReader().read()).toEqual({ done: true, value: undefined });
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('synchronous source error is visible and releases its late returned teardown', async () => {
		const cleanup = vi.fn();
		const live = createOwnedByteStream(new Observable<string>(subscriber => {
			subscriber.error(new Error('source fault')); return cleanup;
		}), options({ signal: new AbortController().signal }));
		live.start();
		await expect(live.body.getReader().read()).rejects.toThrow('source fault');
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('handles abort during synchronous subscription setup', async () => {
		const abort = new AbortController();
		const cleanup = vi.fn();
		const live = createOwnedByteStream(new Observable<string>(subscriber => {
			subscriber.next('first'); abort.abort(); subscriber.next('ignored'); return cleanup;
		}), options({ signal: abort.signal }));
		live.start();
		await expect(live.body.getReader().read()).rejects.toThrow('canceled');
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('keeps finite source output bounded until a delayed reader consumes in order', async () => {
		const cleanup = vi.fn();
		const live = createOwnedByteStream(of('one', 'two', 'three').pipe(finalize(cleanup)), options({ signal: new AbortController().signal }));
		live.start();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(live.resourceCounts()).toEqual({ active: 0, listener: 1, pendingEvents: 3, pendingBytes: 11 });
		const reader = live.body.getReader();
		expect(decode((await reader.read()).value)).toBe('one');
		expect(live.resourceCounts().pendingEvents).toBe(2);
		expect(decode((await reader.read()).value)).toBe('two');
		expect(decode((await reader.read()).value)).toBe('three');
		expect((await reader.read()).done).toBe(true);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('waits for demand without detached writes and serializes multiple pending reads', async () => {
		const source = new Subject<string>();
		const live = createOwnedByteStream(source, options()); live.start();
		const reader = live.body.getReader();
		const a = reader.read(); const b = reader.read();
		source.next('a'); source.next('b'); source.next('c');
		expect(decode((await a).value)).toBe('a');
		expect(decode((await b).value)).toBe('b');
		expect(live.resourceCounts().pendingEvents).toBe(1);
		expect(decode((await reader.read()).value)).toBe('c');
		await reader.cancel();
		expect(source.observed).toBe(false);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('FIFO event overflow visibly fails instead of silently dropping domain events', async () => {
		const source = new Subject<string>();
		const live = createOwnedByteStream(source, options({ maxPendingEvents: 2 })); live.start();
		source.next('one'); source.next('two');
		expect(live.resourceCounts().pendingEvents).toBe(2);
		source.next('three');
		await expect(live.body.getReader().read()).rejects.toThrow('capacity');
		expect(source.observed).toBe(false);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('bounds pending bytes separately from event count', async () => {
		const live = createOwnedByteStream(of('abcd', 'abc'), options({ maxPendingBytes: 6, maxFrameBytes: 6 }));
		live.start();
		await expect(live.body.getReader().read()).rejects.toThrow('capacity');
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('bounds each encoded frame including multibyte UTF-8', async () => {
		const live = createOwnedByteStream(of('🦊'), options({ maxPendingBytes: 3, maxFrameBytes: 3 }));
		live.start();
		await expect(live.body.getReader().read()).rejects.toThrow('frame');
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('explicit full snapshots coalesce to one latest pending value', async () => {
		const source = new Subject<string>();
		const live = createOwnedByteStream(source, options({ policy: 'latest-snapshot' })); live.start();
		for (let index = 0; index < 1_000; index++) source.next(String(index));
		expect(live.resourceCounts()).toMatchObject({ pendingEvents: 1, pendingBytes: 3 });
		const reader = live.body.getReader();
		expect(decode((await reader.read()).value)).toBe('999');
		source.next('1000'); source.next('1001');
		expect(decode((await reader.read()).value)).toBe('1001');
		source.complete();
		expect((await reader.read()).done).toBe(true);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('source failure discards pending data and errors an established response body', async () => {
		const source = new Subject<string>();
		const live = createOwnedByteStream(source, options()); live.start();
		const response = new Response(live.body);
		const reader = response.body!.getReader();
		source.next('delivered');
		expect(decode((await reader.read()).value)).toBe('delivered');
		source.next('unsent'); source.error(new Error('authority interrupted'));
		await expect(reader.read()).rejects.toThrow('authority interrupted');
		expect(response.status).toBe(200);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('real Response body cancellation clears source, abort listener and buffered bytes once', async () => {
		const abort = new AbortController();
		const add = vi.spyOn(abort.signal, 'addEventListener');
		const remove = vi.spyOn(abort.signal, 'removeEventListener');
		const source = new Subject<string>(); const cleanup = vi.fn();
		const live = createOwnedByteStream(source.pipe(finalize(cleanup)), options({ signal: abort.signal }));
		const response = new Response(live.body); live.start(); source.next('queued');
		await response.body!.cancel(); abort.abort(); live.dispose(); live.dispose();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it('canceling A leaves B subscribed to the same independent source', async () => {
		const source = new Subject<string>();
		const a = createOwnedByteStream(source, options());
		const b = createOwnedByteStream(source, options()); a.start(); b.start();
		await new Response(a.body).body!.cancel();
		source.next('B');
		expect(decode((await b.body.getReader().read()).value)).toBe('B');
		expect(source.observed).toBe(true);
		b.dispose();
		expect(source.observed).toBe(false);
		expect(a.resourceCounts()).toEqual(baseline); expect(b.resourceCounts()).toEqual(baseline);
	});

	it('contains serialization failure and a throwing cleanup without retaining listeners', async () => {
		const onFault = vi.fn();
		const source = new Observable<string>(subscriber => { subscriber.next('x'); return () => { throw new Error('cleanup'); }; });
		const live = createOwnedByteStream(source, options({
			encode: () => { throw new Error('encode'); }, onFault, signal: new AbortController().signal,
		}));
		live.start();
		await expect(live.body.getReader().read()).rejects.toThrow('encode');
		expect(onFault).toHaveBeenCalledTimes(1);
		expect(live.resourceCounts()).toEqual(baseline);
	});

	it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid limits %s before subscribing', value => {
		const subscribe = vi.fn();
		expect(() => createOwnedByteStream(new Observable<string>(subscribe), options({ maxPendingEvents: value }))).toThrow();
		expect(subscribe).not.toHaveBeenCalled();
	});

	it('rejects inconsistent byte bounds and unknown policy', () => {
		expect(() => createOwnedByteStream(EMPTY, options({ maxFrameBytes: 4, maxPendingBytes: 3 }))).toThrow();
		expect(() => createOwnedByteStream(NEVER, options({ policy: 'drop-events' as 'fifo' }))).toThrow();
	});

	it('formats the unchanged JSON SSE protocol and rejects injection/unrepresentable data', () => {
		expect(decode(encodeSseEvent({ event: 'todos', id: '1', data: [{ title: 'line\nbreak' }] })))
			.toBe('id: 1\nevent: todos\ndata: [{"title":"line\\nbreak"}]\n\n');
		for (const invalid of [{ event: 'bad\nevent', data: [] }, { id: '\0', data: [] }, { data: undefined }, { data: 1n }]) {
			expect(() => encodeSseEvent(invalid)).toThrow();
		}
	});
});
