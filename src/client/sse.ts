import { Observable } from 'rxjs';

export type EventSourceConnection = {
	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	onerror: ((event: Event) => void) | null;
	close(): void;
};

export type EventSourceOptions = {
	createEventSource?: (url: string) => EventSourceConnection;
};

function createBrowserEventSource(url: string): EventSourceConnection {
	return new EventSource(url);
}

/** Each subscription owns one connection. Decode and transport failures terminate it. */
export function fromEventSource<T>(
	url: string,
	eventType: string,
	decode: (value: unknown) => T,
	options: EventSourceOptions = {},
): Observable<T> {
	return new Observable(function subscribeToEvents(observer) {
		const connection = (options.createEventSource ?? createBrowserEventSource)(url);
		let closed = false;

		function handleMessage(event: MessageEvent<string>): void {
			if (observer.closed) return;
			try {
				const value: unknown = JSON.parse(event.data);
				observer.next(decode(value));
			} catch (error) {
				observer.error(error);
			}
		}

		function handleError(): void {
			observer.error(new Error('EventSource error'));
		}

		function closeConnection(): void {
			if (closed) return;
			closed = true;
			connection.removeEventListener(eventType, handleMessage);
			connection.onerror = null;
			connection.close();
		}

		// Own teardown before attaching a source that could deliver synchronously.
		observer.add(closeConnection);
		connection.onerror = handleError;
		connection.addEventListener(eventType, handleMessage);
	});
}
