import { env, exports } from 'cloudflare:workers';
import { EMPTY, Observable, Subject, finalize, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { FoundationResult } from '../shared/foundation';
import { createFoundationApp } from './index';

const expected: FoundationResult = {
	runtime: 'workerd',
	message: 'owned foundation',
};
const bindings = { FOUNDATION_LABEL: expected.message };

function request(signal?: AbortSignal): Request {
	return new Request('https://example.test/api/foundation', { signal });
}

describe('foundation Worker in workerd', () => {
	it('executes the configured production entry with generated bindings', async () => {
		const response = await exports.default.fetch('https://example.test/api/foundation');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			runtime: 'workerd',
			message: env.FOUNDATION_LABEL,
		});
	});

	it('exposes only the public configuration binding to the application', () => {
		// The official test harness also owns private runtime/service bindings.
		const applicationBindings = Object.keys(env)
			.filter(name => !name.startsWith('__VITEST_POOL_WORKERS_'));
		expect(applicationBindings).toEqual(['FOUNDATION_LABEL']);
	});

	it('registers routes without constructing or subscribing to an operation', () => {
		const operation = vi.fn(() => of(expected));
		createFoundationApp(operation);
		expect(operation).not.toHaveBeenCalled();
	});

	it('passes only the configured public label into the typed operation', async () => {
		const operation = vi.fn(() => of(expected));
		const response = await createFoundationApp(operation).fetch(request(), bindings);
		expect(operation).toHaveBeenCalledExactlyOnceWith(expected.message);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expected);
	});

	it('settles on the first value and releases a synchronous source exactly once', async () => {
		const cleanup = vi.fn();
		const operation = () => new Observable<FoundationResult>(subscriber => {
			subscriber.next(expected);
			expect(subscriber.closed).toBe(true);
			subscriber.next({ ...expected, message: 'must not replace the result' });
			return cleanup;
		});
		const response = await createFoundationApp(operation).fetch(request(), bindings);
		expect(await response.json()).toEqual(expected);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('releases the abort listener after successful settlement', async () => {
		const input = request();
		const add = vi.spyOn(input.signal, 'addEventListener');
		const remove = vi.spyOn(input.signal, 'removeEventListener');
		await createFoundationApp(() => of(expected)).fetch(input, bindings);
		const listener = add.mock.calls.find(([type]) => type === 'abort')?.[1];
		expect(listener).toBeDefined();
		expect(remove.mock.calls.some(([type, callback]) => type === 'abort' && callback === listener)).toBe(true);
	});

	it('settles an empty operation as a documented failure', async () => {
		const response = await createFoundationApp(() => EMPTY).fetch(request(), bindings);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'foundation_operation_failed' });
	});

	it('contains a synchronous operation-construction failure', async () => {
		function fail(): never { throw new Error('internal detail'); }
		const response = await createFoundationApp(fail).fetch(request(), bindings);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'foundation_operation_failed' });
	});

	it('releases a source that errors and keeps subsequent requests usable', async () => {
		const cleanup = vi.fn();
		let count = 0;
		function operation(): Observable<FoundationResult> {
			if (count++ > 0) return of(expected);
			return new Observable(subscriber => {
				subscriber.error(new Error('internal detail'));
				return cleanup;
			});
		}
		const app = createFoundationApp(operation);
		expect((await app.fetch(request(), bindings)).status).toBe(500);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect((await app.fetch(request(), bindings)).status).toBe(200);
	});

	it('does not construct an operation for an already-aborted request', async () => {
		const controller = new AbortController();
		controller.abort();
		const operation = vi.fn(() => of(expected));
		const response = await createFoundationApp(operation).fetch(request(controller.signal), bindings);
		expect(response.status).toBe(499);
		expect(await response.json()).toEqual({ error: 'request_cancelled' });
		expect(operation).not.toHaveBeenCalled();
	});

	it('cancels pending work and ignores later source values', async () => {
		const controller = new AbortController();
		const pending = new Subject<FoundationResult>();
		const cleanup = vi.fn();
		const responsePromise = createFoundationApp(() => pending.pipe(finalize(cleanup)))
			.fetch(request(controller.signal), bindings);
		expect(pending.observed).toBe(true);
		controller.abort();
		pending.next(expected);
		const response = await responsePromise;
		expect(response.status).toBe(499);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(pending.observed).toBe(false);
	});

	it('keeps concurrent requests independent when one is cancelled', async () => {
		const first = new Subject<FoundationResult>();
		const second = new Subject<FoundationResult>();
		const cleanFirst = vi.fn();
		const cleanSecond = vi.fn();
		const operation = vi.fn()
			.mockReturnValueOnce(first.pipe(finalize(cleanFirst)))
			.mockReturnValueOnce(second.pipe(finalize(cleanSecond)));
		const app = createFoundationApp(operation);
		const controller = new AbortController();
		const resultA = app.fetch(request(controller.signal), bindings);
		const resultB = app.fetch(request(), bindings);
		controller.abort();
		expect(cleanFirst).toHaveBeenCalledTimes(1);
		expect(cleanSecond).not.toHaveBeenCalled();
		expect(second.observed).toBe(true);
		second.next(expected);
		expect((await resultA).status).toBe(499);
		expect(await (await resultB).json()).toEqual(expected);
		expect(cleanSecond).toHaveBeenCalledTimes(1);
	});

	it('bounds an operation with no result and releases its work', async () => {
		const cleanup = vi.fn();
		const operation = () => new Observable<FoundationResult>(() => cleanup);
		const response = await createFoundationApp(operation).fetch(request(), bindings);
		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({ error: 'foundation_timeout' });
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it.each(['/api/unknown', '/api/todos', '/api'])('returns JSON 404 for %s without executing the probe', async path => {
		const operation = vi.fn(() => of(expected));
		const response = await createFoundationApp(operation).fetch(new Request(`https://example.test${path}`), bindings);
		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toEqual({ error: 'not_found' });
		expect(operation).not.toHaveBeenCalled();
	});
});
