import { Subscriber, type Observable } from 'rxjs';
import { allocateTraceId, emitTrace, traceObservable, type Trace, type TraceContext, type TraceEvent, type TraceMetadata } from '../shared/trace';

export const LIVE_STREAM_LIMITS = Object.freeze({
	maxFrameBytes: 128 * 1_024,
	maxPendingBytes: 256 * 1_024,
	maxPendingEvents: 16,
});

export interface OwnedByteStreamOptions<T> {
	encode: (value: T) => Uint8Array;
	signal?: AbortSignal;
	/** Latest is valid only when every value replaces a complete snapshot. */
	policy?: 'fifo' | 'latest-snapshot';
	maxPendingEvents?: number;
	maxPendingBytes?: number;
	maxFrameBytes?: number;
	onFault?: (error: unknown) => void;
	trace?: Trace;
	traceContext?: TraceContext;
}

export interface OwnedByteStream {
	body: ReadableStream<Uint8Array>;
	start: () => void;
	dispose: (reason?: unknown) => void;
	resourceCounts: () => { active: number; listener: number; pendingEvents: number; pendingBytes: number };
}

/**
 * A response owns this subscription, not its finite descriptor/request operation.
 * Construction is inert. The native readable queue has highWaterMark 0: each
 * downstream pull permits one enqueue, with no detached async observer writes.
 * Only this bounded queue holds unsent frames. Platform/socket buffers and bytes
 * already handed to a consumer are outside these application resource counts.
 */
export function createOwnedByteStream<T>(source$: Observable<T>, options: OwnedByteStreamOptions<T>): OwnedByteStream {
	const maxEvents = options.maxPendingEvents ?? LIVE_STREAM_LIMITS.maxPendingEvents;
	const maxBytes = options.maxPendingBytes ?? LIVE_STREAM_LIMITS.maxPendingBytes;
	const maxFrame = options.maxFrameBytes ?? LIVE_STREAM_LIMITS.maxFrameBytes;
	const policy = options.policy ?? 'fifo';
	for (const limit of [maxEvents, maxBytes, maxFrame]) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Live stream limits must be positive safe integers');
	}
	if (policy !== 'fifo' && policy !== 'latest-snapshot') throw new TypeError('Unknown live stream delivery policy');
	if (maxFrame > maxBytes) throw new RangeError('Live frame limit exceeds pending byte capacity');

	let controller: ReadableStreamDefaultController<Uint8Array>;
	let source: Subscriber<T> | undefined;
	let started = false;
	let closed = false;
	let complete = false;
	let demand = false;
	let listening = false;
	let pendingBytes = 0;
	const pending: Uint8Array[] = [];
	const traceContext = options.traceContext ?? {
		scopeId: allocateTraceId(options.trace, 'live-response'), sourceId: 'http.live',
	};
	function resourceCounts() {
		return { active: source && !source.closed ? 1 : 0, listener: listening ? 1 : 0,
			pendingEvents: pending.length, pendingBytes };
	}
	function record(event: TraceEvent, metadata?: TraceMetadata): void {
		if (!options.trace) return;
		try { emitTrace(options.trace, { ...traceContext, event, metadata }); }
		catch { /* Diagnostic context getters cannot interfere with body cleanup. */ }
	}
	function resources(reason: string): void {
		const counts = resourceCounts();
		record('resource.state', {
			reason, active: counts.active, listeners: counts.listener,
			pendingEvents: counts.pendingEvents, pendingBytes: counts.pendingBytes,
		});
	}
	function connection(status: string): void {
		record('connection.change', { status });
	}

	function report(error: unknown): void {
		try { if (options.onFault) options.onFault(error); else console.error(error); } catch { /* Reporting cannot retain owned work. */ }
	}
	function releaseSource(): void {
		const owned = source;
		source = undefined;
		try { owned?.unsubscribe(); } catch (error) { report(error); }
	}
	function releaseListener(): void {
		if (!listening) return;
		listening = false;
		options.signal!.removeEventListener('abort', onAbort);
	}
	function release(): void {
		releaseSource();
		releaseListener();
		pending.length = 0;
		pendingBytes = 0;
		demand = false;
		resources('release');
		record('scope.dispose');
	}
	function fail(reason: unknown): void {
		if (closed) return;
		closed = true;
		release();
		connection('error');
		controller.error(reason instanceof Error ? reason : new Error('Live stream interrupted'));
	}
	function onAbort(): void { fail(new Error('Live response canceled')); }
	function drain(): void {
		if (closed) return;
		if (demand && pending.length) {
			demand = false;
			const frame = pending.shift()!;
			pendingBytes -= frame.byteLength;
			try { controller.enqueue(frame); } catch (error) { fail(error); return; }
			resources('delivered');
			if (closed) return; // A diagnostic observer can dispose the body reentrantly.
		}
		if (complete && !pending.length) {
			closed = true;
			release();
			connection('complete');
			controller.close();
		}
	}
	function next(value: T): void {
		if (closed) return;
		try {
			const frame = options.encode(value);
			if (!(frame instanceof Uint8Array)) throw new TypeError('Live encoder must produce bytes');
			if (frame.byteLength > maxFrame) throw new Error('Live frame exceeds byte limit');
			if (closed) return; // Encoding may synchronously cancel its owner.
			if (policy === 'latest-snapshot' && pending.length) {
				pending.length = 0;
				pendingBytes = 0;
			}
			if (pending.length >= maxEvents || pendingBytes + frame.byteLength > maxBytes) {
				throw new Error('Live pending queue capacity exceeded');
			}
			pending.push(frame);
			pendingBytes += frame.byteLength;
			resources('buffered');
			drain();
		} catch (error) { fail(error); }
	}
	function finish(): void {
		if (closed) return;
		complete = true;
		releaseSource();
		resources('source-complete');
		drain();
	}
	const body = new ReadableStream<Uint8Array>({
		start(value) { controller = value; },
		pull() { demand = true; drain(); },
		cancel() {
			if (closed) return;
			closed = true;
			release();
			connection('cancel');
		},
	}, { highWaterMark: 0 });

	function start(): void {
		if (started || closed) return;
		started = true;
		try {
			if (options.signal?.aborted) { onAbort(); return; }
			if (options.signal) {
				listening = true;
				options.signal.addEventListener('abort', onAbort, { once: true });
				if (options.signal.aborted) { onAbort(); return; }
			}
			// The subscriber exists before synchronous next/complete/error/abort.
			source = new Subscriber<T>({ next, error: fail, complete: finish });
			connection('open');
			resources('start');
			if (!closed) traceObservable(source$, options.trace, traceContext).subscribe(source);
		} catch (error) { if (closed) report(error); else fail(error); }
	}
	return {
		body, start, dispose: fail,
		resourceCounts,
	};
}
