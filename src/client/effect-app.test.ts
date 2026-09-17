import { Subject, filter, firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTodoApp, type TodoAppOptions } from './main';
import { createTodoService, type TodoService } from './todo.service';
import type { FetchTransport } from './api';
import type { Todo } from '../shared/types';
import type { Action, State } from './todo.state';

const first: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-09-17T00:00:00Z' };
const second: Todo = { ...first, id: '2', title: 'Second' };
const apps: ReturnType<typeof createTodoApp>[] = [];
let form: HTMLFormElement;
let input: HTMLInputElement;
let add: HTMLButtonElement;
let list: HTMLElement;

function service() {
	return {
		getAll$: vi.fn<TodoService['getAll$']>(() => of([first, second])),
		create$: vi.fn<TodoService['create$']>(body => of({ ...first, id: '3', title: body.title })),
		update$: vi.fn<TodoService['update$']>((id, body) => of({ ...first, id, ...body })),
		remove$: vi.fn<TodoService['remove$']>(() => of(undefined)),
	};
}

function appFor(api: TodoService, options?: TodoAppOptions) {
	const app = createTodoApp(api, options);
	apps.push(app);
	return app;
}

function submit(value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input'));
	form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function nextFact(app: ReturnType<typeof createTodoApp>, type: Action['type']) {
	return firstValueFrom(app.transitions$.pipe(filter(({ message }) => message.type === type)));
}

beforeEach(() => {
	document.body.innerHTML = '<form id="add-form"><input id="title-input"><button type="submit">Add</button></form><button id="refresh-todos">Refresh</button><ul id="todo-list"></ul><p id="error-msg"></p>';
	form = document.querySelector('#add-form')!;
	input = document.querySelector('#title-input')!;
	add = form.querySelector('button')!;
	list = document.querySelector('#todo-list')!;
});

afterEach(() => {
	apps.splice(0).forEach(app => app.dispose());
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe('M03 complete app effect loop', () => {
	it('preserves a failed HTTP DELETE and its details, then accepts a successful retry without duplicate requests', async () => {
		const responses = [Response.json([first, second]), Response.json({ error: 'Conflict', details: { id: '1' } }, { status: 409 }), new Response(null, { status: 204 })];
		const fetch = vi.fn<FetchTransport>(() => Promise.resolve(responses.shift()!));
		const app = appFor(createTodoService({ fetch }));
		const states: State[] = [];
		app.state$.subscribe(state => states.push(state));
		for (let i = 0; i < 3; i++) {
			app.state$.subscribe();
			app.viewModel$.subscribe();
			app.transitions$.subscribe();
		}
		const loaded = nextFact(app, 'LOAD_SUCCEEDED');
		app.start(document.body);
		await loaded;
		expect(fetch).toHaveBeenCalledTimes(1);
		const failed = nextFact(app, 'OPERATION_FAILED');
		list.querySelector('button')!.click();
		await failed;
		expect(list.childElementCount).toBe(2);
		expect(states.at(-1)?.pending).toEqual([]);
		expect(states.at(-1)?.failure).toMatchObject({ kind: 'http', status: 409, message: 'Conflict', details: { id: '1' } });
		expect(document.querySelector('#error-msg')!.textContent).toBe('Conflict');
		const succeeded = nextFact(app, 'DELETE_SUCCEEDED');
		list.querySelector('button')!.click();
		await succeeded;
		expect(list.childElementCount).toBe(1);
		expect(list.textContent).toContain('Second');
		expect(states.at(-1)?.failure).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('keeps a draft after malformed HTTP data and processes the next valid create', async () => {
		const responses = [Response.json([]), Response.json({ id: 'bad' }), Response.json({ ...first, title: 'Retry' }, { status: 201 })];
		const fetch = vi.fn<FetchTransport>(() => Promise.resolve(responses.shift()!));
		const app = appFor(createTodoService({ fetch }));
		const loaded = nextFact(app, 'LOAD_SUCCEEDED');
		app.start(document.body);
		await loaded;
		const failed = nextFact(app, 'OPERATION_FAILED');
		submit('Keep draft');
		await failed;
		expect(input.value).toBe('Keep draft');
		expect(list.childElementCount).toBe(0);
		expect(add.disabled).toBe(false);
		const created = nextFact(app, 'CREATE_SUCCEEDED');
		submit('Retry');
		await created;
		expect(list.textContent).toContain('Retry');
		expect(input.value).toBe('');
	});

	it('cancels an obsolete real body read when Refresh arrives and ignores its late data', async () => {
		const cancel = vi.fn();
		let startedBody!: () => void;
		const bodyStarted = new Promise<void>(resolve => { startedBody = resolve; });
		const stream: ReadableStream<Uint8Array> = new ReadableStream({
			pull: () => { if (stream.locked) startedBody(); }, cancel,
		});
		const responses = [new Response(stream, { status: 200 }), Response.json([second])];
		const fetch = vi.fn<FetchTransport>(() => Promise.resolve(responses.shift()!));
		const app = appFor(createTodoService({ fetch }));
		const facts: Action[] = [];
		app.transitions$.subscribe(({ message }) => facts.push(message));
		app.start(document.body);
		await bodyStarted;
		expect(stream.locked).toBe(true);
		const refreshed = nextFact(app, 'LOAD_SUCCEEDED');
		document.querySelector<HTMLButtonElement>('#refresh-todos')!.click();
		await refreshed;
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
		expect(list.textContent).toContain('Second');
		expect(list.textContent).not.toContain('First');
		expect(facts.filter(action => action.type === 'OPERATION_CANCELLED')).toHaveLength(1);
		expect(facts.filter(action => action.type === 'LOAD_SUCCEEDED')).toHaveLength(1);
	});

	it('holds the create gate while queued, exposes pending, rejects overflow and releases everything on dispose', () => {
		const api = service();
		const pending = new Subject<Todo>();
		api.update$.mockReturnValue(pending);
		const app = appFor(api, { mutationCapacity: 2 });
		const states: State[] = [];
		app.state$.subscribe(state => states.push(state));
		app.start(document.body);
		const checkbox = list.querySelector('input')!;
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change'));
		submit('Accepted create');
		expect(api.create$).not.toHaveBeenCalled();
		expect(add.disabled).toBe(true);
		expect(add.textContent).toBe('Adding…');
		expect(form.getAttribute('aria-busy')).toBe('true');
		submit('Ignored while busy');
		list.querySelector('button')!.click();
		expect(states.at(-1)?.pending).toHaveLength(2);
		expect(document.querySelector('#error-msg')!.textContent).toContain('queue is full');
		expect(api.remove$).not.toHaveBeenCalled();
		app.dispose();
		pending.next({ ...first, completed: true });
		expect(pending.observed).toBe(false);
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
	});

	it('serializes update, create and delete while preserving the accepted draft', () => {
		const api = service();
		const pendingUpdate = new Subject<Todo>();
		const pendingCreate = new Subject<Todo>();
		api.update$.mockReturnValue(pendingUpdate);
		api.create$.mockReturnValue(pendingCreate);
		const app = appFor(api);
		app.start(document.body);
		list.querySelector('input')!.dispatchEvent(new Event('change'));
		submit('  Captured  ');
		list.querySelectorAll('button')[1]!.click();
		input.value = 'Newer draft';
		input.dispatchEvent(new Event('input'));
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
		pendingUpdate.next(first);
		expect(pendingUpdate.observed).toBe(false);
		expect(api.create$).toHaveBeenCalledExactlyOnceWith({ title: 'Captured' });
		expect(api.remove$).not.toHaveBeenCalled();
		pendingCreate.next({ ...first, id: '3', title: 'Captured' });
		expect(api.remove$).toHaveBeenCalledExactlyOnceWith('2');
		expect(input.value).toBe('Newer draft');
		expect(add.disabled).toBe(false);
		expect(list.textContent).toContain('Captured');
		expect(list.textContent).not.toContain('Second');
	});

	it('reports a render fault and disposes transport, model and listeners', () => {
		const api = service();
		const pending = new Subject<Todo[]>();
		api.getAll$.mockReturnValue(pending);
		const reportError = vi.fn();
		const app = appFor(api, { reportError });
		const completed = vi.fn();
		app.state$.subscribe({ complete: completed });
		app.start(document.body);
		const failure = new Error('DOM commit failed');
		vi.spyOn(list, 'insertBefore').mockImplementationOnce(() => { throw failure; });
		pending.next([first]);
		expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(pending.observed).toBe(false);
		expect(completed).toHaveBeenCalledOnce();
		const event = new Event('submit', { cancelable: true });
		form.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('reports an invalid effect configuration before activating requests', () => {
		const api = service();
		const reportError = vi.fn();
		const app = appFor(api, { mutationCapacity: 0, reportError });
		app.start(document.body);
		expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.any(RangeError));
		expect(api.getAll$).not.toHaveBeenCalled();
	});

	it('disposal from the intent before the effect consumer prevents request activation', () => {
		const api = service();
		const app = appFor(api);
		app.transitions$.subscribe(({ message }) => {
			if (message.type === 'CREATE_REQUESTED') app.dispose();
		});
		app.start(document.body);
		submit('Dispose now');
		expect(api.create$).not.toHaveBeenCalled();
	});
});
