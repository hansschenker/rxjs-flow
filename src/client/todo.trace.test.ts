import { Observable, Subject, of, throwError } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrace, type TraceRecord } from '../shared/trace';
import type { Todo } from '../shared/types';
import type { LiveConnectionEvent } from './live-connection';
import type { TodoLiveSnapshot } from '../shared/todo-live';
import { createTodoProgram } from './todo.program';
import { createTodoModel } from './todo.model';
import { todoEffects$ } from './todo.effects';
import { createTodoService, type TodoService } from './todo.service';
import type { RequestTraceContext } from './api';

const first: Todo = { id: '1', title: 'private-title', completed: false, createdAt: '2026-09-20T00:00:00Z' };
const apps: Array<{ dispose(): void }> = [];

function shell(): ShadowRoot {
	const host = document.createElement('section');
	const root = host.attachShadow({ mode: 'open' });
	root.innerHTML = '<form id="add-form"><input id="title-input"></form><ul id="todo-list"></ul><p id="error-msg"></p>';
	document.body.append(host);
	return root;
}

function submit(host: ParentNode, value: string): void {
	host.querySelector<HTMLInputElement>('#title-input')!.value = value;
	host.querySelector('#add-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function service(overrides: Partial<TodoService> = {}): TodoService {
	return { getAll$: () => of([first]), create$: body => of({ ...first, id: '2', title: body.title }),
		update$: (id, body) => of({ ...first, id, ...body }), remove$: () => of(undefined), ...overrides };
}

function collector(runtimeId = 'client', now: () => number = () => 7) {
	const records: TraceRecord[] = [];
	const trace = createTrace({ runtimeId, now, sink: record => records.push(record) });
	return { trace, records };
}

afterEach(() => {
	for (const app of apps.splice(0)) app.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe('M08 Todo observations at owned boundaries', () => {
	it('keeps actual HTTP counts and bodies unchanged and correlates the completed render without a second effect', async () => {
		async function run(traced: boolean) {
			const host = shell();
			const { records } = collector();
			const renderedCounts: number[] = [];
			const trace = traced ? createTrace({ runtimeId: 'browser', now: () => 7, sink(record) {
				records.push(record);
				if (record.event === 'render.commit' && record.metadata?.kind === 'CREATE_SUCCEEDED') {
					renderedCounts.push(host.querySelector('#todo-list')!.childElementCount);
				}
			} }) : undefined;
			const requests: Array<{ url: string; method: string | undefined; headers: RequestInit['headers']; body: BodyInit | null | undefined; context?: RequestTraceContext }> = [];
			const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit, context?: RequestTraceContext) => {
				requests.push({ url: String(input), method: init?.method, headers: init?.headers, body: init?.body, context });
				return new Response(JSON.stringify(init?.method === 'POST' ? { ...first, id: '2' } : [first]), { status: init?.method === 'POST' ? 201 : 200 });
			});
			const api = { ...createTodoService({ fetch }), live$: undefined };
			const app = createTodoProgram(api, { trace, traceScope: 'app' });
			apps.push(app);
			app.state$.subscribe();
			app.state$.subscribe();
			app.viewModel$.subscribe();
			app.transitions$.subscribe();
			expect(fetch).not.toHaveBeenCalled();
			expect(records).toHaveLength(0);
			app.start(host);
			await vi.waitFor(() => expect(host.querySelector('#todo-list')!.childElementCount).toBe(1));
			submit(host, 'private-draft');
			await vi.waitFor(() => expect(host.querySelector('#todo-list')!.childElementCount).toBe(2));
			app.dispose();
			return { requests, records, renderedCounts };
		}
		const plain = await run(false);
		const traced = await run(true);
		expect(traced.requests.map(({ context: _, ...request }) => request)).toEqual(plain.requests.map(({ context: _, ...request }) => request));
		expect(traced.requests).toHaveLength(2);
		expect(plain.requests.every(request => request.context === undefined)).toBe(true);
		expect(traced.requests.map(request => request.context?.operationId)).toEqual(['browser:app:1', 'browser:app:2']);
		expect(traced.renderedCounts).toEqual([2]);
		const operation = traced.records.filter(record => record.operationId === 'browser:app:2');
		const accepted = operation.find(record => record.event === 'intent.accepted')!;
		const subscribe = operation.find(record => record.event === 'effect.subscribe')!;
		const next = operation.find(record => record.event === 'effect.next')!;
		const complete = operation.find(record => record.event === 'effect.complete')!;
		const state = operation.find(record => record.event === 'state.transition' && record.metadata?.kind === 'CREATE_SUCCEEDED')!;
		const render = operation.find(record => record.event === 'render.commit' && record.metadata?.kind === 'CREATE_SUCCEEDED')!;
		expect(accepted.sequence).toBeLessThan(subscribe.sequence);
		expect(subscribe.sequence).toBeLessThan(next.sequence);
		expect(next.sequence).toBeLessThan(complete.sequence);
		expect(state.sequence).toBeLessThan(render.sequence);
		expect(operation.some(record => record.event === 'effect.cancel')).toBe(false);
		expect(traced.records.every(record => record.time === 7)).toBe(true);
		expect(JSON.stringify(traced.records)).not.toMatch(/private-title|private-draft|createdAt|Content-Type/);
	});

	it('shares one live owner, records its identity and releases the live source and old DOM listeners', () => {
		const { trace, records } = collector();
		const notifications = new Subject<LiveConnectionEvent<TodoLiveSnapshot>>();
		let active = 0;
		let starts = 0;
		const api = service({ live$: () => new Observable(subscriber => {
			starts++;
			active++;
			const input = notifications.subscribe(subscriber);
			return () => { input.unsubscribe(); active--; };
		}) });
		const host = shell();
		const app = createTodoProgram(api, { trace });
		apps.push(app);
		app.state$.subscribe();
		app.viewModel$.subscribe();
		app.transitions$.subscribe();
		app.start(host);
		notifications.next({ type: 'connecting', connectionId: 1, attempt: 1 });
		notifications.next({ type: 'snapshot', connectionId: 1, value: {
			schemaVersion: 1, collectionId: 'local-reference', stateGeneration: 'history-a', revision: 4, todos: [first],
		} });
		expect(active).toBe(1);
		expect(starts).toBe(1);
		expect(host.querySelector('#todo-list')!.childElementCount).toBe(1);
		expect(records.find(record => record.event === 'render.commit' && record.revision === 4)).toMatchObject({
			collectionId: 'local-reference', stateGeneration: 'history-a', connectionId: '1',
		});
		app.dispose();
		expect(active).toBe(0);
		expect(notifications.observed).toBe(false);
		expect(records.filter(record => record.event === 'effect.cancel' && record.sourceId === 'todo.live-owner')).toHaveLength(1);
		const oldSubmit = new Event('submit', { cancelable: true });
		host.querySelector('#add-form')!.dispatchEvent(oldSubmit);
		expect(oldSubmit.defaultPrevented).toBe(false);
		expect(host.querySelector('#todo-list')!.childElementCount).toBe(0);
	});

	it('records latest-read cancellation before the replacement subscription at scheduler time', () => {
		const clock = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
		clock.run(({ cold, expectSubscriptions, flush }) => {
			const { trace, records } = collector('virtual-client', () => clock.now());
			const oldRead = cold('-----a|', { a: [first] });
			const newRead = cold('--a|', { a: [first] });
			const getAll$ = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(newRead);
			const model = createTodoModel({ trace, traceScope: 'app' });
			const effects = todoEffects$(model.transitions$, service({ getAll$ }), { trace, traceScope: 'app' }).subscribe(model.dispatch);
			model.start();
			model.dispatch({ type: 'LOAD_REQUESTED' });
			clock.schedule(() => model.dispatch({ type: 'LOAD_REQUESTED' }), 3);
			expectSubscriptions(oldRead.subscriptions).toBe('^--!');
			expectSubscriptions(newRead.subscriptions).toBe('---^-!');
			flush();
			const cancelled = records.find(record => record.event === 'effect.cancel')!;
			const replacement = records.find(record => record.event === 'effect.subscribe' && record.operationId?.endsWith(':2'))!;
			expect(cancelled).toMatchObject({ time: 3, operationId: 'virtual-client:app:1' });
			expect(cancelled.sequence).toBeLessThan(replacement.sequence);
			expect(records.filter(record => record.event === 'effect.complete')).toHaveLength(1);
			effects.unsubscribe();
			model.dispose();
		});
	});

	it('reports bounded write admission and queue release, without accepting overflow or a busy create', () => {
		const { trace, records } = collector();
		let active = 0;
		let started = 0;
		const pending = new Subject<Todo>();
		const api = service({ update$: () => new Observable(subscriber => {
			started++;
			active++;
			pending.subscribe(subscriber);
			return () => { active--; };
		}) });
		const model = createTodoModel({ trace, traceScope: 'app' });
		const run = todoEffects$(model.transitions$, api, { trace, traceScope: 'app', mutationCapacity: 2 }).subscribe(model.dispatch);
		model.start();
		model.dispatch({ type: 'LOAD_REQUESTED' });
		model.dispatch({ type: 'TOGGLE_REQUESTED', id: '1', completed: true });
		model.dispatch({ type: 'CREATE_REQUESTED', title: 'private-queued' });
		model.dispatch({ type: 'CREATE_REQUESTED', title: 'private-ignored' });
		model.dispatch({ type: 'DELETE_REQUESTED', id: '1' });
		expect(records.filter(record => record.event === 'intent.accepted').map(record => record.metadata?.kind)).toEqual(['load', 'update', 'create']);
		expect(records.filter(record => record.sourceId === 'todo.mutation-queue' && record.metadata?.reason === 'overflow')).toHaveLength(1);
		expect(records.some(record => record.sourceId === 'todo.mutation-queue' && record.metadata?.active === 1 && record.metadata?.queued === 1)).toBe(true);
		expect(started).toBe(1);
		expect(active).toBe(1);
		run.unsubscribe();
		model.dispose();
		expect(active).toBe(0);
		expect(pending.observed).toBe(false);
		pending.next(first);
		expect(started).toBe(1);
		expect(records.filter(record => record.sourceId === 'todo.mutation-queue').at(-1)?.metadata).toMatchObject({ active: 0, queued: 0, count: 0, capacity: 2, reason: 'disposed' });
	});

	it('isolates failing diagnostic clocks and sinks from synchronous application results', () => {
		const trace = createTrace({ runtimeId: 'failing-observer', now() { throw new Error('clock'); }, sink() { throw new Error('sink'); } });
		const api = service();
		const getAll = vi.spyOn(api, 'getAll$');
		const host = shell();
		const app = createTodoProgram(api, { trace });
		apps.push(app);
		app.start(host);
		submit(host, 'private-value');
		expect(getAll).toHaveBeenCalledTimes(1);
		expect(host.querySelector('#todo-list')!.childElementCount).toBe(2);
		expect(trace.diagnostics.clockFailures).toBeGreaterThan(0);
		expect(trace.diagnostics.sinkFailures).toBeGreaterThan(0);
	});

	it('records a finite error before its recovery fact and keeps later writes available without logging the failure', () => {
		const { trace, records } = collector();
		let requests = 0;
		const api = service({ create$: body => {
			requests++;
			return requests === 1 ? throwError(() => new Error('private-failure-body'))
				: of({ ...first, id: '2', title: body.title });
		} });
		const host = shell();
		const app = createTodoProgram(api, { trace, traceScope: 'app' });
		apps.push(app);
		app.start(host);
		submit(host, 'private-draft');
		expect(host.querySelector('#error-msg')!.textContent).toBe('private-failure-body');
		const error = records.find(record => record.event === 'effect.error' && record.operationId === 'client:app:2')!;
		const failedState = records.find(record => record.event === 'state.transition' && record.metadata?.kind === 'OPERATION_FAILED')!;
		expect(error.sequence).toBeLessThan(failedState.sequence);
		expect(records.some(record => record.operationId === error.operationId && record.event === 'effect.cancel')).toBe(false);
		submit(host, 'private-recovery');
		expect(requests).toBe(2);
		expect(host.querySelector('#error-msg')!.textContent).toBe('');
		expect(host.querySelector('#todo-list')!.childElementCount).toBe(2);
		expect(JSON.stringify(records)).not.toContain('private-');
	});

	it('propagates disposal from an inline next trace to a synchronous producer in the same stack', () => {
		let produced = 0;
		let released = 0;
		let app: ReturnType<typeof createTodoProgram>;
		const trace = createTrace({ runtimeId: 'dispose-on-next', sink(record) {
			if (record.event === 'effect.next') app.dispose();
		} });
		const api = service({ getAll$: () => new Observable(subscriber => {
			for (let index = 0; index < 3 && !subscriber.closed; index++) {
				produced++;
				subscriber.next([first]);
			}
			return () => { released++; };
		}) });
		app = createTodoProgram(api, { trace });
		apps.push(app);
		const host = shell();
		app.start(host);
		expect(produced).toBe(1);
		expect(released).toBe(1);
		expect(host.querySelector('#todo-list')!.childElementCount).toBe(0);
	});

	it('owns synchronous setup before a trace sink disposes the app at effect subscribe', () => {
		const api = service();
		const getAll = vi.spyOn(api, 'getAll$');
		let app: ReturnType<typeof createTodoProgram>;
		const trace = createTrace({ runtimeId: 'dispose-on-subscribe', sink(record) {
			if (record.event === 'effect.subscribe') app.dispose();
		} });
		app = createTodoProgram(api, { trace });
		apps.push(app);
		const host = shell();
		app.start(host);
		expect(getAll).not.toHaveBeenCalled();
		expect(host.querySelector('#todo-list')!.childElementCount).toBe(0);
		const event = new Event('submit', { cancelable: true });
		host.querySelector('#add-form')!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('gives separate app factories separate operation identities in one runtime', () => {
		const { trace, records } = collector();
		const firstApp = createTodoProgram(service(), { trace });
		const secondApp = createTodoProgram(service(), { trace });
		apps.push(firstApp, secondApp);
		firstApp.start(shell());
		secondApp.start(shell());
		const ids = records.filter(record => record.event === 'intent.accepted').map(record => record.operationId);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});
});
