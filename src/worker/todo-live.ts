import { Observable, map } from 'rxjs';
import type { SseEvent } from '../server/core/types';
import type { TodoLiveSnapshot } from '../shared/todo-live';
import { HttpError } from '../server/core/errors';
import { decodeTodoSnapshot, TODO_AUTHORITY_LIMITS } from '../server/todos/todo.authority';
import type { TodoCollection } from './todo-collection';

export const TODO_WATCH_PATH = '/internal/watch';
export const TODO_WATCH_CONTENT_TYPE = 'application/x-ndjson';

/**
 * One cold transport per response. Observable ownership stays local: cancelling
 * the reader explicitly propagates cancellation to the Durable Object body.
 * The private NDJSON framing stays independent of either public SSE endpoint.
 */
export function createDurableTodoLive(stub: DurableObjectStub<TodoCollection>, collectionId: string): Observable<SseEvent> {
	return createDurableTodoSnapshots(stub, collectionId).pipe(map(legacyTodoEvent));
}

function legacyTodoEvent(snapshot: TodoLiveSnapshot): SseEvent {
	return { event: 'todos', data: snapshot.todos };
}

/** A cold registration exposes committed history without inventing Worker epochs. */
export function createDurableTodoSnapshots(stub: DurableObjectStub<TodoCollection>, collectionId: string): Observable<TodoLiveSnapshot> {
	return new Observable(observer => {
		const controller = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let stopped = false;
		let frame: Uint8Array | undefined = new Uint8Array(TODO_AUTHORITY_LIMITS.maxSnapshotBytes);
		let frameBytes = 0;

		function stop(): void {
			if (stopped) return;
			stopped = true;
			frame = undefined;
			frameBytes = 0;
			// A response can disappear before fetch has supplied a body. Abort that
			// pending request too; a late Response is cancelled before acquiring it.
			if (reader) void reader.cancel('Todo live response closed').catch(() => {});
			else controller.abort();
		}
		observer.add(stop);

		async function consume(): Promise<void> {
			try {
				const response = await stub.fetch(`https://todo-authority${TODO_WATCH_PATH}`, { signal: controller.signal });
				if (stopped) { await response.body?.cancel('Todo live response closed'); return; }
				if (!response.ok || response.headers.get('content-type') !== TODO_WATCH_CONTENT_TYPE || !response.body) {
					await response.body?.cancel('Invalid Todo live response');
					throw new HttpError(503, 'Todo live authority is unavailable');
				}
				reader = response.body.getReader();
				const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
				while (!stopped) {
					const item = await reader.read();
					if (stopped) break;
					if (item.done) {
						if (frameBytes !== 0) throw new Error('Incomplete Todo snapshot');
						observer.complete();
						break;
					}
					let offset = 0;
					while (!stopped && offset < item.value.byteLength) {
						const newline = item.value.indexOf(10, offset);
						const end = newline === -1 ? item.value.byteLength : newline;
						const bytes = end - offset;
						if (!frame || frameBytes + bytes > frame.byteLength) throw new Error('Todo live snapshot exceeds capacity');
						frame.set(item.value.subarray(offset, end), frameBytes);
						frameBytes += bytes;
						offset = end + (newline === -1 ? 0 : 1);
						if (newline !== -1) {
							const snapshot = decodeTodoSnapshot(JSON.parse(decoder.decode(frame.subarray(0, frameBytes))), collectionId);
							frameBytes = 0;
							observer.next(snapshot);
						}
					}
				}
			} catch (error) {
				if (!stopped) observer.error(error instanceof HttpError ? error : new HttpError(503, 'Todo live authority was interrupted'));
			} finally {
				try { reader?.releaseLock(); } catch { /* A pending cancellation owns release. */ }
				reader = undefined;
			}
		}
		void consume();
	});
}
