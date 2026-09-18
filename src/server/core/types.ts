import type { Observable, OperatorFunction } from 'rxjs';

export interface AppContext<TServices extends object = Record<string, unknown>> {
	services: TServices;
	state: Record<string, unknown>;
}

export interface RequestContext {
	requestId?: string;
	state: Record<string, unknown>;
}

export interface HttpRequest<
	TBody = unknown,
	TParams extends Record<string, string> = Record<string, string>,
	TQuery extends Record<string, string | undefined> = Record<string, string | undefined>,
> {
	method: string;
	url: string;
	params: TParams;
	query: TQuery;
	body: TBody;
	headers: Record<string, string>;
	/** Cancellation of this request operation; platform raw objects stay in adapters. */
	signal: AbortSignal;
	context: AppContext;
	requestContext: RequestContext;
}

export interface SseEvent {
	event?: string;
	data: unknown;
	id?: string;
}

export interface HttpResponse {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
	stream?: Observable<SseEvent>;
	/** FIFO rejects overflow; only complete replaceable snapshots may opt into coalescing. */
	streamPolicy?: 'fifo' | 'latest-snapshot';
}

export type Effect<TRequest extends HttpRequest = HttpRequest> = (req$: Observable<TRequest>) => Observable<HttpResponse>;
export type Middleware<TRequest extends HttpRequest = HttpRequest> = OperatorFunction<TRequest, TRequest>;
