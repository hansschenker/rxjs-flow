import type { Observable } from 'rxjs';
import { TODO_AUTHORITY_LIMITS, type TodoSnapshot } from '../server/todos/todo.authority';
import { createOwnedByteStream } from './owned-byte-stream';
import { TODO_WATCH_CONTENT_TYPE } from './todo-live';

/** The authority owns committed state; this response owns one live subscriber. */
export function createTodoLiveResponse(source$: Observable<TodoSnapshot>, signal: AbortSignal): Response {
	const encoder = new TextEncoder();
	const stream = createOwnedByteStream(source$, {
		encode: snapshot => encoder.encode(`${JSON.stringify(snapshot)}\n`),
		signal,
		policy: 'latest-snapshot',
		maxPendingEvents: 1,
		maxPendingBytes: TODO_AUTHORITY_LIMITS.maxSnapshotBytes + 1,
		maxFrameBytes: TODO_AUTHORITY_LIMITS.maxSnapshotBytes + 1,
	});
	const response = new Response(stream.body, {
		headers: { 'content-type': TODO_WATCH_CONTENT_TYPE, 'cache-control': 'no-store' },
	});
	stream.start();
	return response;
}
