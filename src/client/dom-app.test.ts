import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Todo } from '../shared/types';
import { createTodoApp, type TodoAppOptions } from './main';
import type { TodoService } from './todo.service';

const first: Todo = { id: '1', title: 'First', completed: false, createdAt: '2026-09-17T00:00:00Z' };
const second: Todo = { ...first, id: '2', title: 'Second' };
const apps: ReturnType<typeof createTodoApp>[] = [];
const observers: MutationObserver[] = [];
let form: HTMLFormElement;
let input: HTMLInputElement;
let list: HTMLElement;
let error: HTMLElement;

function service() {
	return {
		getAll$: vi.fn<TodoService['getAll$']>(() => of([first, second])),
		create$: vi.fn<TodoService['create$']>(body => of({ ...first, id: '3', title: body.title })),
		update$: vi.fn<TodoService['update$']>((id, body) => of({ ...(id === first.id ? first : second), ...body })),
		remove$: vi.fn<TodoService['remove$']>(() => of(undefined)),
	};
}

function mount(api = service(), options?: TodoAppOptions) {
	const app = createTodoApp(api, options);
	apps.push(app);
	app.start(document.body);
	return { app, api };
}

function observe(target: Node, options: MutationObserverInit = { attributes: true, childList: true, characterData: true, subtree: true }) {
	const observer = new MutationObserver(() => {});
	observer.observe(target, options);
	observers.push(observer);
	return observer;
}

function row(position: number): HTMLElement {
	return list.querySelectorAll<HTMLElement>('li')[position]!;
}

function checkbox(element: HTMLElement): HTMLInputElement {
	return element.querySelector('input')!;
}

function removeButton(element: HTMLElement): HTMLButtonElement {
	return element.querySelector('button')!;
}

function editDraft(value: string): void {
	input.value = value;
	input.dispatchEvent(new Event('input'));
}

function submit(value: string): void {
	editDraft(value);
	form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function toggle(element: HTMLInputElement, completed: boolean): void {
	element.checked = completed;
	element.dispatchEvent(new Event('change'));
}

beforeEach(() => {
	document.body.innerHTML = '<form id="add-form"><input id="title-input"><button type="submit">Add</button></form><button id="refresh-todos" type="button">Refresh</button><ul id="todo-list"></ul><p id="error-msg"></p>';
	form = document.querySelector('#add-form')!;
	input = document.querySelector('#title-input')!;
	list = document.querySelector('#todo-list')!;
	error = document.querySelector('#error-msg')!;
});

afterEach(() => {
	observers.splice(0).forEach(observer => observer.disconnect());
	apps.splice(0).forEach(app => app.dispose());
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe('M04 app-owned targeted DOM', () => {
	it('keeps the list and every row unchanged across unrelated pending and failure values', () => {
		const api = service();
		const createResult = new Subject<Todo>();
		api.create$.mockReturnValue(createResult);
		mount(api);
		const firstRow = row(0);
		const secondRow = row(1);
		const mutations = observe(list);

		submit('Keep draft after failure');
		expect(form.getAttribute('aria-busy')).toBe('true');
		expect(row(0)).toBe(firstRow);
		expect(row(1)).toBe(secondRow);
		createResult.error(new Error('Create unavailable'));

		expect(error.textContent).toBe('Create unavailable');
		expect(form.getAttribute('aria-busy')).toBe('false');
		expect(input.value).toBe('Keep draft after failure');
		expect(document.querySelector('#todo-list')).toBe(list);
		expect(row(0)).toBe(firstRow);
		expect(row(1)).toBe(secondRow);
		expect(mutations.takeRecords()).toEqual([]);
	});

	it('changes only the intended row and leaves sibling properties, text and attributes untouched', () => {
		const api = service();
		const updateResult = new Subject<Todo>();
		api.update$.mockReturnValue(updateResult);
		mount(api);
		const firstRow = row(0);
		const secondRow = row(1);
		const firstCheckbox = checkbox(firstRow);
		const siblingChecked = vi.spyOn(checkbox(secondRow), 'checked', 'set');
		const siblingText = vi.spyOn(secondRow.querySelector('span')!, 'textContent', 'set');
		const siblingMutations = observe(secondRow);
		const listMutations = observe(list, { childList: true });

		toggle(firstCheckbox, true);
		expect(firstRow.getAttribute('aria-busy')).toBe('true');
		expect(firstCheckbox.checked).toBe(true);
		updateResult.next({ ...first, title: 'First confirmed', completed: true });

		expect(row(0)).toBe(firstRow);
		expect(row(1)).toBe(secondRow);
		expect(checkbox(firstRow)).toBe(firstCheckbox);
		expect(firstRow.querySelector('span')!.textContent).toBe('First confirmed');
		expect(firstRow.classList.contains('completed')).toBe(true);
		expect(firstCheckbox.checked).toBe(true);
		expect(firstRow.getAttribute('aria-busy')).toBe('false');
		expect(siblingChecked).not.toHaveBeenCalled();
		expect(siblingText).not.toHaveBeenCalled();
		expect(siblingMutations.takeRecords()).toEqual([]);
		expect(listMutations.takeRecords()).toEqual([]);
		expect(api.update$).toHaveBeenCalledExactlyOnceWith('1', { completed: true });
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
	});

	it('disposes a deleted row once while the original sibling remains bound and interactive', () => {
		const { app, api } = mount();
		const deletedRow = row(0);
		const sibling = row(1);
		const deletedCheckbox = checkbox(deletedRow);
		const deletedButton = removeButton(deletedRow);
		const detachCheckbox = vi.spyOn(deletedCheckbox, 'removeEventListener');
		const detachButton = vi.spyOn(deletedButton, 'removeEventListener');

		deletedButton.click();
		expect(deletedRow.isConnected).toBe(false);
		expect(row(0)).toBe(sibling);
		expect(detachCheckbox.mock.calls.filter(([type]) => type === 'change')).toHaveLength(1);
		expect(detachButton.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1);
		const deletedMutations = observe(deletedRow);
		deletedButton.click();
		toggle(deletedCheckbox, true);
		expect(api.remove$).toHaveBeenCalledExactlyOnceWith('1');
		expect(api.update$).not.toHaveBeenCalled();

		api.getAll$.mockReturnValueOnce(of([{ ...second, title: 'Live sibling' }]));
		app.refresh();
		expect(row(0)).toBe(sibling);
		expect(sibling.querySelector('span')!.textContent).toBe('Live sibling');
		expect(deletedRow.querySelector('span')!.textContent).toBe('First');
		expect(deletedMutations.takeRecords()).toEqual([]);
		removeButton(sibling).click();
		expect(api.remove$).toHaveBeenCalledTimes(2);
		expect(api.remove$).toHaveBeenLastCalledWith('2');
		expect(list.querySelectorAll('li')).toHaveLength(0);
		app.dispose();
		expect(detachCheckbox.mock.calls.filter(([type]) => type === 'change')).toHaveLength(1);
		expect(detachButton.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1);
	});

	it('reorders existing keys without replacing their rows or losing focused controls', () => {
		const { app, api } = mount();
		const firstRow = row(0);
		const secondRow = row(1);
		const focused = checkbox(firstRow);
		focused.focus();
		expect(document.activeElement).toBe(focused);

		api.getAll$.mockReturnValueOnce(of([{ ...second }, { ...first }]));
		app.refresh();

		expect(row(0)).toBe(secondRow);
		expect(row(1)).toBe(firstRow);
		expect(document.activeElement).toBe(focused);
		expect(checkbox(firstRow)).toBe(focused);
		expect(api.update$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
	});

	it('preserves unsent draft text, focus and selection while refreshed rows change and reorder', () => {
		const { app, api } = mount();
		editDraft('Unsent local draft');
		input.focus();
		input.setSelectionRange(7, 12, 'backward');
		const setValue = vi.spyOn(input, 'value', 'set');
		const firstRow = row(0);
		const secondRow = row(1);
		api.getAll$.mockReturnValueOnce(of([{ ...second, title: 'Server changed second' }, { ...first, completed: true }]));

		app.refresh();

		expect(input.value).toBe('Unsent local draft');
		expect(document.activeElement).toBe(input);
		expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([7, 12, 'backward']);
		expect(setValue).not.toHaveBeenCalled();
		expect(row(0)).toBe(secondRow);
		expect(row(1)).toBe(firstRow);
		expect(secondRow.querySelector('span')!.textContent).toBe('Server changed second');
		expect(checkbox(firstRow).checked).toBe(true);
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.update$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
	});

	it('does no row writes or network mutations for repeated equivalent collections and additional view consumers', () => {
		const { app, api } = mount();
		const firstRow = row(0);
		const secondRow = row(1);
		const mutations = observe(list);
		const setFirstChecked = vi.spyOn(checkbox(firstRow), 'checked', 'set');
		const setSecondChecked = vi.spyOn(checkbox(secondRow), 'checked', 'set');
		const consumers = [app.state$.subscribe(), app.viewModel$.subscribe(), app.transitions$.subscribe()];
		api.getAll$.mockReturnValue(of([{ ...first }, { ...second }]));

		app.refresh();
		app.refresh();
		editDraft('A draft also leaves the list alone');
		consumers.forEach(consumer => consumer.unsubscribe());

		expect(row(0)).toBe(firstRow);
		expect(row(1)).toBe(secondRow);
		expect(mutations.takeRecords()).toEqual([]);
		expect(setFirstChecked).not.toHaveBeenCalled();
		expect(setSecondChecked).not.toHaveBeenCalled();
		expect(api.getAll$).toHaveBeenCalledTimes(3);
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.update$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
	});

	it('restores a failed native checkbox change on the same row and accepts the next toggle', () => {
		const api = service();
		const updateResult = new Subject<Todo>();
		api.update$.mockReturnValueOnce(updateResult);
		mount(api);
		const firstRow = row(0);
		const firstCheckbox = checkbox(firstRow);
		const sibling = row(1);
		const siblingMutations = observe(sibling);
		firstCheckbox.focus();

		toggle(firstCheckbox, true);
		expect(firstCheckbox.checked).toBe(true);
		updateResult.error(new Error('Toggle unavailable'));

		expect(row(0)).toBe(firstRow);
		expect(checkbox(firstRow)).toBe(firstCheckbox);
		expect(firstCheckbox.checked).toBe(false);
		expect(document.activeElement).toBe(firstCheckbox);
		expect(error.textContent).toBe('Toggle unavailable');
		expect(firstRow.classList.contains('completed')).toBe(false);
		expect(row(1)).toBe(sibling);
		expect(siblingMutations.takeRecords()).toEqual([]);
		toggle(firstCheckbox, true);
		expect(firstCheckbox.checked).toBe(true);
		expect(firstRow.classList.contains('completed')).toBe(true);
		expect(error.textContent).toBe('');
		expect(api.update$).toHaveBeenCalledTimes(2);
	});

	it('keeps accepted row work alive across keyed reordering and settles into the same control', () => {
		const api = service();
		const updateResult = new Subject<Todo>();
		api.update$.mockReturnValue(updateResult);
		const { app } = mount(api);
		const firstRow = row(0);
		const secondRow = row(1);
		const firstCheckbox = checkbox(firstRow);
		toggle(firstCheckbox, true);
		firstCheckbox.focus();
		api.getAll$.mockReturnValueOnce(of([second, first]));

		app.refresh();

		expect(updateResult.observed).toBe(true);
		expect(row(0)).toBe(secondRow);
		expect(row(1)).toBe(firstRow);
		expect(firstCheckbox.checked).toBe(true);
		expect(document.activeElement).toBe(firstCheckbox);
		updateResult.next({ ...first, completed: true });
		expect(updateResult.observed).toBe(false);
		expect(row(1)).toBe(firstRow);
		expect(checkbox(firstRow)).toBe(firstCheckbox);
		expect(firstCheckbox.checked).toBe(true);
		expect(firstRow.classList.contains('completed')).toBe(true);
		expect(api.update$).toHaveBeenCalledOnce();
	});

	it('releases rows, bindings and sources on disposal and ignores later data and detached events', () => {
		const { app, api } = mount();
		const firstRow = row(0);
		const firstCheckbox = checkbox(firstRow);
		const firstButton = removeButton(firstRow);
		const detachCheckbox = vi.spyOn(firstCheckbox, 'removeEventListener');
		const detachButton = vi.spyOn(firstButton, 'removeEventListener');
		const refreshResult = new Subject<Todo[]>();
		api.getAll$.mockReturnValueOnce(refreshResult);
		app.refresh();
		expect(refreshResult.observed).toBe(true);

		app.dispose();
		app.dispose();

		expect(refreshResult.observed).toBe(false);
		expect(list.querySelectorAll('li')).toHaveLength(0);
		expect(detachCheckbox.mock.calls.filter(([type]) => type === 'change')).toHaveLength(1);
		expect(detachButton.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1);
		const mutations = observe(document.body);
		refreshResult.next([{ ...first, title: 'Too late' }]);
		firstButton.click();
		toggle(firstCheckbox, true);
		const submitEvent = new Event('submit', { cancelable: true });
		form.dispatchEvent(submitEvent);
		document.querySelector<HTMLButtonElement>('#refresh-todos')!.click();
		app.refresh();
		expect(submitEvent.defaultPrevented).toBe(false);
		expect(mutations.takeRecords()).toEqual([]);
		expect(api.getAll$).toHaveBeenCalledTimes(2);
		expect(api.create$).not.toHaveBeenCalled();
		expect(api.update$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
	});

	it('reports duplicate keys as a render fault and disposes the existing rows and active graph', () => {
		const api = service();
		const reportError = vi.fn();
		const { app } = mount(api, { reportError });
		const firstRow = row(0);
		const firstCheckbox = checkbox(firstRow);
		const firstButton = removeButton(firstRow);
		const refreshResult = new Subject<Todo[]>();
		const complete = vi.fn();
		app.state$.subscribe({ complete });
		api.getAll$.mockReturnValueOnce(refreshResult);
		app.refresh();

		refreshResult.next([first, { ...first, title: 'Conflicting duplicate' }]);

		expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
		expect(complete).toHaveBeenCalledOnce();
		expect(refreshResult.observed).toBe(false);
		expect(firstRow.isConnected).toBe(false);
		expect(list.querySelectorAll('li')).toHaveLength(0);
		firstButton.click();
		toggle(firstCheckbox, true);
		expect(api.update$).not.toHaveBeenCalled();
		expect(api.remove$).not.toHaveBeenCalled();
		const submitEvent = new Event('submit', { cancelable: true });
		form.dispatchEvent(submitEvent);
		expect(submitEvent.defaultPrevented).toBe(false);
	});
});
