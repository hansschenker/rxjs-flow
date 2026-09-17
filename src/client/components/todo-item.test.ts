import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TodoItem } from './todo-item';
import type { Todo } from '../../shared/types';
import { createScope, type Scope } from '../runtime/scope';

const baseTodo: Todo = {
	id: '1',
	title: 'Buy milk',
	completed: false,
	createdAt: '2026-01-01T00:00:00.000Z',
};

describe('TodoItem', () => {
	let root: Scope;
	beforeEach(() => { root = createScope(); });
	afterEach(() => { root.dispose(); });

	const createItem = (props: Partial<Parameters<typeof TodoItem>[0]> = {}) => TodoItem({
		todo: baseTodo,
		onIntent: () => {},
		scope: root.child(),
		...props,
	});

	it('renders an li element', () => {
		const el = createItem();
		expect(el.tagName).toBe('LI');
	});

	it('has no className when todo is not completed', () => {
		const el = createItem({ todo: { ...baseTodo, completed: false } });
		expect(el.className).toBe('');
	});

	it('has className "completed" when todo is completed', () => {
		const el = createItem({ todo: { ...baseTodo, completed: true } });
		expect(el.className).toBe('completed');
	});

	it('renders a checkbox that is unchecked when todo is not completed', () => {
		const el = createItem({ todo: { ...baseTodo, completed: false } });
		const input = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(input).not.toBeNull();
		expect(input.checked).toBe(false);
	});

	it('renders a checkbox that is checked when todo is completed', () => {
		const el = createItem({ todo: { ...baseTodo, completed: true } });
		const input = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(input.checked).toBe(true);
	});

	it('shows the todo title in a span', () => {
		const el = createItem();
		const span = el.querySelector('span');
		expect(span?.textContent).toBe('Buy milk');
	});

	it('captures the checkbox value synchronously as a typed intent', () => {
		const onIntent = vi.fn();
		const el = createItem({ onIntent });
		const input = el.querySelector('input') as HTMLInputElement;
		input.checked = true;
		input.dispatchEvent(new Event('change'));
		input.checked = false;
		expect(onIntent).toHaveBeenCalledTimes(1);
		expect(onIntent).toHaveBeenCalledWith({ type: 'TOGGLE_REQUESTED', id: baseTodo.id, completed: true });
	});

	it('calls onIntent when the Delete button is clicked', () => {
		const onIntent = vi.fn();
		const el = createItem({ onIntent });
		const button = el.querySelector('button') as HTMLButtonElement;
		button.dispatchEvent(new Event('click'));
		expect(onIntent).toHaveBeenCalledTimes(1);
		expect(onIntent).toHaveBeenCalledWith({ type: 'DELETE_REQUESTED', id: baseTodo.id });
	});

	it('removes both listeners and ignores events from a disposed detached row', () => {
		const scope = root.child();
		const onIntent = vi.fn();
		const el = createItem({ scope, onIntent });
		document.body.appendChild(el);
		const input = el.querySelector('input')!;
		const button = el.querySelector('button')!;
		const removeChange = vi.spyOn(input, 'removeEventListener');
		const removeClick = vi.spyOn(button, 'removeEventListener');
		el.remove();

		scope.dispose();
		scope.dispose();
		input.dispatchEvent(new Event('change'));
		button.dispatchEvent(new Event('click'));

		expect(removeChange).toHaveBeenCalledTimes(1);
		expect(removeClick).toHaveBeenCalledTimes(1);
		expect(onIntent).not.toHaveBeenCalled();
	});

	it('removes one owned row without stopping its sibling', () => {
		const firstScope = root.child();
		const firstToggle = vi.fn();
		const secondToggle = vi.fn();
		const first = createItem({ scope: firstScope, onIntent: firstToggle });
		const second = createItem({ todo: { ...baseTodo, id: '2' }, onIntent: secondToggle });
		document.body.append(first, second);

		firstScope.dispose();
		const firstInput = first.querySelector('input')!;
		const secondInput = second.querySelector('input')!;
		firstInput.dispatchEvent(new Event('change'));
		secondInput.checked = true;
		secondInput.dispatchEvent(new Event('change'));

		expect(first.isConnected).toBe(false);
		expect(second.isConnected).toBe(true);
		expect(firstToggle).not.toHaveBeenCalled();
		expect(secondToggle).toHaveBeenCalledExactlyOnceWith({ type: 'TOGGLE_REQUESTED', id: '2', completed: true });
	});

	it('does not attach listeners to an already disposed scope', () => {
		const scope = root.child();
		scope.dispose();
		const addListener = vi.spyOn(HTMLElement.prototype, 'addEventListener');
		try {
			createItem({ scope });
			expect(addListener).not.toHaveBeenCalled();
		} finally {
			addListener.mockRestore();
		}
	});
});
