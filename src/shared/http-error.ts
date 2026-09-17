/** A finite request failed; cancellation does not produce one of these values. */
export interface RequestFailure {
	readonly kind: 'http' | 'network' | 'decode' | 'unsupported-response';
	readonly message: string;
	readonly status?: number;
	readonly details?: unknown;
	readonly body?: unknown;
	readonly cause?: unknown;
}

/** Functional error construction keeps failures usable as ordinary result data. */
export const createRequestFailure = (failure: RequestFailure): RequestFailure => ({ ...failure });

export const isRequestFailure = (value: unknown): value is RequestFailure => {
	if (typeof value !== 'object' || value === null || !('kind' in value) || !('message' in value)) return false;
	return typeof value.message === 'string'
		&& (value.kind === 'http' || value.kind === 'network' || value.kind === 'decode' || value.kind === 'unsupported-response')
		&& (!('status' in value) || value.status === undefined || typeof value.status === 'number');
};
