import type { HttpResponse } from '../server/core/types';
import { encodeSseEvent } from '../server/core/sse-event';
import { createOwnedByteStream, type OwnedByteStream } from './owned-byte-stream';
import type { Trace, TraceContext } from '../shared/trace';

/** Validate all response setup before activating the separate live body owner. */
export function prepareSseResponse(descriptor: HttpResponse, signal: AbortSignal, trace?: Trace, traceContext?: TraceContext): {
	response: Response; live: OwnedByteStream;
} {
	if (!descriptor.stream) throw new TypeError('Missing SSE source');
	const status = descriptor.status ?? 200;
	const headers = new Headers(descriptor.headers);
	headers.set('content-type', 'text/event-stream; charset=utf-8');
	if (!headers.has('cache-control')) headers.set('cache-control', 'no-cache');
	headers.delete('connection');
	headers.delete('content-length');
	// Response rejects invalid/empty-body statuses while the source is still inert.
	const live = createOwnedByteStream(descriptor.stream, { encode: encodeSseEvent, signal, policy: descriptor.streamPolicy, trace, traceContext });
	return { response: new Response(live.body, { status, headers }), live };
}
