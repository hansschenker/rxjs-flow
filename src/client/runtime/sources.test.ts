import { debounceTime } from 'rxjs';
import { afterEach, vi } from 'vitest';
import { createScope } from './scope';
import { domEvent$ } from './sources';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('domEvent$()', () => {
	it('attaches lazily without replaying events from the independent browser producer', () => {
		const button = document.createElement('button');
		const attach = vi.spyOn(button, 'addEventListener');
		const capture = vi.fn(() => 'clicked');
		const source = domEvent$(button, 'click', capture);
		button.click();
		expect(attach).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		const receive = vi.fn();
		const subscription = source.subscribe(receive);
		expect(attach).toHaveBeenCalledOnce();
		expect(receive).not.toHaveBeenCalled();
		button.click();
		expect(receive).toHaveBeenCalledExactlyOnceWith('clicked');
		subscription.unsubscribe();
	});

	it('owns one listener per subscription and removes that exact listener', () => {
		const button = document.createElement('button');
		const attach = vi.spyOn(button, 'addEventListener');
		const detach = vi.spyOn(button, 'removeEventListener');
		const source = domEvent$(button, 'click', () => 'clicked');
		const firstReceive = vi.fn();
		const secondReceive = vi.fn();
		const first = source.subscribe(firstReceive);
		const second = source.subscribe(secondReceive);
		first.unsubscribe();
		button.click();
		expect(firstReceive).not.toHaveBeenCalled();
		expect(secondReceive).toHaveBeenCalledOnce();
		expect(detach).toHaveBeenNthCalledWith(1, 'click', attach.mock.calls[0]![1]);
		second.unsubscribe();
		expect(detach).toHaveBeenNthCalledWith(2, 'click', attach.mock.calls[1]![1]);
		button.click();
		expect(secondReceive).toHaveBeenCalledOnce();
	});

	it('captures data and cancels default behavior before an asynchronous policy', () => {
		vi.useFakeTimers();
		const form = document.createElement('form');
		const input = document.createElement('input');
		form.appendChild(input);
		input.value = 'original';
		const scope = createScope();
		const receive = vi.fn();
		scope.subscribe(domEvent$(form, 'submit', event => {
			event.preventDefault();
			return input.value;
		}).pipe(debounceTime(10)), { next: receive });
		const event = new Event('submit', { cancelable: true });
		expect(form.dispatchEvent(event)).toBe(false);
		expect(event.defaultPrevented).toBe(true);
		expect(receive).not.toHaveBeenCalled();
		input.value = 'changed after dispatch';
		vi.advanceTimersByTime(10);
		expect(receive).toHaveBeenCalledExactlyOnceWith('original');
		scope.dispose();
	});

	it('removes listeners and cancels pending policy work with its owner', () => {
		vi.useFakeTimers();
		const button = document.createElement('button');
		const capture = vi.fn(() => 'clicked');
		const receive = vi.fn();
		const scope = createScope();
		scope.subscribe(domEvent$(button, 'click', capture).pipe(debounceTime(10)), { next: receive });
		button.click();
		scope.dispose();
		button.click();
		vi.advanceTimersByTime(10);
		expect(capture).toHaveBeenCalledOnce();
		expect(receive).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('exposes the event type required by a typed capture function', () => {
		const input = document.createElement('input');
		const receive = vi.fn();
		const subscription = domEvent$(input, 'keydown', event => event.key).subscribe(receive);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		expect(receive).toHaveBeenCalledExactlyOnceWith('Enter');
		subscription.unsubscribe();
	});

	it('reports capture failures through the stream and releases its listener', () => {
		const button = document.createElement('button');
		const detach = vi.spyOn(button, 'removeEventListener');
		const failure = new Error('capture failed');
		const capture = vi.fn(() => { throw failure; });
		const onError = vi.fn();
		const subscription = domEvent$(button, 'click', capture).subscribe({ error: onError });
		button.click();
		button.click();
		expect(subscription.closed).toBe(true);
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(capture).toHaveBeenCalledOnce();
		expect(detach).toHaveBeenCalledOnce();
	});
});
