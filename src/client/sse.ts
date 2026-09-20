import { Observable } from 'rxjs';

/** SSE always supplies text; keep the injected boundary independent of DOM generics. */
export interface EventSourceMessage {
	readonly data: string;
}

export type EventSourceConnection = {
	addEventListener(type: string, listener: (event: EventSourceMessage) => void): void;
	removeEventListener(type: string, listener: (event: EventSourceMessage) => void): void;
	onerror: ((event: Event) => void) | null;
	close(): void;
};

export type EventSourceOptions = {
	createEventSource?: (url: string) => EventSourceConnection;
	/** Optional classification at the JSON/schema boundary; transport errors bypass it. */
	decodeFailure?: (error: unknown) => unknown;
};

function createBrowserEventSource(url: string): EventSourceConnection {
	// Native SSE named-message listeners receive MessageEvent text. Cloudflare's
	// generated EventSource type inherits only EventTarget's general Event overload.
	// Confine that ambient typing difference to this native capability boundary.
	return new EventSource(url) as unknown as EventSourceConnection;
}

/** Each subscription owns one connection. Decode and transport failures terminate it. */
export function fromEventSource<T>(
	url: string,
	eventType: string,
	decode: (value: unknown) => T,
	options: EventSourceOptions = {},
): Observable<T> {
	return new Observable(function subscribeToEvents(observer) {
		if (observer.closed) return;
		const connection = (options.createEventSource ?? createBrowserEventSource)(url);
		let closed = false;
		let attaching = false;

		function handleMessage(event: EventSourceMessage): void {
			if (closed || observer.closed) return;
			try {
				const value: unknown = JSON.parse(event.data);
				observer.next(decode(value));
			} catch (error) {
				let failure = error;
				try { failure = options.decodeFailure?.(error) ?? error; }
				catch (classificationFailure) { failure = classificationFailure; }
				failConnection(failure);
			}
		}

		function handleError(): void {
			if (!closed && !observer.closed) failConnection(new Error('EventSource error'));
		}

		function failConnection(error: unknown): void {
			// Stop browser-owned reconnection before a downstream retry can start.
			try { closeConnection(); }
			catch (cleanupError) {
				observer.error(new AggregateError([error, cleanupError], 'EventSource failed during cleanup'));
				return;
			}
			observer.error(error);
		}

		function closeConnection(): void {
			if (closed) return;
			closed = true;
			try {
				if (!attaching) connection.removeEventListener(eventType, handleMessage);
			} finally {
				try { connection.onerror = null; }
				finally { connection.close(); }
			}
		}

		// Own teardown before attaching a source that could deliver synchronously.
		observer.add(closeConnection);
		if (observer.closed) return;
		connection.onerror = handleError;
		if (observer.closed) return;
		attaching = true;
		try { connection.addEventListener(eventType, handleMessage); }
		finally {
			attaching = false;
			// An injected source can deliver before it finishes attaching. Closing
			// happens immediately; detach after attachment returns, even on a throw.
			if (closed) connection.removeEventListener(eventType, handleMessage);
		}
	});
}
