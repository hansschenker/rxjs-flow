import { Observable, Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { createScope } from '../runtime/scope';
import { bindKeyedList } from './keyed-list';

describe('keyed-list diagnostic commit boundary', () => {
	it('observes inserted rows after their updates and isolates observer failure', () => {
		const owner = createScope();
		const container = document.createElement('ul');
		const values = new Subject<readonly string[]>();
		const seen: string[] = [];
		let subscriptions = 0;
		const source = new Observable<readonly string[]>(subscriber => {
			subscriptions++;
			return values.subscribe(subscriber);
		});
		const errors = vi.fn();
		bindKeyedList(owner, container, source, value => value, () => {
			const element = document.createElement('li');
			return { element, update(value) { element.textContent = value; } };
		}, errors, () => {
			seen.push(container.textContent!);
			throw new Error('diagnostic observer failure');
		});
		values.next(['first']);
		values.next(['second']);
		expect(seen).toEqual(['first', 'second']);
		expect(subscriptions).toBe(1);
		expect(errors).not.toHaveBeenCalled();
		owner.dispose();
		expect(values.observed).toBe(false);
		expect(container.childElementCount).toBe(0);
	});

	it('does not report a duplicate-key reconciliation failure as a commit', () => {
		const owner = createScope();
		const container = document.createElement('ul');
		const committed = vi.fn();
		const errors = vi.fn();
		bindKeyedList(owner, container, of(['same', 'same']), value => value,
			() => ({ element: document.createElement('li'), update() {} }), errors, committed);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(committed).not.toHaveBeenCalled();
		owner.dispose();
	});

	it('does not report a reconciliation interrupted by synchronous disposal as a commit', () => {
		const owner = createScope();
		const container = document.createElement('ul');
		const committed = vi.fn();
		bindKeyedList(owner, container, of(['one']), value => value,
			() => ({ element: document.createElement('li'), update() { owner.dispose(); } }), undefined, committed);
		expect(committed).not.toHaveBeenCalled();
		expect(container.childElementCount).toBe(0);
	});
});
