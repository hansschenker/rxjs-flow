import { TestScheduler } from 'rxjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTodoApp } from './main';
import { createTodoService } from './todo.service';
import type { FetchTransport } from './api';
import type { EventSourceConnection } from './sse';
import type { State } from './todo.state';
import type { TodoLiveSnapshot } from '../shared/todo-live';

const todo = { id: 'task-1', title: 'Committed task', completed: false, createdAt: '2026-09-20T00:00:00.000Z' };
function snapshot(revision = 0, generation = 'history-1', collectionId = 'shared'): TodoLiveSnapshot {
	return { schemaVersion: 1, collectionId, stateGeneration: generation, revision, todos: revision ? [todo] : [] };
}

function transport() {
	const connections: Array<ReturnType<typeof connection>> = [];
	let initial: TodoLiveSnapshot | undefined;
	function connection(url: string) {
		const listeners = new Map<string, (event: MessageEvent<string>) => void>();
		let stopped = false;
		const source: EventSourceConnection = {
			onerror: null,
			addEventListener(type, listener) {
				listeners.set(type, listener);
				if (initial) listener({ data: JSON.stringify(initial) } as MessageEvent<string>);
			},
			removeEventListener(type) { listeners.delete(type); },
			close() { stopped = true; },
		};
		return {
			url, source, listeners,
			get closed() { return stopped; },
			send(value: unknown) { listeners.get('todo-snapshot')?.({ data: JSON.stringify(value) } as MessageEvent<string>); },
			fail() { source.onerror?.(new Event('error')); },
		};
	}
	return {
		connections,
		setInitial(value: TodoLiveSnapshot) { initial = value; },
		createEventSource(url: string) {
			const next = connection(url);
			connections.push(next);
			return next.source;
		},
	};
}

const apps: ReturnType<typeof createTodoApp>[] = [];
function mount(harness: ReturnType<typeof transport>, fetch = vi.fn<FetchTransport>(), scheduler?: TestScheduler) {
	const root = document.createElement('section');
	root.innerHTML = '<form id="add-form"><input id="title-input"><button type="submit">Add</button></form><button id="refresh-todos">Refresh</button><ul id="todo-list"></ul><p id="error-msg"></p><p id="connection-status"></p>';
	document.body.append(root);
	const service = createTodoService({ fetch, live: { createEventSource: harness.createEventSource, scheduler, retryDelaysMs: [10, 20] } });
	const app = createTodoApp(service);
	apps.push(app);
	const states: State[] = [];
	app.state$.subscribe(state => states.push(state));
	app.start(root);
	return { root, app, states, fetch, service };
}

afterEach(() => {
	for (const app of apps.splice(0)) app.dispose();
	document.body.replaceChildren();
});

describe('M06 mounted application live ownership', () => {
	it('starts one connection after state and shares its snapshot with every UI consumer', () => {
		const harness = transport();
		harness.setInitial(snapshot(1));
		const { app, states, fetch, root } = mount(harness);
		const extraState = app.state$.subscribe();
		const extraView = app.viewModel$.subscribe();
		expect(harness.connections).toHaveLength(1);
		expect(harness.connections[0].url).toBe('/api/todos/live');
		expect(fetch).not.toHaveBeenCalled();
		expect(states.at(-1)?.todos).toEqual([todo]);
		expect(root.querySelector('#todo-list')!.children).toHaveLength(1);
		extraState.unsubscribe(); extraView.unsubscribe();
		expect(harness.connections[0].closed).toBe(false);
		app.dispose();
		expect(harness.connections[0].closed).toBe(true);
		expect(harness.connections[0].listeners.size).toBe(0);
	});

	it.each(['http-first', 'snapshot-first'] as const)('applies a committed create once when %s settles first', async order => {
		const harness = transport(); harness.setInitial(snapshot());
		let resolve!: (response: Response) => void;
		const fetch = vi.fn<FetchTransport>(() => new Promise<Response>(accept => { resolve = accept; }));
		const { root, states } = mount(harness, fetch);
		const input = root.querySelector<HTMLInputElement>('#title-input')!;
		input.value = todo.title;
		root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
		expect(fetch).toHaveBeenCalledTimes(1);
		if (order === 'snapshot-first') harness.connections[0].send(snapshot(1));
		resolve(new Response(JSON.stringify(todo), { status: 201 }));
		await vi.waitFor(() => expect(states.at(-1)?.pending).toEqual([]));
		if (order === 'http-first') {
			expect(states.at(-1)?.todos).toEqual([]);
			harness.connections[0].send(snapshot(1));
		}
		const collections = states.map(state => state.todos);
		expect(collections.filter((value, index) => value.length === 1 && value !== collections[index - 1])).toHaveLength(1);
		expect(root.querySelector('#todo-list')!.children).toHaveLength(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('disposes a retry wait so no connection opens later', () => {
		const scheduler = new TestScheduler(() => {});
		const harness = transport(); harness.setInitial(snapshot(1));
		const { app, states } = mount(harness, undefined, scheduler);
		harness.connections[0].fail();
		expect(states.at(-1)?.live?.stale).toBe(true);
		expect(harness.connections[0].closed).toBe(true);
		app.dispose();
		scheduler.flush();
		expect(harness.connections).toHaveLength(1);
	});

	it('manual reconnect replaces the old connection and ignores its captured callback', () => {
		const harness = transport(); harness.setInitial(snapshot(1));
		const { root, states, fetch } = mount(harness);
		const obsolete = harness.connections[0].listeners.get('todo-snapshot')!;
		root.querySelector<HTMLButtonElement>('#refresh-todos')!.click();
		expect(harness.connections).toHaveLength(2);
		expect(harness.connections[0].closed).toBe(true);
		obsolete({ data: JSON.stringify({ ...snapshot(999), todos: [] }) } as MessageEvent<string>);
		expect(states.at(-1)?.todos).toEqual([todo]);
		expect(states.at(-1)?.live?.connectionId).toBe(2);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('closes malformed protocol and permits explicit recovery without mutating remembered state', () => {
		const scheduler = new TestScheduler(() => {});
		const harness = transport(); harness.setInitial(snapshot(1));
		const { app, states } = mount(harness, undefined, scheduler);
		harness.connections[0].send({ ...snapshot(2), revision: 'two' });
		expect(harness.connections[0].closed).toBe(true);
		expect(states.at(-1)?.todos).toEqual([todo]);
		expect(states.at(-1)?.live?.error).toContain('Invalid live snapshot');
		scheduler.flush();
		expect(harness.connections).toHaveLength(1);
		app.refresh();
		expect(harness.connections).toHaveLength(2);
		expect(states.at(-1)?.connection).toBe('connected');
	});

	it('rejects a changed history within a connection, then accepts it from a fresh connection', () => {
		const harness = transport(); harness.setInitial(snapshot(1));
		const { app, states } = mount(harness);
		harness.connections[0].send(snapshot(0, 'replacement'));
		expect(harness.connections[0].closed).toBe(true);
		expect(states.at(-1)?.live?.identity?.stateGeneration).toBe('history-1');
		harness.setInitial(snapshot(0, 'replacement'));
		app.refresh();
		expect(states.at(-1)?.live?.identity?.stateGeneration).toBe('replacement');
		expect(states.at(-1)?.todos).toEqual([]);
	});

	it('pins the collection across manual reconnections', () => {
		const harness = transport(); harness.setInitial(snapshot(1));
		const { app, states } = mount(harness);
		harness.setInitial(snapshot(0, 'other-history', 'other-collection'));
		app.refresh();
		expect(harness.connections[1].closed).toBe(true);
		expect(states.at(-1)?.live?.identity?.collectionId).toBe('shared');
		expect(states.at(-1)?.todos).toEqual([todo]);
	});

	it('closes a reconnect whose first snapshot regresses the remembered revision', () => {
		const harness = transport(); harness.setInitial(snapshot(2));
		const { app, states } = mount(harness);
		harness.setInitial(snapshot(1));
		app.refresh();
		expect(harness.connections[1].closed).toBe(true);
		expect(states.at(-1)?.live?.identity?.revision).toBe(2);
		expect(states.at(-1)?.live?.stale).toBe(true);
		expect(states.at(-1)?.live?.error).toContain('older than the remembered state');
	});

	it('initial-state disposal prevents all live construction', () => {
		const harness = transport();
		const service = createTodoService({ live: { createEventSource: harness.createEventSource } });
		const app = createTodoApp(service); apps.push(app);
		app.state$.subscribe(() => app.dispose());
		const root = document.createElement('section');
		root.innerHTML = '<form id="add-form"><input id="title-input"></form><ul id="todo-list"></ul><p id="error-msg"></p>';
		app.start(root);
		expect(harness.connections).toHaveLength(0);
	});
});
