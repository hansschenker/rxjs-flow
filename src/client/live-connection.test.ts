import { Subject, Subscriber, Subscription, VirtualTimeScheduler, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveConnection$, type LiveConnectionEvent, type LiveConnectionOptions } from './live-connection';
import type { EventSourceConnection } from './sse';

function decodeNumber(value: unknown): number {
	if (typeof value !== 'number') throw new Error('Expected a number.');
	return value;
}

function createConnection() {
	const listeners = new Set<(event: MessageEvent<string>) => void>();
	const connection = {
		addEventListener: vi.fn(function attach(_type: string, listener: (event: MessageEvent<string>) => void) {
			listeners.add(listener);
		}),
		removeEventListener: vi.fn(function detach(_type: string, listener: (event: MessageEvent<string>) => void) {
			listeners.delete(listener);
		}),
		onerror: null as EventSourceConnection['onerror'],
		close: vi.fn(),
		raw(data: string) {
			for (const listener of [...listeners]) listener(new MessageEvent('snapshot', { data }));
		},
		value(value: unknown) { connection.raw(JSON.stringify(value)); },
		fail() { connection.onerror?.(new Event('error')); },
		get listenerCount() { return listeners.size; },
	};
	return connection;
}

const owners: Subscription[] = [];

afterEach(function releaseTests() {
	for (const owner of owners.splice(0)) owner.unsubscribe();
});

function advanceTo(scheduler: VirtualTimeScheduler, frame: number): void {
	scheduler.maxFrames = frame;
	scheduler.flush();
	scheduler.frame = frame;
}

/** Test-only ownership census against the pinned RxJS 7 subscription tree. */
function ownedSubscriptions(root: Subscription): number {
	const waiting: Subscription[] = [root];
	const seen = new Set<Subscription>();
	while (waiting.length > 0) {
		const subscription = waiting.pop()!;
		if (seen.has(subscription)) continue;
		seen.add(subscription);
		const children = (subscription as unknown as { _finalizers?: unknown[] })._finalizers ?? [];
		for (const child of children) if (child instanceof Subscription) waiting.push(child);
	}
	return seen.size;
}

function setup(options: LiveConnectionOptions = {}) {
	const scheduler = new VirtualTimeScheduler();
	const connections: ReturnType<typeof createConnection>[] = [];
	const events: Array<{ frame: number; event: LiveConnectionEvent<number> }> = [];
	const recover$ = new Subject<void>();
	const createEventSource = vi.fn(function create() {
		const connection = createConnection();
		connections.push(connection);
		return connection;
	});
	const source = liveConnection$('/api/todos/live', 'snapshot', decodeNumber, {
		scheduler, recover$, createEventSource, ...options,
	});
	function record(event: LiveConnectionEvent<number>): void { events.push({ frame: scheduler.now(), event }); }
	function subscribe() {
		const subscription = source.subscribe(record);
		owners.push(subscription);
		return subscription;
	}
	return { scheduler, connections, events, recover$, createEventSource, source, subscribe };
}

describe('liveConnection$ ownership and recovery', () => {
	it('is cold and emits connection identity before opening its source', () => {
		const run = setup();
		expect(run.createEventSource).not.toHaveBeenCalled();
		const subscription = run.subscribe();
		expect(run.events).toEqual([{ frame: 0, event: { type: 'connecting', connectionId: 1, attempt: 1 } }]);
		expect(run.createEventSource).toHaveBeenCalledExactlyOnceWith('/api/todos/live');
		run.connections[0].value(3);
		expect(run.events[1].event).toEqual({ type: 'snapshot', connectionId: 1, value: 3 });
		subscription.unsubscribe();
		expect(run.connections[0].listenerCount).toBe(0);
		expect(run.connections[0].onerror).toBeNull();
		expect(run.connections[0].close).toHaveBeenCalledOnce();
	});

	it('closes native EventSource before announcing the RxJS retry and waits injected time', () => {
		const run = setup();
		const closedBeforeRetry: boolean[] = [];
		owners.push(run.source.subscribe(function observe(event) {
			if (event.type === 'reconnecting') closedBeforeRetry.push(run.connections[0].close.mock.calls.length === 1);
		}));
		run.connections[0].fail();
		expect(closedBeforeRetry).toEqual([true]);
		expect(run.connections[0].onerror).toBeNull();
		advanceTo(run.scheduler, 999);
		expect(run.connections).toHaveLength(1);
		advanceTo(run.scheduler, 1_000);
		expect(run.connections).toHaveLength(2);
	});

	it('bounds consecutive failures to four waits and five attempts, then waits for manual recovery', () => {
		const run = setup();
		run.subscribe();
		for (const [index, frame] of [1_000, 3_000, 7_000, 15_000].entries()) {
			run.connections[index].fail();
			advanceTo(run.scheduler, frame);
		}
		run.connections[4].fail();
		expect(run.events.at(-1)?.event).toMatchObject({ type: 'failed', connectionId: 5, attempt: 5, failure: 'transport' });
		advanceTo(run.scheduler, 100_000);
		expect(run.connections).toHaveLength(5);
		run.recover$.next();
		expect(run.connections).toHaveLength(6);
		expect(run.events.at(-1)?.event).toEqual({ type: 'connecting', connectionId: 6, attempt: 1 });
	});

	it('resets the consecutive failure budget after a validated snapshot', () => {
		const run = setup({ retryDelaysMs: [10] });
		run.subscribe();
		run.connections[0].fail();
		advanceTo(run.scheduler, 10);
		run.connections[1].value(1);
		run.connections[1].fail();
		expect(run.events.at(-1)?.event).toMatchObject({ type: 'reconnecting', connectionId: 2, attempt: 2, delayMs: 10 });
		advanceTo(run.scheduler, 20);
		expect(run.connections).toHaveLength(3);
		run.connections[2].fail();
		expect(run.events.at(-1)?.event).toMatchObject({ type: 'failed', connectionId: 3, failure: 'transport' });
	});

	it('requires a first snapshot within ten seconds and closes the timed out source', () => {
		const run = setup();
		run.subscribe();
		advanceTo(run.scheduler, 9_999);
		expect(run.events).toHaveLength(1);
		advanceTo(run.scheduler, 10_000);
		expect(run.connections[0].close).toHaveBeenCalledOnce();
		expect(run.events.at(-1)?.event).toMatchObject({ type: 'reconnecting', message: 'No live snapshot received within 10000 ms.' });
		advanceTo(run.scheduler, 11_000);
		expect(run.connections).toHaveLength(2);
	});

	it('cancels the first-snapshot deadline when a snapshot arrives and leaves an idle healthy source open', () => {
		const run = setup();
		run.subscribe();
		advanceTo(run.scheduler, 9_999);
		run.connections[0].value(1);
		advanceTo(run.scheduler, 100_000);
		expect(run.connections).toHaveLength(1);
		expect(run.connections[0].close).not.toHaveBeenCalled();
		expect(run.events).toHaveLength(2);
	});

	it.each(['{broken', '"wrong type"'])('rejects protocol failure %s with no automatic retry', raw => {
		const run = setup();
		run.subscribe();
		run.connections[0].raw(raw);
		expect(run.events.at(-1)?.event).toMatchObject({ type: 'failed', failure: 'protocol', connectionId: 1 });
		expect(run.connections[0].close).toHaveBeenCalledOnce();
		advanceTo(run.scheduler, 100_000);
		expect(run.connections).toHaveLength(1);
		run.recover$.next();
		run.connections[1].value(4);
		expect(run.events.at(-1)?.event).toEqual({ type: 'snapshot', connectionId: 2, value: 4 });
	});

	it('classifies a decoder throwing a primitive as a protocol failure', () => {
		const connection = createConnection();
		const events: LiveConnectionEvent<never>[] = [];
		owners.push(liveConnection$('/live', 'snapshot', function reject(): never { throw 'wrong history'; }, {
			createEventSource: () => connection,
		}).subscribe(event => events.push(event)));
		connection.value(1);
		expect(events.at(-1)).toMatchObject({ type: 'failed', failure: 'protocol' });
		expect(connection.close).toHaveBeenCalledOnce();
	});

	it('supplies first-snapshot context per connection and retains monotonic IDs through manual recovery', () => {
		const recover$ = new Subject<void>();
		const connections: ReturnType<typeof createConnection>[] = [];
		const decode = vi.fn(decodeNumber);
		owners.push(liveConnection$('/live', 'snapshot', decode, {
			recover$,
			createEventSource() { const connection = createConnection(); connections.push(connection); return connection; },
		}).subscribe());
		connections[0].value(1);
		connections[0].value(2);
		recover$.next();
		connections[1].value(3);
		expect(decode.mock.calls).toEqual([
			[1, { connectionId: 1, firstSnapshot: true }],
			[2, { connectionId: 1, firstSnapshot: false }],
			[3, { connectionId: 2, firstSnapshot: true }],
		]);
		expect(connections[0].close).toHaveBeenCalledOnce();
	});

	it('discards retained old callbacks without decoding after a new connection supersedes them', () => {
		const run = setup();
		run.subscribe();
		const staleMessage = run.connections[0].addEventListener.mock.calls[0][1];
		const staleError = run.connections[0].onerror;
		run.recover$.next();
		staleMessage(new MessageEvent('snapshot', { data: '{invalid' }));
		staleError?.(new Event('error'));
		run.connections[1].value(8);
		expect(run.events.map(entry => entry.event.type)).toEqual(['connecting', 'connecting', 'snapshot']);
		expect(run.events.at(-1)?.event).toEqual({ type: 'snapshot', connectionId: 2, value: 8 });
	});

	it('manual recovery cancels a pending retry and does not create a duplicate later', () => {
		const run = setup();
		run.subscribe();
		run.connections[0].fail();
		advanceTo(run.scheduler, 500);
		run.recover$.next();
		run.connections[1].value(1);
		advanceTo(run.scheduler, 20_000);
		expect(run.connections).toHaveLength(2);
		expect(run.events.at(-2)?.event).toEqual({ type: 'connecting', connectionId: 2, attempt: 1 });
	});

	it('unmount during a retry releases recovery ownership and opens nothing later', () => {
		const run = setup();
		const subscription = run.subscribe();
		run.connections[0].fail();
		subscription.unsubscribe();
		run.recover$.next();
		advanceTo(run.scheduler, 100_000);
		expect(run.connections).toHaveLength(1);
		expect(run.recover$.observed).toBe(false);
		expect(run.scheduler.actions).toHaveLength(0);
	});

	it('unmount before the first snapshot cancels its deadline', () => {
		const run = setup();
		const subscription = run.subscribe();
		subscription.unsubscribe();
		advanceTo(run.scheduler, 100_000);
		expect(run.connections).toHaveLength(1);
		expect(run.events).toHaveLength(1);
		expect(run.scheduler.actions).toHaveLength(0);
	});

	it('does not open a connection when disposed synchronously from connecting', () => {
		const createEventSource = vi.fn(createConnection);
		const owner = new Subscriber<LiveConnectionEvent<number>>({
			next() { owner.unsubscribe(); }, error(error: unknown) { throw error; }, complete() {},
		});
		liveConnection$('/live', 'snapshot', decodeNumber, { createEventSource }).subscribe(owner);
		expect(createEventSource).not.toHaveBeenCalled();
	});

	it('owns a connection returned after construction reentrantly disposes its subscriber', () => {
		const connection = createConnection();
		const owner = new Subscriber<LiveConnectionEvent<number>>();
		liveConnection$('/live', 'snapshot', decodeNumber, {
			createEventSource() { owner.unsubscribe(); return connection; },
		}).subscribe(owner);
		expect(connection.close).toHaveBeenCalledOnce();
		expect(connection.addEventListener).not.toHaveBeenCalled();
		expect(connection.onerror).toBeNull();
	});

	it('handles manual recovery synchronously from the connecting notification without opening the old source', () => {
		const run = setup();
		owners.push(run.source.subscribe(function recoverDuringSetup(event) {
			if (event.type === 'connecting' && event.connectionId === 1) run.recover$.next();
		}));
		expect(run.connections).toHaveLength(1);
		expect(run.createEventSource).toHaveBeenCalledOnce();
	});

	it('handles a synchronous recovery source without creating an extra initial connection', () => {
		const run = setup({ recover$: of(undefined) });
		run.subscribe();
		expect(run.connections).toHaveLength(1);
		expect(run.events).toHaveLength(1);
	});

	it('releases late-attached handlers when a synchronous snapshot supersedes its connection', () => {
		const first = createConnection();
		const second = createConnection();
		const recover$ = new Subject<void>();
		const attach = first.addEventListener.getMockImplementation()!;
		first.addEventListener.mockImplementation(function emitThenAttach(type, listener) {
			listener(new MessageEvent(type, { data: '1' }));
			attach(type, listener);
		});
		const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		owners.push(liveConnection$('/live', 'snapshot', decodeNumber, { recover$, createEventSource: factory }).subscribe(function recoverOnValue(event) {
			if (event.type === 'snapshot' && event.connectionId === 1) recover$.next();
		}));
		expect(first.close).toHaveBeenCalledOnce();
		expect(first.listenerCount).toBe(0);
		expect(first.onerror).toBeNull();
		expect(second.close).not.toHaveBeenCalled();
	});

	it('treats constructor failure as a bounded transport failure', () => {
		const events: LiveConnectionEvent<number>[] = [];
		const scheduler = new VirtualTimeScheduler();
		const createEventSource = vi.fn(function failSetup(): EventSourceConnection { throw new Error('Unavailable'); });
		owners.push(liveConnection$('/live', 'snapshot', decodeNumber, {
			scheduler, retryDelaysMs: [1], createEventSource,
		}).subscribe(event => events.push(event)));
		advanceTo(scheduler, 100);
		expect(createEventSource).toHaveBeenCalledTimes(2);
		expect(events.at(-1)).toMatchObject({ type: 'failed', failure: 'transport', message: 'Unavailable' });
	});

	it('closes a partially attached connection on setup failure before retrying', () => {
		const connection = createConnection();
		const attach = connection.addEventListener.getMockImplementation()!;
		connection.addEventListener.mockImplementation(function failAttachment(type, listener) {
			attach(type, listener);
			throw new Error('Cannot attach');
		});
		const run = setup({ createEventSource: () => connection, retryDelaysMs: [] });
		run.subscribe();
		expect(connection.close).toHaveBeenCalledOnce();
		expect(connection.listenerCount).toBe(0);
		expect(connection.onerror).toBeNull();
		expect(run.events.at(-1)?.event).toMatchObject({ type: 'failed', failure: 'transport' });
	});

	it('owns independent cycles for distinct subscribers without one cancellation stopping another', () => {
		const run = setup();
		const first = run.subscribe();
		const second = run.subscribe();
		first.unsubscribe();
		run.connections[1].value(5);
		expect(run.connections[0].close).toHaveBeenCalledOnce();
		expect(run.connections[1].close).not.toHaveBeenCalled();
		expect(second.closed).toBe(false);
	});

	it('keeps ownership bounded across 2000 successful reconnects and releases every prior connection', () => {
		const run = setup({ retryDelaysMs: [1] });
		const owner = run.subscribe();
		run.connections[0].value(0);
		const baselineOwners = ownedSubscriptions(owner);
		for (let index = 0; index < 2_000; index++) {
			run.connections[index].fail();
			advanceTo(run.scheduler, index + 1);
			run.connections[index + 1].value(index + 1);
		}
		expect(ownedSubscriptions(owner)).toBe(baselineOwners);
		expect(run.scheduler.actions).toHaveLength(0);
		for (const previous of run.connections.slice(0, -1)) {
			expect(previous.close).toHaveBeenCalledOnce();
			expect(previous.listenerCount).toBe(0);
			expect(previous.onerror).toBeNull();
		}
		expect(run.connections.at(-1)?.close).not.toHaveBeenCalled();
		owner.unsubscribe();
		expect(ownedSubscriptions(owner)).toBe(1);
		expect(run.connections.at(-1)?.close).toHaveBeenCalledOnce();
	});

	it.each([
		{ retryDelaysMs: [-1] }, { retryDelaysMs: [Infinity] },
		{ retryDelaysMs: [0.1] }, { initialSnapshotTimeoutMs: 0 },
		{ initialSnapshotTimeoutMs: NaN },
	])('rejects invalid timing before creating resources %#', options => {
		const run = setup(options);
		const error = vi.fn();
		run.source.subscribe({ error });
		expect(error).toHaveBeenCalledExactlyOnceWith(expect.any(RangeError));
		expect(run.createEventSource).not.toHaveBeenCalled();
		expect(run.recover$.observed).toBe(false);
	});
});
