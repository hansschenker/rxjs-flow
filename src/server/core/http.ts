// A cold Node HTTP source. The server owns response lifetimes; each emitted
// request exposes body consumption to its separately owned finite operation.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Observable, Subscriber, Subscription, tap } from 'rxjs';
import { MAX_BODY_BYTES, parseJsonBody } from './body';
import { HttpError } from './errors';
import type { HttpRequest, HttpResponse, SseEvent } from './types';

const releaseSubscription = (subscription: Subscription): void => {
	try { subscription.unsubscribe(); }
	catch (error) {
		// Teardown failures must not escape a Node event handler or prevent the
		// server from releasing the remaining response owners.
		try { console.error(error); } catch { /* Reporting is observational. */ }
	}
};

export interface PreparedNodeResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
	stream?: Observable<SseEvent>;
}

export interface RequestEvent {
	request: HttpRequest;
	readBody: (signal: AbortSignal) => Promise<unknown>;
	respond: (response: HttpResponse) => void;
	respondPrepared: (response: PreparedNodeResponse) => void;
	own: (subscription: Subscription) => void;
}

export interface NodeServerOptions {
	onListening?: (address: AddressInfo) => void;
	onClosed?: () => void;
	onListenError?: (error: Error) => void;
}

// Existing names remain available to callers of the Node-specific body helper.
export class BadRequestError extends HttpError {
	constructor(message = 'Malformed JSON') { super(400, message); }
}
export class PayloadTooLargeError extends HttpError {
	constructor() { super(413, 'Request body too large'); }
}

export const parseBody = (req: http.IncomingMessage, signal?: AbortSignal): Promise<unknown> =>
	new Promise((resolve, reject) => {
		let bytes = 0;
		let chunks: Buffer[] = [];
		let settled = false;
		const cleanup = (): void => {
			req.off('data', onData);
			req.off('end', onEnd);
			req.off('error', onError);
			req.off('aborted', onAbort);
			signal?.removeEventListener('abort', onAbort);
			chunks = [];
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			// Stop accepting bytes immediately. The adapter closes an incomplete
			// request's connection after sending its bounded error response.
			req.pause();
			reject(error);
		};
		const onAbort = (): void => fail(new HttpError(499, 'Request canceled'));
		const onError = (): void => fail(new BadRequestError('Request stream error'));
		const onData = (chunk: Buffer | string): void => {
			const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
			bytes += buffer.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				fail(new PayloadTooLargeError());
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = (): void => {
			if (settled) return;
			try {
				// Decode once after the bounded byte collection, preserving UTF-8
				// code points that span network chunks.
				let text: string;
				try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)); }
				catch { throw new BadRequestError('Malformed UTF-8 request body'); }
				const value = parseJsonBody(text);
				settled = true;
				cleanup();
				resolve(value);
			} catch (error) {
				fail(error);
			}
		};
		if (signal?.aborted || req.aborted) {
			onAbort();
			return;
		}
		req.on('data', onData);
		req.on('end', onEnd);
		req.on('error', onError);
		req.on('aborted', onAbort);
		signal?.addEventListener('abort', onAbort, { once: true });
	});

const parseQuery = (raw: string): Record<string, string> => {
	const params: Record<string, string> = {};
	new URLSearchParams(raw).forEach((value, key) => { params[key] = value; });
	return params;
};

export const formatSseChunk = (event: SseEvent): string => {
	let chunk = '';
	if (event.id !== undefined) chunk += `id: ${event.id}\n`;
	if (event.event !== undefined) chunk += `event: ${event.event}\n`;
	return `${chunk}data: ${JSON.stringify(event.data)}\n\n`;
};

interface CloseSource {
	on: (event: 'close', handler: () => void) => unknown;
	off?: (event: 'close', handler: () => void) => unknown;
}

export const applySse = (
	stream: Observable<SseEvent>,
	responseLifetime: CloseSource,
	nodeRes: { write: (chunk: string) => unknown; end: () => unknown },
): Subscription => {
	const owner = new Subscription();
	const onClose = (): void => releaseSubscription(owner);
	responseLifetime.on('close', onClose);
	owner.add(() => responseLifetime.off?.('close', onClose));
	const finish = (): void => {
		try { nodeRes.end(); } catch { /* A disconnected transport cannot accept an error body. */ }
		finally { releaseSubscription(owner); }
	};
	const sink = new Subscriber<SseEvent>({ next: () => {}, error: finish, complete: finish });
	owner.add(sink);
	stream.pipe(tap(event => nodeRes.write(formatSseChunk(event)))).subscribe(sink);
	return owner;
};

export const prepareNodeResponse = ({ status = 200, body, headers = {}, stream }: HttpResponse): PreparedNodeResponse => {
	if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('Invalid response status');
	const preparedHeaders: Record<string, string> = stream
		? { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...headers }
		: { 'Content-Type': 'application/json', ...headers };
	for (const [name, value] of Object.entries(preparedHeaders)) {
		http.validateHeaderName(name);
		http.validateHeaderValue(name, value);
	}
	const serialized = stream || status === 204 || status === 205 || status === 304 || body === undefined ? '' : JSON.stringify(body);
	if (serialized === undefined) throw new Error('Response body cannot be represented as JSON');
	return {
		status,
		headers: preparedHeaders,
		body: serialized,
		stream,
	};
};

export const createServer = (port: number, options: NodeServerOptions = {}): Observable<RequestEvent> =>
	new Observable(observer => {
		const responses = new Set<() => void>();
		let listening = false;
		let stopped = false;
		let closeReported = false;
		const reportClosed = (): void => {
			if (closeReported) return;
			closeReported = true;
			options.onClosed?.();
		};
		const server = http.createServer((req, res) => {
			const controller = new AbortController();
			const owner = new Subscription();
			const finish = (): void => releaseSubscription(owner);
			const shutdown = (): void => {
				releaseSubscription(owner);
				res.destroy();
			};
			responses.add(shutdown);
			owner.add(() => {
				controller.abort();
				responses.delete(shutdown);
				req.off('aborted', finish);
				req.off('error', finish);
				res.off('close', finish);
				res.off('finish', finish);
			});
			req.on('aborted', finish);
			req.on('error', finish);
			res.on('close', finish);
			res.on('finish', finish);
			const respondPrepared = (response: PreparedNodeResponse): void => {
				if (owner.closed || res.headersSent || res.destroyed) return;
				try {
					const headers = { ...response.headers };
					if (!req.complete) headers.Connection = 'close';
					res.writeHead(response.status, headers);
					if (response.stream) {
						res.flushHeaders();
						owner.add(applySse(response.stream, res, res));
					} else {
						res.end(response.body);
					}
				} catch {
					shutdown();
				}
			};
			const respond = (response: HttpResponse): void => {
				try { respondPrepared(prepareNodeResponse(response)); }
				catch { respondPrepared(prepareNodeResponse({ status: 500, body: { error: 'Internal server error' } })); }
			};
			try {
				const [pathname, search = ''] = (req.url ?? '/').split('?');
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(req.headers)) {
					if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
				}
				observer.next({
					request: {
						method: req.method ?? 'GET', url: pathname, params: {},
						query: parseQuery(search), body: {}, headers, signal: controller.signal,
						context: { services: {}, state: {} }, requestContext: { state: {} },
					},
					readBody: signal => parseBody(req, signal), respond, respondPrepared,
					own: subscription => { owner.add(subscription); },
				});
			} catch {
				respond({ status: 500, body: { error: 'Internal server error' } });
			}
		});
		server.on('error', error => {
			options.onListenError?.(error);
			observer.error(error);
			if (!listening) reportClosed();
		});
		server.on('close', reportClosed);
		try {
			server.listen(port, () => {
				listening = true;
				if (stopped) { server.close(reportClosed); return; }
				options.onListening?.(server.address() as AddressInfo);
			});
		} catch (error) {
			options.onListenError?.(error as Error);
			observer.error(error);
			reportClosed();
		}
		return () => {
			stopped = true;
			for (const shutdown of [...responses]) shutdown();
			// Calling close before listen has completed is supported by Node; its
			// callback marks closure, while the listening callback guards the race.
			server.close(reportClosed);
			server.closeAllConnections();
		};
	});
