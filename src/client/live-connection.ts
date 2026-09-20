import {
	EMPTY, NEVER, Observable, asyncScheduler, catchError, defer, map,
	merge, of, retry, switchMap, throwError, timeout, timer, type SchedulerLike,
} from 'rxjs';
import { fromEventSource, type EventSourceOptions } from './sse';

export type LiveConnectionEvent<T> =
	| { readonly type: 'connecting'; readonly connectionId: number; readonly attempt: number }
	| { readonly type: 'snapshot'; readonly connectionId: number; readonly value: T }
	| { readonly type: 'reconnecting'; readonly connectionId: number; readonly attempt: number; readonly delayMs: number; readonly message: string }
	| { readonly type: 'failed'; readonly connectionId: number; readonly attempt: number; readonly failure: 'transport' | 'protocol'; readonly message: string };

export interface LiveConnectionOptions {
	readonly createEventSource?: EventSourceOptions['createEventSource'];
	/** Supplies retry and first-snapshot deadline time; defaults to asyncScheduler. */
	readonly scheduler?: SchedulerLike;
	/** Consecutive failed attempts wait 1, 2, 4, 8 seconds, then require recovery. */
	readonly retryDelaysMs?: readonly number[];
	/** An open transport alone is not readiness; require a validated first snapshot. */
	readonly initialSnapshotTimeoutMs?: number;
	/** Each value replaces the current attempt/wait and starts a fresh retry budget. */
	readonly recover$?: Observable<unknown>;
}

export interface LiveDecodeContext {
	readonly connectionId: number;
	readonly firstSnapshot: boolean;
}

interface ProtocolFailure {
	readonly kind: 'live-protocol-failure';
	readonly cause: unknown;
}

const defaultRetryDelaysMs = [1_000, 2_000, 4_000, 8_000] as const;

function protocolFailure(cause: unknown): ProtocolFailure {
	return { kind: 'live-protocol-failure', cause };
}

function isProtocolFailure(failure: unknown): failure is ProtocolFailure {
	return typeof failure === 'object' && failure !== null
		&& 'kind' in failure && failure.kind === 'live-protocol-failure';
}

function failureMessage(failure: unknown): string {
	if (isProtocolFailure(failure)) return `Invalid live snapshot: ${failureMessage(failure.cause)}`;
	return failure instanceof Error ? failure.message : 'The live connection failed.';
}

function validateTiming(retryDelaysMs: readonly number[], initialSnapshotTimeoutMs: number): void {
	if (retryDelaysMs.some(function invalidDelay(delay) {
		return !Number.isSafeInteger(delay) || delay < 0;
	})) throw new RangeError('retryDelaysMs must contain non-negative safe integers.');
	if (!Number.isSafeInteger(initialSnapshotTimeoutMs) || initialSnapshotTimeoutMs <= 0) {
		throw new RangeError('initialSnapshotTimeoutMs must be a positive safe integer.');
	}
}

/**
 * A cold connection/recovery description. The mounted app subscribes once and
 * distributes the resulting model state; extra model consumers do not subscribe
 * here. RxJS owns reconnection: EventSource is closed on every transport error.
 *
 * switchMap gives each manual recovery value ownership of the latest cycle.
 * A valid snapshot resets the consecutive-failure budget. JSON/schema failure
 * and exhausted transport retries emit `failed` and wait for manual recovery.
 * Unsubscription cancels the current connection, deadline, retry and recovery
 * listener. Connection identity is independent of the server's history identity.
 */
export function liveConnection$<T>(
	url: string,
	eventType: string,
	decode: (value: unknown, context: LiveDecodeContext) => T,
	options: LiveConnectionOptions = {},
): Observable<LiveConnectionEvent<T>> {
	return defer(function ownLiveConnection() {
		const scheduler = options.scheduler ?? asyncScheduler;
		const retryDelaysMs = [...(options.retryDelaysMs ?? defaultRetryDelaysMs)];
		const initialSnapshotTimeoutMs = options.initialSnapshotTimeoutMs ?? 10_000;
		validateTiming(retryDelaysMs, initialSnapshotTimeoutMs);
		let nextConnectionId = 0;

		function recoveryCycle(): Observable<LiveConnectionEvent<T>> {
			return new Observable(function ownRecoveryCycle(observer) {
				let connectionId = 0;
				let attempt = 1;

				function openAttempt(): Observable<LiveConnectionEvent<T>> {
					connectionId = ++nextConnectionId;
					const ownedConnectionId = connectionId;
					let firstSnapshot = true;
					observer.next({ type: 'connecting', connectionId, attempt });
					if (observer.closed) return EMPTY;

					function decodeAttempt(value: unknown): T {
						const decoded = decode(value, { connectionId: ownedConnectionId, firstSnapshot });
						firstSnapshot = false;
						return decoded;
					}

					function snapshot(value: T): LiveConnectionEvent<T> {
						return { type: 'snapshot', connectionId: ownedConnectionId, value };
					}

					function initialSnapshotTimeout(): Observable<never> {
						return throwError(function deadlineFailure() {
							return new Error(`No live snapshot received within ${initialSnapshotTimeoutMs} ms.`);
						});
					}

					return fromEventSource(url, eventType, decodeAttempt, {
						createEventSource: options.createEventSource,
						decodeFailure: protocolFailure,
					}).pipe(
						timeout({ first: initialSnapshotTimeoutMs, scheduler, with: initialSnapshotTimeout }),
						map(snapshot),
					);
				}

				function retryDelay(failure: unknown, retryCount: number): Observable<unknown> {
					if (isProtocolFailure(failure)) return throwError(function rejectProtocol() { return failure; });
					const delayMs = retryDelaysMs[retryCount - 1];
					attempt = retryCount + 1;
					observer.next({ type: 'reconnecting', connectionId, attempt, delayMs, message: failureMessage(failure) });
					return observer.closed ? EMPTY : timer(delayMs, scheduler);
				}

				function terminalFailure(failure: unknown): Observable<LiveConnectionEvent<T>> {
					return of({ type: 'failed', connectionId, attempt,
						failure: isProtocolFailure(failure) ? 'protocol' : 'transport', message: failureMessage(failure) });
				}

				// Only validated snapshots pass through retry. Status notifications
				// therefore cannot reset its consecutive-failure counter. retry owns
				// one replaceable attempt, avoiding an ever-growing recovery chain.
				defer(openAttempt).pipe(
					retry({ count: retryDelaysMs.length, resetOnSuccess: true, delay: retryDelay }),
					catchError(terminalFailure),
				).subscribe(observer);
			});
		}

		function initialConnection(): Observable<unknown> {
			// Subscribe to recovery first, including during synchronous setup. A
			// synchronous recovery value can already have initiated the first cycle.
			return nextConnectionId === 0 ? of(undefined) : EMPTY;
		}

		return merge(options.recover$ ?? NEVER, defer(initialConnection)).pipe(switchMap(recoveryCycle));
	});
}
