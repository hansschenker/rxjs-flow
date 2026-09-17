import { vi, describe, it, expect, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';

import type { FetchTransport } from './api';
import { createTodoService } from './todo.service';
import type { Todo } from '../shared/types';

const mockFetch = vi.fn<FetchTransport>();
const service = createTodoService({ fetch: mockFetch });
const jsonResponse = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});

const todo: Todo = { id: '1', title: 'Test todo', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };

beforeEach(() => { mockFetch.mockReset(); });

describe('createTodoService()', () => {
	it('does no work during construction or before subscribing to an operation', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse([todo]));
		const isolatedService = createTodoService({ fetch });
		const request$ = isolatedService.getAll$();
		isolatedService.create$({ title: 'Not submitted' });
		isolatedService.update$('1', { completed: true });
		isolatedService.remove$('1');

		expect(fetch).not.toHaveBeenCalled();
		await expect(firstValueFrom(request$)).resolves.toEqual([todo]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('imports the default service without starting work and retains its exports', async () => {
		const fetch = vi.fn<FetchTransport>().mockResolvedValue(jsonResponse([todo]));
		vi.resetModules();
		vi.doMock('./api', async () => {
			const actual = await vi.importActual<typeof import('./api')>('./api');
			return {
				...actual,
				createClient: (contract: Parameters<typeof actual.createClient>[0]) =>
					actual.createClient(contract, { fetch }),
			};
		});

		try {
			const defaults = await import('./todo.service');
			expect(fetch).not.toHaveBeenCalled();
			expect(defaults.api.todos.list).toBeTypeOf('function');
			expect(defaults.create$).toBeTypeOf('function');
			expect(defaults.update$).toBeTypeOf('function');
			expect(defaults.remove$).toBeTypeOf('function');

			const request$ = defaults.getAll$();
			defaults.create$({ title: 'Not submitted' });
			defaults.update$('1', { completed: true });
			defaults.remove$('1');
			expect(fetch).not.toHaveBeenCalled();
			await expect(firstValueFrom(request$)).resolves.toEqual([todo]);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.doUnmock('./api');
			vi.resetModules();
		}
	});
});

describe('getAll$()', () => {
	it('calls the injected transport with the base URL and returns parsed todos', async () => {
		mockFetch.mockResolvedValue(jsonResponse([todo]));
		const result = await firstValueFrom(service.getAll$());
		expect(mockFetch).toHaveBeenCalledWith('/api/todos', expect.objectContaining({
			method: 'GET',
		}));
		expect(result).toEqual([todo]);
	});
});

describe('create$()', () => {
	it('POSTs to /api/todos with JSON body and returns the new todo', async () => {
		mockFetch.mockResolvedValue(jsonResponse(todo, 201));
		const result = await firstValueFrom(service.create$({ title: 'Test todo' }));
		expect(mockFetch).toHaveBeenCalledWith('/api/todos', expect.objectContaining({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Test todo' }),
		}));
		expect(result).toEqual(todo);
	});
});

describe('update$()', () => {
	it('PUTs to /api/todos/:id with JSON body and returns updated todo', async () => {
		const updated = { ...todo, completed: true };
		mockFetch.mockResolvedValue(jsonResponse(updated));
		const result = await firstValueFrom(service.update$('1', { completed: true }));
		expect(mockFetch).toHaveBeenCalledWith('/api/todos/1', expect.objectContaining({
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ completed: true }),
		}));
		expect(result).toEqual(updated);
	});

	it('sends only the fields included in UpdateTodoBody', async () => {
		mockFetch.mockResolvedValue(jsonResponse({ ...todo, title: 'Renamed' }));
		await firstValueFrom(service.update$('1', { title: 'Renamed' }));
		expect(mockFetch).toHaveBeenCalledWith('/api/todos/1', expect.objectContaining({
			body: JSON.stringify({ title: 'Renamed' }),
		}));
	});
});

describe('remove$()', () => {
	it('DELETEs /api/todos/:id and resolves to undefined for a valid 204', async () => {
		mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
		const result = await firstValueFrom(service.remove$('1'));
		expect(mockFetch).toHaveBeenCalledWith('/api/todos/1', expect.objectContaining({
			method: 'DELETE',
		}));
		expect(result).toBeUndefined();
	});

	it('rejects a failed DELETE with the structured HTTP failure', async () => {
		mockFetch.mockResolvedValue(jsonResponse({ error: 'Missing' }, 404));

		await expect(firstValueFrom(service.remove$('1'))).rejects.toMatchObject({
			kind: 'http', status: 404, message: 'Missing',
		});
	});
});
