import { describe, expect, it, vi } from 'vitest';
import {
	EMPTY,
	NEVER,
	Observable,
	of,
	queueScheduler,
	Subject,
	throwError,
	VirtualTimeScheduler,
	type Subscriber,
} from 'rxjs';
import { BadRequest, NotFound, Unauthorized } from './errors';
import { createRequestOperation, type RequestOutcome } from './request-operation';

const success = <T>(value: T): RequestOutcome<T> => ({ kind: 'success', value });

describe('request operation ownership', () => {
	it('construction and result observers are inert; start executes once for all consumers', () => {
		const controller = new AbortController();
		const listen = vi.spyOn(controller.signal, 'addEventListener');
		const execute = vi.fn(() => of('response'));
		const operation = createRequestOperation({ signal: controller.signal, execute });
		const first: RequestOutcome<string>[] = [];
		const second: RequestOutcome<string>[] = [];
		operation.result$.subscribe(value => first.push(value));
		operation.result$.subscribe(value => second.push(value));
		expect(execute).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
		operation.start();
		operation.start();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(first).toEqual([success('response')]);
		expect(second).toEqual(first);
		const late: RequestOutcome<string>[] = [];
		const complete = vi.fn();
		operation.result$.subscribe({ next: value => late.push(value), complete });
		expect(late).toEqual(first);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('continues without observers and replays its result without executing again', () => {
		const source = new Subject<string>();
		const execute = vi.fn(() => source);
		const operation = createRequestOperation({ signal: new AbortController().signal, execute });
		const observer = operation.result$.subscribe();
		operation.start();
		observer.unsubscribe();
		expect(source.observed).toBe(true);
		source.next('owned');
		source.complete();
		const outcomes: RequestOutcome<string>[] = [];
		operation.result$.subscribe(value => outcomes.push(value));
		expect(outcomes).toEqual([success('owned')]);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('waits for completion and supports an undefined response value', () => {
		const source = new Subject<undefined>();
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute: () => source,
		});
		const outcomes: RequestOutcome<undefined>[] = [];
		operation.result$.subscribe(value => outcomes.push(value));
		operation.start();
		source.next(undefined);
		expect(outcomes).toEqual([]);
		source.complete();
		expect(outcomes).toEqual([success(undefined)]);
	});

	it('releases the timer, execution and input-abort listener after success', () => {
		const scheduler = new VirtualTimeScheduler();
		const external = new AbortController();
		const remove = vi.spyOn(external.signal, 'removeEventListener');
		const teardown = vi.fn();
		let ownedSignal!: AbortSignal;
		const operation = createRequestOperation({
			signal: external.signal, scheduler,
			execute: signal => {
				ownedSignal = signal;
				return new Observable<string>(subscriber => {
					subscriber.next('done');
					subscriber.complete();
					return teardown;
				});
			},
		});
		const outcomes: RequestOutcome<string>[] = [];
		operation.result$.subscribe(value => outcomes.push(value));
		operation.start();
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(scheduler.actions).toHaveLength(0);
		expect(ownedSignal.aborted).toBe(false);
		external.abort();
		operation.dispose();
		expect(outcomes).toEqual([success('done')]);
	});

	it('accepts a streaming descriptor without subscribing or disposing its body', () => {
		const bodySubscribed = vi.fn();
		const body = new Observable(bodySubscribed);
		const descriptor = { status: 200, stream: body };
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute: () => of(descriptor),
		});
		const outcomes: RequestOutcome<typeof descriptor>[] = [];
		operation.result$.subscribe(value => outcomes.push(value));
		operation.start();
		operation.dispose();
		expect(outcomes).toEqual([success(descriptor)]);
		expect(bodySubscribed).not.toHaveBeenCalled();
	});
});

describe('finite response outcomes', () => {
	it('defines an empty handler as 500', () => {
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute: () => EMPTY,
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 500,
			body: { error: 'Finite operation completed without a response' },
		});
	});

	it('rejects a second value immediately and stops a cooperative synchronous producer', () => {
		let emitted = 0;
		const teardown = vi.fn();
		const scheduler = new VirtualTimeScheduler();
		const operation = createRequestOperation({
			signal: new AbortController().signal, scheduler,
			execute: () => new Observable<number>(subscriber => {
				for (let value = 0; value < 100 && !subscriber.closed; value += 1) {
					emitted += 1;
					subscriber.next(value);
				}
				return teardown;
			}),
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 500,
			body: { error: 'Finite operation emitted multiple responses' },
		});
		expect(emitted).toBe(2);
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(scheduler.actions).toHaveLength(0);
	});

	it('an error after one value wins over that uncompleted candidate', () => {
		const source = new Subject<string>();
		const onFault = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute: () => source, onFault,
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		source.next('candidate');
		const error = new Error('failed after candidate');
		source.error(error);
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 500, body: { error: 'Internal server error' },
		});
		expect(onFault).toHaveBeenCalledExactlyOnceWith(error);
	});

	it.each([
		new BadRequest('Invalid title', { field: 'title' }),
		new Unauthorized(),
		new NotFound('Missing Todo'),
	])('preserves shared HTTP status and structured error for $status', error => {
		const onFault = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal,
			execute: () => throwError(() => error), onFault,
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		const body = error.details === undefined
			? { error: error.message }
			: { error: error.message, details: error.details };
		expect(outcome).toHaveBeenCalledExactlyOnceWith({ kind: 'failure', status: error.status, body });
		expect(onFault).not.toHaveBeenCalled();
	});

	it('guards synchronous execute construction throws and leaves another operation usable', () => {
		const error = new Error('construction failed');
		const onFault = vi.fn();
		const failed = createRequestOperation({
			signal: new AbortController().signal,
			execute: (): Observable<never> => { throw error; }, onFault,
		});
		const good = createRequestOperation({
			signal: new AbortController().signal, execute: () => of('next request'),
		});
		const failedOutcome = vi.fn();
		const goodOutcome = vi.fn();
		failed.result$.subscribe(failedOutcome);
		good.result$.subscribe(goodOutcome);
		expect(failed.start).not.toThrow();
		good.start();
		expect(failedOutcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 500, body: { error: 'Internal server error' },
		});
		expect(goodOutcome).toHaveBeenCalledExactlyOnceWith(success('next request'));
		expect(onFault).toHaveBeenCalledExactlyOnceWith(error);
	});

	it('guards synchronous Observable initialization throws', () => {
		const error = new Error('subscribe failed');
		const onFault = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal, onFault,
			execute: () => new Observable(() => { throw error; }),
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		expect(operation.start).not.toThrow();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 500, body: { error: 'Internal server error' },
		});
		expect(onFault).toHaveBeenCalledExactlyOnceWith(error);
	});
});

describe('absolute request deadline', () => {
	it.each(['never emits', 'emits once without completing'])('settles 504 when the source %s', behavior => {
		const scheduler = new VirtualTimeScheduler();
		const source = new Subject<string>();
		const teardown = vi.fn();
		let ownedSignal!: AbortSignal;
		const operation = createRequestOperation({
			signal: new AbortController().signal, deadlineMs: 10, scheduler,
			execute: signal => {
				ownedSignal = signal;
				return new Observable<string>(subscriber => {
					const subscription = source.subscribe(subscriber);
					subscription.add(teardown);
					return subscription;
				});
			},
		});
		const observed: Array<{ at: number; outcome: RequestOutcome<string> }> = [];
		operation.result$.subscribe(outcome => observed.push({ at: scheduler.now(), outcome }));
		operation.start();
		if (behavior === 'emits once without completing') scheduler.schedule(() => source.next('candidate'), 8);
		scheduler.maxFrames = 9;
		scheduler.flush();
		expect(observed).toEqual([]);
		scheduler.maxFrames = 10;
		scheduler.flush();
		expect(observed).toEqual([{
			at: 10,
			outcome: { kind: 'failure', status: 504, body: { error: 'Request deadline exceeded' } },
		}]);
		expect(ownedSignal.aborted).toBe(true);
		expect(source.observed).toBe(false);
		expect(teardown).toHaveBeenCalledTimes(1);
	});

	it('has a default deadline of 10000ms from activation', () => {
		const scheduler = new VirtualTimeScheduler();
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute: () => NEVER, scheduler,
		});
		const observed: number[] = [];
		operation.result$.subscribe(() => observed.push(scheduler.now()));
		scheduler.schedule(operation.start, 30);
		scheduler.flush();
		expect(observed).toEqual([10_030]);
	});

	it('a synchronous zero deadline prevents execution', () => {
		const execute = vi.fn(() => NEVER);
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute, scheduler: queueScheduler, deadlineMs: 0,
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(execute).not.toHaveBeenCalled();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 504, body: { error: 'Request deadline exceeded' },
		});
	});

	it.each(['construction', 'next', 'complete'])('rejects a synchronous %s overrun before its queued deadline callback can run', phase => {
		const scheduler = new VirtualTimeScheduler();
		let clock = 0;
		vi.spyOn(scheduler, 'now').mockImplementation(() => clock);
		const subscribed = vi.fn();
		const teardown = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal, scheduler, deadlineMs: 10,
			execute: () => {
				if (phase === 'construction') clock = 11;
				return new Observable<string>(subscriber => {
					subscribed();
					if (phase === 'next') clock = 11;
					subscriber.next('candidate');
					if (phase === 'complete') clock = 11;
					subscriber.complete();
					return teardown;
				});
			},
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 504, body: { error: 'Request deadline exceeded' },
		});
		expect(scheduler.actions).toHaveLength(0);
		expect(subscribed).toHaveBeenCalledTimes(phase === 'construction' ? 0 : 1);
		expect(teardown).toHaveBeenCalledTimes(phase === 'construction' ? 0 : 1);
	});

	it.each([-1, Infinity, NaN])('rejects an invalid deadline %s without starting the operation', deadlineMs => {
		const execute = vi.fn(() => NEVER);
		const onFault = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal, execute, deadlineMs, onFault,
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		expect(operation.start).not.toThrow();
		expect(execute).not.toHaveBeenCalled();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 500, body: { error: 'Internal server error' },
		});
		expect(onFault).toHaveBeenCalledExactlyOnceWith(expect.any(RangeError));
	});
});

describe('request cancellation and reentrant cleanup', () => {
	it('does not execute an already-aborted request', () => {
		const external = new AbortController();
		external.abort();
		const execute = vi.fn(() => NEVER);
		const operation = createRequestOperation({ signal: external.signal, execute });
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(execute).not.toHaveBeenCalled();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
	});

	it('disposal before start is final and repeated disposal is harmless', () => {
		const execute = vi.fn(() => NEVER);
		const operation = createRequestOperation({ signal: new AbortController().signal, execute });
		const outcome = vi.fn();
		operation.dispose();
		operation.dispose();
		operation.start();
		operation.result$.subscribe(outcome);
		expect(execute).not.toHaveBeenCalled();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
	});

	it('canceling A tears down only A; simultaneous B can still complete', () => {
		const aController = new AbortController();
		const aSource = new Subject<string>();
		const bSource = new Subject<string>();
		let aSignal!: AbortSignal;
		let bSignal!: AbortSignal;
		const a = createRequestOperation({
			signal: aController.signal, execute: signal => { aSignal = signal; return aSource; },
		});
		const b = createRequestOperation({
			signal: new AbortController().signal, execute: signal => { bSignal = signal; return bSource; },
		});
		const aOutcome = vi.fn();
		const bOutcome = vi.fn();
		a.result$.subscribe(aOutcome);
		b.result$.subscribe(bOutcome);
		a.start();
		b.start();
		aController.abort();
		expect(aSignal.aborted).toBe(true);
		expect(bSignal.aborted).toBe(false);
		expect(aSource.observed).toBe(false);
		expect(bSource.observed).toBe(true);
		bSource.next('B survives');
		bSource.complete();
		expect(aOutcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
		expect(bOutcome).toHaveBeenCalledExactlyOnceWith(success('B survives'));
	});

	it('disposal during execute construction prevents the returned source from subscribing', () => {
		const subscribed = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal,
			execute: (): Observable<never> => {
				operation.dispose();
				return new Observable(subscribed);
			},
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(subscribed).not.toHaveBeenCalled();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
	});

	it('abort during synchronous subscription closes the already-registered subscriber', () => {
		const external = new AbortController();
		const teardown = vi.fn();
		let closedAfterAbort = false;
		const operation = createRequestOperation({
			signal: external.signal,
			execute: () => new Observable<string>(subscriber => {
				external.abort();
				closedAfterAbort = subscriber.closed;
				subscriber.next('too late');
				subscriber.complete();
				return teardown;
			}),
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(closedAfterAbort).toBe(true);
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
	});

	it('closes execution before abort-driven source errors can replace the cancellation outcome', () => {
		const external = new AbortController();
		const onFault = vi.fn();
		let captured!: Subscriber<string>;
		const operation = createRequestOperation({
			signal: external.signal, onFault,
			execute: signal => new Observable<string>(subscriber => {
				captured = subscriber;
				signal.addEventListener('abort', () => subscriber.error(new Error('aborted body')));
			}),
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		external.abort();
		expect(captured.closed).toBe(true);
		expect(onFault).not.toHaveBeenCalled();
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
	});

	it('reports a throwing synchronous returned teardown without changing an already settled success', () => {
		const error = new Error('teardown failed');
		const onFault = vi.fn();
		const operation = createRequestOperation({
			signal: new AbortController().signal, onFault,
			execute: () => new Observable<string>(subscriber => {
				subscriber.next('success');
				subscriber.complete();
				return () => { throw error; };
			}),
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		expect(operation.start).not.toThrow();
		expect(outcome).toHaveBeenCalledExactlyOnceWith(success('success'));
		expect(onFault).toHaveBeenCalledExactlyOnceWith(error);
	});

	it('runs remaining cleanup and settles cancellation despite throwing teardown and reporter', () => {
		const scheduler = new VirtualTimeScheduler();
		const teardown = vi.fn();
		const onFault = vi.fn(() => { throw new Error('reporter also failed'); });
		let ownedSignal!: AbortSignal;
		const operation = createRequestOperation({
			signal: new AbortController().signal, scheduler, onFault,
			execute: signal => {
				ownedSignal = signal;
				return new Observable(subscriber => {
					subscriber.add(() => { throw new Error('first teardown failed'); });
					subscriber.add(teardown);
				});
			},
		});
		const outcome = vi.fn();
		operation.result$.subscribe(outcome);
		operation.start();
		expect(operation.dispose).not.toThrow();
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(onFault).toHaveBeenCalledTimes(1);
		expect(ownedSignal.aborted).toBe(true);
		expect(scheduler.actions).toHaveLength(0);
		expect(outcome).toHaveBeenCalledExactlyOnceWith({
			kind: 'failure', status: 499, body: { error: 'Request canceled' },
		});
	});
});
