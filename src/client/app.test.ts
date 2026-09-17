import { NEVER, Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Todo } from '../shared/types';
import { createTodoApp, mountTodoApp, type TodoService } from './main';
import { action$, dispatch } from './todo.state';

const todo: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-09-17T00:00:00Z' };
const second: Todo = { ...todo, id: '2', title: 'Second' };
const apps: ReturnType<typeof createTodoApp>[] = [];
let form: HTMLFormElement;
let input: HTMLInputElement;
let list: HTMLElement;
let error: HTMLElement;

function service() {
	return {
		getAll$: vi.fn<TodoService['getAll$']>(() => of([todo, second])),
		create$: vi.fn<TodoService['create$']>(() => of({ ...todo, id: '3', title: 'Created' })),
		update$: vi.fn<TodoService['update$']>((id, body) => of({ ...todo, id, ...body })),
		remove$: vi.fn<TodoService['remove$']>(() => of(undefined)),
	};
}

function create(api = service()) {
	const app = createTodoApp(api);
	apps.push(app);
	return { app, api };
}

function submit(title = 'New todo') {
	input.value = title;
	const event = new Event('submit', { bubbles: true, cancelable: true });
	form.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	document.body.innerHTML = '<form id="add-form"><input id="title-input"></form><ul id="todo-list"></ul><p id="error-msg"></p>';
	form = document.querySelector('#add-form')!;
	input = document.querySelector('#title-input')!;
	list = document.querySelector('#todo-list')!;
	error = document.querySelector('#error-msg')!;
});

afterEach(() => {
	for (const app of apps.splice(0)) app.dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe('M01 app activation and disposal', () => {
	it('constructs without querying a root or activating a service', () => {
		const query = vi.spyOn(document.body, 'querySelector');
		const { api } = create();
		expect(query).not.toHaveBeenCalled();
		expect(api.getAll$).not.toHaveBeenCalled();
		expect(action$.observed).toBe(false);
	});

	it('starts once with one submit listener and renders synchronous startup results', () => {
		const attach = vi.spyOn(form, 'addEventListener');
		const { app, api } = create();
		app.start(document.body);
		app.start(document.body);
		expect(api.getAll$).toHaveBeenCalledOnce();
		expect(attach.mock.calls.filter(([type]) => type === 'submit')).toHaveLength(1);
		expect(list.textContent).toContain('First');
		expect(list.textContent).toContain('Second');
		expect(action$.observed).toBe(true);
	});

	it('releases the state connection, listeners and child DOM on repeated disposal', () => {
		const detach = vi.spyOn(form, 'removeEventListener');
		const { app, api } = create();
		app.start(document.body);
		app.dispose();
		app.dispose();
		expect(detach.mock.calls.filter(([type]) => type === 'submit')).toHaveLength(1);
		expect(list.childElementCount).toBe(0);
		expect(action$.observed).toBe(false);
		submit();
		app.start(document.body);
		expect(api.getAll$).toHaveBeenCalledOnce();
		expect(api.create$).not.toHaveBeenCalled();
	});

	it('does not start an app disposed before activation', () => {
		const { app, api } = create();
		app.dispose();
		app.start(document.body);
		expect(api.getAll$).not.toHaveBeenCalled();
		expect(submit().defaultPrevented).toBe(false);
	});

	it('unmounts and remounts with one active set, fresh state and inert old rows', () => {
		const { app: first, api: oldApi } = create();
		first.start(document.body);
		const oldDelete = list.querySelector('button')!;
		first.dispose();
		const { app: next, api } = create();
		api.getAll$.mockReturnValue(NEVER);
		next.start(document.body);
		expect(list.childElementCount).toBe(0);
		oldDelete.click();
		submit();
		expect(oldApi.remove$).not.toHaveBeenCalled();
		expect(oldApi.create$).not.toHaveBeenCalled();
		expect(api.create$).toHaveBeenCalledOnce();
	});

	it('captures trimmed submit values and prevents default before request activation', () => {
		const { app, api } = create();
		app.start(document.body);
		let observedDefault = false;
		const event = new Event('submit', { cancelable: true });
		api.create$.mockImplementation(body => {
			observedDefault = event.defaultPrevented;
			input.value = 'changed by service';
			return of({ ...todo, ...body });
		});
		input.value = '  captured  ';
		form.dispatchEvent(event);
		expect(observedDefault).toBe(true);
		expect(api.create$).toHaveBeenCalledExactlyOnceWith({ title: 'captured' });
		expect(input.value).toBe('');
	});

	it('preserves submit exhaustion and prevents default even while a request is pending', () => {
		const pending = new Subject<Todo>();
		const { app, api } = create();
		api.create$.mockReturnValue(pending);
		app.start(document.body);
		expect(submit('first').defaultPrevented).toBe(true);
		expect(submit('ignored').defaultPrevented).toBe(true);
		expect(api.create$).toHaveBeenCalledOnce();
		pending.complete();
		submit('next');
		expect(api.create$).toHaveBeenCalledTimes(2);
	});

	it('ignores empty submits and recovers from a failed create', () => {
		const { app, api } = create();
		app.start(document.body);
		submit('   ');
		expect(api.create$).not.toHaveBeenCalled();
		api.create$.mockReturnValueOnce(throwError(() => new Error('offline')));
		submit();
		expect(error.textContent).toBe('Failed to create todo.');
		submit();
		expect(api.create$).toHaveBeenCalledTimes(2);
		expect(list.textContent).toContain('Created');
	});

	it('disposes replaced rows while the current sibling remains interactive', () => {
		const { app, api } = create();
		app.start(document.body);
		const oldButtons = list.querySelectorAll('button');
		oldButtons[0]!.click();
		expect(list.textContent).not.toContain('First');
		oldButtons[1]!.click();
		expect(api.remove$).toHaveBeenCalledTimes(1);
		list.querySelector('button')!.click();
		expect(api.remove$).toHaveBeenLastCalledWith('2');
		expect(list.childElementCount).toBe(0);
	});

	it('does not initiate writes on rendering and owns updates across incidental row rebuilds', () => {
		const pending = new Subject<Todo>();
		const { app, api } = create();
		api.update$.mockReturnValue(pending);
		app.start(document.body);
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.update$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
		const checkbox = list.querySelector('input')!;
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change'));
		expect(api.update$).toHaveBeenCalledExactlyOnceWith('1', { completed: true });
		dispatch({ type: 'SET_ERROR', message: 'view rebuilt' });
		expect(pending.observed).toBe(true);
		pending.next({ ...todo, completed: true });
		expect(list.querySelector('input')!.checked).toBe(true);
		expect(api.update$).toHaveBeenCalledOnce();
		app.dispose();
		expect(pending.observed).toBe(false);
	});

	it.each(['load', 'create', 'update', 'delete'] as const)('cancels pending %s and ignores late results after disposal', operation => {
		const pendingTodo = new Subject<Todo>();
		const pendingList = new Subject<Todo[]>();
		const pendingDelete = new Subject<void>();
		const { app, api } = create();
		if (operation === 'load') api.getAll$.mockReturnValue(pendingList);
		if (operation === 'create') api.create$.mockReturnValue(pendingTodo);
		if (operation === 'update') api.update$.mockReturnValue(pendingTodo);
		if (operation === 'delete') api.remove$.mockReturnValue(pendingDelete);
		app.start(document.body);
		if (operation === 'create') submit();
		if (operation === 'update') list.querySelector('input')!.dispatchEvent(new Event('change'));
		if (operation === 'delete') list.querySelector('button')!.click();
		expect(pendingTodo.observed || pendingList.observed || pendingDelete.observed).toBe(true);
		app.dispose();
		const html = document.body.innerHTML;
		pendingTodo.next(todo);
		pendingList.next([todo]);
		pendingDelete.next();
		expect(pendingTodo.observed || pendingList.observed || pendingDelete.observed).toBe(false);
		expect(document.body.innerHTML).toBe(html);
	});

	it('prevents teardown-triggered inputs from starting another operation', () => {
		const { app, api } = create();
		api.getAll$.mockReturnValue(new Observable(() => () => { submit(); }));
		app.start(document.body);
		app.dispose();
		expect(api.create$).not.toHaveBeenCalled();
	});

	it('aborts the real client fetch before headers when disposed', () => {
		let signal: AbortSignal | undefined;
		vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => {
			signal = init.signal ?? undefined;
			return new Promise<Response>(() => {});
		}));
		const app = createTodoApp();
		apps.push(app);
		app.start(document.body);
		expect(signal?.aborted).toBe(false);
		app.dispose();
		expect(signal?.aborted).toBe(true);
	});

	it('validates a missing mount root before activating sources', () => {
		const { app, api } = create();
		expect(() => app.start(document.createElement('div'))).toThrow('Todo app requires');
		expect(api.getAll$).not.toHaveBeenCalled();
		app.start(document.body);
		expect(api.getAll$).toHaveBeenCalledOnce();
	});

	it('registers hot disposal that releases pending work before a replacement mount', () => {
		const oldApi = service();
		const pending = new Subject<Todo[]>();
		oldApi.getAll$.mockReturnValue(pending);
		let disposeHot: (() => void) | undefined;
		const app = mountTodoApp(document.body, {
			service: oldApi,
			hot: { dispose: callback => { disposeHot = callback; } },
		});
		apps.push(app);
		expect(pending.observed).toBe(true);
		expect(disposeHot).toBeTypeOf('function');
		disposeHot!();
		disposeHot!();
		expect(pending.observed).toBe(false);
		const api = service();
		apps.push(mountTodoApp(document.body, { service: api }));
		pending.next([{ ...todo, title: 'obsolete' }]);
		submit();
		expect(oldApi.create$).not.toHaveBeenCalled();
		expect(api.create$).toHaveBeenCalledOnce();
		expect(list.textContent).not.toContain('obsolete');
	});
});
