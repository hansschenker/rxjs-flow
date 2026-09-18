import { Forbidden, HttpError } from '../server/core/errors';

export interface TodoAccessBindings {
	TODO_ACCESS_POLICY: string;
	TODO_COLLECTION_ID: string;
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Only trusted configuration chooses a collection; request keys confer no access. */
export function authorizeTodoCollection(request: Request, env: TodoAccessBindings): string {
	if (env.TODO_ACCESS_POLICY !== 'local-loopback') {
		throw new HttpError(503, 'Todo access is not configured');
	}
	const url = new URL(request.url);
	if (!loopbackHosts.has(url.hostname)) throw new Forbidden('Todo access is limited to local development');
	const origin = request.headers.get('origin');
	if (origin !== null && origin !== url.origin) throw new Forbidden('Cross-origin Todo access is not allowed');
	if (request.headers.get('sec-fetch-site') === 'cross-site') throw new Forbidden('Cross-site Todo access is not allowed');
	if (request.headers.has('x-collection-id') || request.headers.has('x-todo-collection')
		|| ['collection', 'collectionId', 'collection_id'].some(name => url.searchParams.has(name))) {
		throw new Forbidden('Collection selection is not allowed');
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(env.TODO_COLLECTION_ID)) {
		throw new HttpError(503, 'Todo collection is not configured');
	}
	return env.TODO_COLLECTION_ID;
}
