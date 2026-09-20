import { Observable, Subject, Subscriber, of, take, throwError } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { allocateTraceId, createTrace, createTraceRecorder, emitTrace, traceObservable, traceRuntimeId, type Trace, type TraceContext, type TraceInput, type TraceRecord } from './trace';

const context: TraceContext = { scopeId: 'app:1', sourceId: 'todo.create', operationId: 'client:1/create:1' };
const input: TraceInput = { ...context, event: 'source.received' };

function recording(capacity = 1000) {
	const recorder = createTraceRecorder({ capacity });
	const trace = createTrace({ runtimeId: 'test', now: () => 10, sink: recorder.sink });
	return { recorder, trace };
}

describe('runtime-local tracing', () => {
	it('is inert and allocates distinct identities without sampling time', () => {
		const now = vi.fn(() => 0);
		const sink = vi.fn();
		const trace = createTrace({ runtimeId: 'client', now, sink });
		expect(trace.allocateId('app')).toBe('app:1');
		expect(trace.allocateId('app')).toBe('app:2');
		expect(now).not.toHaveBeenCalled();
		expect(sink).not.toHaveBeenCalled();
		expect(trace.diagnostics.emitted).toBe(0);
	});

	it('orders equal and backward clock samples only by runtime-local sequence', () => {
		const recorder = createTraceRecorder();
		const times = [5, 5, 2];
		const trace = createTrace({ runtimeId: 'client', now: () => times.shift()!, sink: recorder.sink });
		trace.emit(input); trace.emit(input); trace.emit(input);
		expect(recorder.records().map(record => [record.sequence, record.time])).toEqual([[1, 5], [2, 5], [3, 2]]);
		const independent = createTrace({ runtimeId: 'worker', now: () => 1, sink: recorder.sink });
		independent.emit(input);
		expect(recorder.records()[3]).toMatchObject({ runtimeId: 'worker', sequence: 1, time: 1 });
	});

	it('copies only allowlisted metadata and identifiers and freezes emitted records', () => {
		const { trace, recorder } = recording();
		const metadata = { kind: 'CREATE_STARTED', count: 2, changed: true, title: 'SECRET_TITLE',
			password: 'SECRET_PASSWORD', headers: { Authorization: 'SECRET_TOKEN' }, reason: 'message with private contents' };
		const candidate = { ...input, collectionId: 'dev', stateGeneration: 'generation-a', revision: 4,
			connectionId: 'live:1', metadata, title: 'SECRET_TITLE', error: new Error('SECRET_ERROR'), url: 'https://secret' };
		trace.emit(candidate);
		metadata.count = 999;
		const record = recorder.records()[0];
		expect(record).toEqual({ ...input, runtimeId: 'test', sequence: 1, time: 10,
			collectionId: 'dev', stateGeneration: 'generation-a', revision: 4, connectionId: 'live:1',
			metadata: { kind: 'CREATE_STARTED', count: 2, changed: true } });
		expect(JSON.stringify(record)).not.toContain('SECRET');
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.metadata)).toBe(true);
		expect(Object.isFrozen(recorder.records())).toBe(true);
	});

	it('bounds retained records and counts each overwritten record', () => {
		const { trace, recorder } = recording(3);
		for (let index = 0; index < 8; index++) trace.emit(input);
		expect(recorder.records().map(record => record.sequence)).toEqual([6, 7, 8]);
		expect(recorder.dropped).toBe(5);
		expect(trace.diagnostics.emitted).toBe(8);
		const one = recording(1);
		one.trace.emit(input); one.trace.emit(input);
		expect(one.recorder.records().map(record => record.sequence)).toEqual([2]);
		expect(one.recorder.dropped).toBe(1);
	});

	it.each([0, -1, 1.5, Infinity, 10001])('rejects invalid recorder capacity %s', capacity => {
		expect(() => createTraceRecorder({ capacity })).toThrow(RangeError);
	});

	it('isolates throwing sinks and clocks and records invalid clocks as null', () => {
		const received: TraceRecord[] = [];
		let clockCalls = 0;
		const trace = createTrace({ runtimeId: 'test', now: () => {
			if (++clockCalls === 1) throw new Error('SECRET_CLOCK');
			return NaN;
		}, sink: record => { received.push(record); throw new Error('SECRET_SINK'); } });
		expect(() => { trace.emit(input); trace.emit(input); }).not.toThrow();
		expect(received.map(record => [record.sequence, record.time])).toEqual([[1, null], [2, null]]);
		expect(trace.diagnostics).toEqual({ emitted: 2, clockFailures: 2, sinkFailures: 2, reentrantDrops: 0, invalidRecords: 0 });
		expect(JSON.stringify(received)).not.toContain('SECRET');
	});

	it('drops reentrant clock and sink observations instead of recursively publishing them', () => {
		const received: TraceRecord[] = [];
		const trace: Trace = createTrace({ runtimeId: 'test', now: () => { trace.emit(input); return 1; },
			sink: record => { received.push(record); trace.emit(input); } });
		trace.emit(input); trace.emit(input);
		expect(received.map(record => record.sequence)).toEqual([1, 2]);
		expect(trace.diagnostics.reentrantDrops).toBe(4);
	});

	it('drops malformed records and throwing allowlisted getters, then continues', () => {
		const { trace, recorder } = recording();
		trace.emit({ ...input, event: 'SECRET_UNLISTED_EVENT' } as unknown as TraceInput);
		trace.emit({ ...input, scopeId: 'bad scope' });
		trace.emit({ ...input, get metadata(): never { throw new Error('SECRET_GETTER'); } });
		trace.emit(input);
		expect(trace.diagnostics.invalidRecords).toBe(3);
		expect(recorder.records()).toHaveLength(1);
		expect(recorder.records()[0].sequence).toBe(1);
	});

	it('keeps generated IDs within the accepted identifier bound', () => {
		const { trace, recorder } = recording();
		trace.emit({ ...input, scopeId: trace.allocateId('a'.repeat(160)) });
		expect(recorder.records()).toHaveLength(1);
	});

	it('isolates a host emitter exception and ignores an absent trace', () => {
		const broken = { emit() { throw new Error('broken'); } } as unknown as Trace;
		expect(() => emitTrace(broken, input)).not.toThrow();
		expect(() => emitTrace(undefined, input)).not.toThrow();
	});

	it('isolates host identity getters and calls while keeping fallback scope identities distinct', () => {
		const broken = {
			get runtimeId(): never { throw new Error('runtime identity'); },
			get allocateId(): never { throw new Error('scope identity'); },
		} as unknown as Trace;
		expect(traceRuntimeId(broken)).toBe('unavailable');
		const first = allocateTraceId(broken, 'app');
		const second = allocateTraceId(broken, 'app');
		expect(first).not.toBe(second);
		expect(allocateTraceId(undefined, 'app')).toBe('app');
		expect(traceRuntimeId(undefined)).toBe('unavailable');
		const badResult = { allocateId: () => 'bad id' } as unknown as Trace;
		expect(allocateTraceId(badResult, 'app')).toMatch(/^app:fallback:/);
	});
});

describe('inline Observable trace lifecycle', () => {
	it('returns the identical source when disabled and stays lazy when enabled', () => {
		const activate = vi.fn();
		const source = new Observable(activate);
		expect(traceObservable(source, undefined, context)).toBe(source);
		const { trace, recorder } = recording();
		const traced = traceObservable(source, trace, context);
		expect(activate).not.toHaveBeenCalled();
		expect(recorder.records()).toEqual([]);
		traced.subscribe().unsubscribe();
		expect(activate).toHaveBeenCalledOnce();
		expect(recorder.records().map(record => record.event)).toEqual(['effect.subscribe', 'effect.cancel']);
	});

	it('records virtual source time and preserves the value and completion protocol', () => {
		const scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'virtual', now: () => scheduler.now(), sink: recorder.sink });
		scheduler.run(({ cold, expectObservable, expectSubscriptions }) => {
			const source = cold('--a--b|');
			expectObservable(traceObservable(source, trace, context)).toBe('--a--b|');
			expectSubscriptions(source.subscriptions).toBe('^-----!');
		});
		expect(recorder.records().map(record => [record.event, record.time])).toEqual([
			['effect.subscribe', 0], ['effect.next', 2], ['effect.next', 5], ['effect.complete', 6],
		]);
	});

	it('preserves the original error without recording its payload', () => {
		const { trace, recorder } = recording();
		const error = new Error('SECRET_ERROR');
		const receive = vi.fn();
		traceObservable(throwError(() => error), trace, context).subscribe({ error: receive });
		expect(receive).toHaveBeenCalledExactlyOnceWith(error);
		expect(recorder.records().map(record => record.event)).toEqual(['effect.subscribe', 'effect.error']);
		expect(JSON.stringify(recorder.records())).not.toContain('SECRET');
	});

	it('cancels a synchronous source after the first value and releases a late returned teardown once', () => {
		const { trace, recorder } = recording();
		const values: number[] = [];
		const release = vi.fn();
		const produced: number[] = [];
		const source = new Observable<number>(subscriber => {
			for (const value of [1, 2, 3]) {
				if (subscriber.closed) break;
				produced.push(value);
				subscriber.next(value);
			}
			if (!subscriber.closed) subscriber.complete();
			return release;
		});
		const subscription = traceObservable(source, trace, context).pipe(take(1)).subscribe(value => values.push(value));
		subscription.unsubscribe();
		expect(values).toEqual([1]);
		expect(produced).toEqual([1]);
		expect(release).toHaveBeenCalledOnce();
		expect(recorder.records().map(record => record.event)).toEqual(['effect.subscribe', 'effect.next', 'effect.cancel']);
	});

	it('owns upstream before a subscribe observation cancels the destination', () => {
		const destination = new Subscriber<number>();
		const activate = vi.fn();
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'sync', sink: record => {
			recorder.sink(record);
			if (record.event === 'effect.subscribe') destination.unsubscribe();
		} });
		traceObservable(new Observable<number>(activate), trace, context).subscribe(destination);
		expect(activate).not.toHaveBeenCalled();
		expect(destination.closed).toBe(true);
		// The recursive cancel diagnostic is deliberately dropped; cancellation itself still happens.
		expect(trace.diagnostics.reentrantDrops).toBe(1);
	});

	it('does not turn ordinary completion into cancellation on later unsubscription', () => {
		const { trace, recorder } = recording();
		const subscription = traceObservable(of(1), trace, context).subscribe();
		subscription.unsubscribe();
		expect(recorder.records().map(record => record.event)).toEqual(['effect.subscribe', 'effect.next', 'effect.complete']);
	});

	it('lets sink and context getter failures leave every value and terminal notification intact', () => {
		const trace = createTrace({ runtimeId: 'test', sink() { throw new Error('sink'); } });
		const contextWithFailure = { ...context, get metadata(): never { throw new Error('projection'); } };
		const values: number[] = [];
		const complete = vi.fn();
		traceObservable(of(1, 2), trace, context).subscribe(value => values.push(value));
		traceObservable(of(3, 4), trace, contextWithFailure).subscribe({ next: value => values.push(value), complete });
		expect(values).toEqual([1, 2, 3, 4]);
		expect(complete).toHaveBeenCalledOnce();
		expect(trace.diagnostics.sinkFailures).toBe(4);
	});

	it('releases an active upstream observer on explicit cancellation with no terminal event', () => {
		const { trace, recorder } = recording();
		const source = new Subject<number>();
		const receive = vi.fn();
		const subscription = traceObservable(source, trace, context).subscribe(receive);
		expect(source.observed).toBe(true);
		source.next(1);
		subscription.unsubscribe();
		expect(source.observed).toBe(false);
		source.next(2);
		expect(receive).toHaveBeenCalledExactlyOnceWith(1);
		expect(recorder.records().map(record => record.event)).toEqual(['effect.subscribe', 'effect.next', 'effect.cancel']);
	});
});
