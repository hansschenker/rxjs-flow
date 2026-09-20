import { Observable, Subscriber } from 'rxjs';

/** Runtime-local observations; timestamps from different runtimes are not ordered. */
export type TraceEvent =
	| 'source.received' | 'intent.accepted' | 'state.transition'
	| 'effect.subscribe' | 'effect.next' | 'effect.error' | 'effect.complete' | 'effect.cancel'
	| 'authority.recovered' | 'authority.admit' | 'authority.start' | 'authority.error'
	| 'authority.commit' | 'authority.publish' | 'authority.reply-detached'
	| 'render.commit' | 'connection.change' | 'scope.dispose' | 'resource.state';

/** Fixed metadata vocabulary. Domain values, errors, URLs and credentials are excluded. */
export interface TraceMetadata {
	readonly kind?: string;
	readonly status?: string;
	readonly outcome?: string;
	readonly reason?: string;
	readonly count?: number;
	readonly active?: number;
	readonly queued?: number;
	readonly pending?: number;
	readonly subscribers?: number;
	readonly listeners?: number;
	readonly pendingEvents?: number;
	readonly pendingBytes?: number;
	readonly capacity?: number;
	readonly attempt?: number;
	readonly delayMs?: number;
	readonly dropped?: number;
	readonly durationMs?: number;
	readonly changed?: boolean;
}

export interface TraceDetails {
	readonly operationId?: string;
	readonly collectionId?: string;
	readonly stateGeneration?: string;
	readonly revision?: number;
	readonly connectionId?: string;
	readonly metadata?: TraceMetadata;
}

export interface TraceContext extends TraceDetails {
	readonly scopeId: string;
	readonly sourceId: string;
}

export interface TraceInput extends TraceContext {
	readonly event: TraceEvent;
}

export interface TraceRecord extends TraceInput {
	readonly runtimeId: string;
	readonly sequence: number;
	/** Null means the injected clock failed, not that the application failed. */
	readonly time: number | null;
}

export interface TraceDiagnostics {
	readonly emitted: number;
	readonly sinkFailures: number;
	readonly clockFailures: number;
	readonly reentrantDrops: number;
	readonly invalidRecords: number;
}

export interface Trace {
	readonly runtimeId: string;
	readonly diagnostics: TraceDiagnostics;
	allocateId(prefix: string): string;
	emit(input: TraceInput): void;
}

export interface TraceOptions {
	readonly runtimeId: string;
	readonly now?: () => number;
	readonly sink: (record: TraceRecord) => void;
}

const events: ReadonlySet<string> = new Set<TraceEvent>([
	'source.received', 'intent.accepted', 'state.transition',
	'effect.subscribe', 'effect.next', 'effect.error', 'effect.complete', 'effect.cancel',
	'authority.recovered', 'authority.admit', 'authority.start', 'authority.error',
	'authority.commit', 'authority.publish', 'authority.reply-detached',
	'render.commit', 'connection.change', 'scope.dispose', 'resource.state',
]);
const textMetadata = ['kind', 'status', 'outcome', 'reason'] as const;
const numericMetadata = [
	'count', 'active', 'queued', 'pending', 'subscribers', 'listeners',
	'pendingEvents', 'pendingBytes', 'capacity', 'attempt', 'delayMs', 'dropped', 'durationMs',
] as const;

// IDs and labels are explicit, developer-selected identifiers, never payload summaries.
function identifier(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= 160
		&& /^[a-zA-Z0-9_.:/-]+$/.test(value) ? value : undefined;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function copyMetadata(value: TraceMetadata | undefined): TraceMetadata | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const metadata: Record<string, string | number | boolean> = {};
	for (const key of textMetadata) {
		const label = identifier(value[key]);
		if (label !== undefined) metadata[key] = label;
	}
	for (const key of numericMetadata) {
		const count = value[key];
		if (finiteNumber(count)) metadata[key] = count;
	}
	const changed = value.changed;
	if (typeof changed === 'boolean') metadata.changed = changed;
	return Object.keys(metadata).length ? Object.freeze(metadata) : undefined;
}

function copyInput(input: TraceInput): TraceInput | undefined {
	const event = input.event;
	if (!events.has(event)) return undefined;
	const scopeId = identifier(input.scopeId);
	const sourceId = identifier(input.sourceId);
	if (!scopeId || !sourceId) return undefined;
	const details: { operationId?: string; collectionId?: string; stateGeneration?: string;
		revision?: number; connectionId?: string; metadata?: TraceMetadata } = {};
	for (const key of ['operationId', 'collectionId', 'stateGeneration', 'connectionId'] as const) {
		const value = identifier(input[key]);
		if (value !== undefined) details[key] = value;
	}
	const revision = input.revision;
	if (finiteNumber(revision)) details.revision = revision;
	const metadata = copyMetadata(input.metadata);
	if (metadata) details.metadata = metadata;
	return { event, scopeId, sourceId, ...details };
}

/**
 * No source subscription or timer is created. Exceptions stay inside diagnostics;
 * recursive clock/sink emission is dropped, never queued. A sink is application
 * code: external mutations it deliberately performs cannot be undone by tracing.
 */
export function createTrace(options: TraceOptions): Trace {
	const runtimeId = identifier(options.runtimeId) ?? 'runtime';
	const now = options.now ?? Date.now;
	let sequence = 0;
	let identity = 0;
	let emitting = false;
	let sinkFailures = 0;
	let clockFailures = 0;
	let reentrantDrops = 0;
	let invalidRecords = 0;
	return {
		runtimeId,
		get diagnostics() {
			return Object.freeze({ emitted: sequence, sinkFailures, clockFailures, reentrantDrops, invalidRecords });
		},
		allocateId(prefix) { return `${(identifier(prefix) ?? 'scope').slice(0, 120)}:${++identity}`; },
		emit(input) {
			if (emitting) { reentrantDrops++; return; }
			emitting = true;
			try {
				let copied: TraceInput | undefined;
				try { copied = copyInput(input); } catch { /* Untrusted getters cannot break application flow. */ }
				if (!copied) { invalidRecords++; return; }
				let time: number | null = null;
				try {
					const sampled = now();
					if (finiteNumber(sampled)) time = sampled;
					else clockFailures++;
				} catch { clockFailures++; }
				const record: TraceRecord = Object.freeze({ runtimeId, sequence: ++sequence, time, ...copied });
				try { options.sink(record); } catch { sinkFailures++; }
			} finally { emitting = false; }
		},
	};
}

/** Emission exceptions, including those from a host-provided implementation, are isolated. */
export function emitTrace(trace: Trace | undefined, input: TraceInput): void {
	if (!trace) return;
	try { trace.emit(input); } catch { /* Diagnostics cannot alter the dataflow protocol. */ }
}

let fallbackIdentity = 0;

/** Host identity failures cannot prevent construction; fallback IDs remain distinct locally. */
export function allocateTraceId(trace: Trace | undefined, prefix: string): string {
	const label = (identifier(prefix) ?? 'scope').slice(0, 120);
	if (!trace) return label;
	try {
		const allocated = identifier(trace.allocateId(label));
		if (allocated) return allocated;
	} catch { /* A custom trace capability need not be allowed to break application setup. */ }
	return `${label}:fallback:${++fallbackIdentity}`;
}

export function traceRuntimeId(trace: Trace | undefined): string {
	try { return identifier(trace?.runtimeId) ?? 'unavailable'; } catch { return 'unavailable'; }
}

/** A passive, bounded ring; reading records does not subscribe to application work. */
export function createTraceRecorder(options: { readonly capacity?: number } = {}) {
	const capacity = options.capacity ?? 1000;
	if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) {
		throw new RangeError('Trace capacity must be an integer from 1 to 10000');
	}
	const buffer: TraceRecord[] = [];
	let cursor = 0;
	let dropped = 0;
	return {
		sink(record: TraceRecord): void {
			if (buffer.length < capacity) buffer.push(record);
			else {
				buffer[cursor] = record;
				cursor = (cursor + 1) % capacity;
				dropped++;
			}
		},
		get dropped() { return dropped; },
		records(): readonly TraceRecord[] {
			return Object.freeze([...buffer.slice(cursor), ...buffer.slice(0, cursor)]);
		},
	};
}

/**
 * Observe the existing execution inline. Payload/error objects are never inspected.
 * The upstream subscriber is owned before any trace callback or synchronous source
 * can run. Cancellation describes an unsubscribe, not rollback of a committed write.
 */
export function traceObservable<T>(source: Observable<T>, trace: Trace | undefined, context: TraceContext): Observable<T> {
	if (!trace) return source;
	return new Observable<T>(destination => {
		let terminal = false;
		function observe(event: TraceEvent): void {
			try { emitTrace(trace, { ...context, event }); } catch { /* Isolate context projection getters as well. */ }
		}
		const upstream = new Subscriber<T>({
			next(value) {
				observe('effect.next');
				destination.next(value);
			},
			error(error: unknown) {
				terminal = true;
				observe('effect.error');
				destination.error(error);
			},
			complete() {
				terminal = true;
				observe('effect.complete');
				destination.complete();
			},
		});
		destination.add(upstream);
		destination.add(() => {
			if (!terminal) observe('effect.cancel');
		});
		observe('effect.subscribe');
		if (!upstream.closed) source.subscribe(upstream);
	});
}
