import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEVER } from 'rxjs';

const service = vi.hoisted(() => ({ getAll$: vi.fn(), create$: vi.fn(), update$: vi.fn(), remove$: vi.fn() }));
vi.mock('./todo.service', () => service);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('M01 inert feature import', () => {
	it('does not touch the DOM, subscribe, or start a request on import', async () => {
		document.body.innerHTML = '<form id="add-form"><input id="title-input"></form><ul id="todo-list"></ul><p id="error-msg"></p>';
		service.getAll$.mockReturnValue(NEVER);
		const lookup = vi.spyOn(document, 'getElementById');
		const query = vi.spyOn(document, 'querySelector');
		const create = vi.spyOn(document, 'createElement');
		const fetch = vi.fn();
		const eventSource = vi.fn();
		vi.stubGlobal('fetch', fetch);
		vi.stubGlobal('EventSource', eventSource);
		const { createTodoApp } = await import('./main');
		const app = createTodoApp();
		expect(service.getAll$).not.toHaveBeenCalled();
		expect(lookup).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(eventSource).not.toHaveBeenCalled();
		const { action$ } = await import('./todo.state');
		expect(action$.observed).toBe(false);
		app.dispose();
	});
});
