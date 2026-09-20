import { Observable, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { createTrace, createTraceRecorder, traceObservable, type TraceDetails, type TraceRecord } from '../../shared/trace';
import { createProgram } from './program';
import { createScope } from './scope';

describe('owned runtime tracing', () => {
	it('does not evaluate diagnostic projections or add accumulation when tracing is absent', () => {
		const messageTrace = vi.fn(() => ({}));
		const transitionTrace = vi.fn(() => ({}));
		const reduce = vi.fn((state: number, message: number) => state + message);
		const program = createProgram({ initialState: () => 0, reduce, messageTrace, transitionTrace });
		const first: number[] = [];
		const second: number[] = [];
		program.state$.subscribe(value => first.push(value));
		program.state$.subscribe(value => second.push(value));
		program.transitions$.subscribe();
		program.start(); program.dispatch(1); program.dispose();
		expect(first).toEqual([0, 1]);
		expect(second).toEqual(first);
		expect(reduce).toHaveBeenCalledOnce();
		expect(messageTrace).not.toHaveBeenCalled();
		expect(transitionTrace).not.toHaveBeenCalled();
	});

	it('records source and state before rendering with only projected correlation, not domain payloads', () => {
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'test', now: () => 0, sink: recorder.sink });
		const order: string[] = [];
		const program = createProgram({ initialState: () => 0,
			reduce: (state, message: { id: string; title: string }) => state + message.title.length,
			trace, scopeId: 'app:1/model', sourceId: 'todo.ingress',
			messageTrace: message => ({ operationId: message.id, metadata: { kind: 'CREATE_REQUESTED' } }),
			transitionTrace: transition => {
				order.push('transition');
				return { revision: transition.state, metadata: { count: transition.state } };
			},
		});
		program.state$.subscribe(() => order.push('render'));
		program.start();
		program.dispatch({ id: 'operation:1', title: 'SECRET' });
		expect(order).toEqual(['render', 'transition', 'render']);
		expect(recorder.records().map(record => record.event)).toEqual(['state.transition', 'source.received', 'state.transition']);
		expect(recorder.records()[2]).toMatchObject({ operationId: 'operation:1', revision: 6,
			metadata: { kind: 'CREATE_REQUESTED', count: 6, changed: true } });
		expect(JSON.stringify(recorder.records())).not.toContain('SECRET');
		program.dispose();
	});

	it('keeps one accumulation and unchanged results with extra readers and a throwing diagnostic sink', () => {
		const reduce = vi.fn((state: number, message: number) => state + message);
		const trace = createTrace({ runtimeId: 'test', sink() { throw new Error('observer failed'); } });
		const program = createProgram({ initialState: () => 0, reduce, trace });
		const states: number[] = [];
		program.state$.subscribe(value => states.push(value));
		program.state$.subscribe(); program.transitions$.subscribe(); program.transitions$.subscribe();
		program.start(); program.dispatch(1); program.dispatch(2); program.dispose();
		expect(states).toEqual([0, 1, 3]);
		expect(reduce).toHaveBeenCalledTimes(2);
		expect(trace.diagnostics.sinkFailures).toBe(6);
	});

	it('isolates throwing diagnostic projections and getter-bearing projection objects', () => {
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'test', sink: recorder.sink });
		const program = createProgram({ initialState: () => 0, reduce: (state, value: number) => state + value, trace,
			messageTrace: () => { throw new Error('message projection'); },
			transitionTrace: (): TraceDetails => ({ get metadata(): never { throw new Error('metadata projection'); } }),
		});
		const states: number[] = [];
		program.state$.subscribe(value => states.push(value));
		program.start();
		expect(() => program.dispatch(2)).not.toThrow();
		expect(states).toEqual([0, 2]);
		expect(program.closed).toBe(false);
		program.dispose();
	});

	it('retains FIFO input order if a diagnostic sink deliberately dispatches reentrantly', () => {
		let feedback: (() => void) | undefined;
		const records: TraceRecord[] = [];
		const trace = createTrace({ runtimeId: 'test', sink: record => {
			records.push(record);
			if (record.event === 'source.received' && feedback) {
				const act = feedback; feedback = undefined; act();
			}
		} });
		const program = createProgram({ initialState: () => '', reduce: (state, message: string) => state + message, trace });
		const states: string[] = [];
		program.state$.subscribe(value => states.push(value));
		program.start();
		feedback = () => { program.dispatch('B'); };
		program.dispatch('A');
		expect(states).toEqual(['', 'A', 'AB']);
		expect(trace.diagnostics.reentrantDrops).toBeGreaterThan(0);
		program.dispose();
	});

	it('gives separate program factories and child scopes distinct local identities', () => {
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'test', sink: recorder.sink });
		const first = createProgram({ initialState: () => 0, reduce: (state: number) => state, trace });
		const second = createProgram({ initialState: () => 0, reduce: (state: number) => state, trace });
		const parent = createScope({ trace });
		const child = parent.child();
		child.dispose(); child.dispose(); parent.dispose(); first.dispose(); second.dispose();
		const disposals = recorder.records().filter(record => record.event === 'scope.dispose');
		expect(disposals).toHaveLength(4);
		expect(new Set(disposals.map(record => record.scopeId)).size).toBe(4);
	});

	it('releases synchronous source teardown once when its owner disposes on the first next', () => {
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'test', sink: recorder.sink });
		const scope = createScope({ trace, id: 'app' });
		const release = vi.fn();
		const source = new Observable<number>(subscriber => { subscriber.next(1); subscriber.next(2); return release; });
		const values: number[] = [];
		scope.subscribe(traceObservable(source, trace, { scopeId: 'app', sourceId: 'sync' }), {
			next: value => { values.push(value); scope.dispose(); },
		});
		scope.dispose();
		expect(values).toEqual([1]);
		expect(release).toHaveBeenCalledOnce();
		expect(scope.closed).toBe(true);
		expect(recorder.records().map(record => record.event)).toEqual([
			'effect.subscribe', 'effect.next', 'scope.dispose', 'effect.cancel',
		]);
	});

	it('does not activate a traced source after its scope is disposed', () => {
		const recorder = createTraceRecorder();
		const trace = createTrace({ runtimeId: 'test', sink: recorder.sink });
		const scope = createScope({ trace });
		const receive = vi.fn();
		scope.dispose();
		scope.subscribe(traceObservable(of(1), trace, { scopeId: 'app', sourceId: 'sync' }), { next: receive });
		expect(receive).not.toHaveBeenCalled();
		expect(recorder.records().map(record => record.event)).toEqual(['scope.dispose']);
	});
});
