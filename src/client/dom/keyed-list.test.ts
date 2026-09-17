import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable, of, Subject } from 'rxjs';
import { createScope, type Scope } from '../runtime/scope';
import { bindKeyedList, type KeyedRow } from './keyed-list';

interface Item {
	readonly id: string;
	readonly label: string;
}

const a: Item = { id: 'a', label: 'Alpha' };
const b: Item = { id: 'b', label: 'Beta' };
const c: Item = { id: 'c', label: 'Gamma' };
const owners: Scope[] = [];

function fixture() {
	const owner = createScope();
	owners.push(owner);
	const container = document.createElement('ul');
	document.body.append(container);
	const values = new Subject<readonly Item[]>();
	const updates = new Map<string, ReturnType<typeof vi.fn>>();
	const disposals = new Map<string, ReturnType<typeof vi.fn>>();
	const rows = new Map<string, HTMLElement>();
	const errors = vi.fn();
	const create = vi.fn((item: Item, child: Scope): KeyedRow<Item> => {
		const element = document.createElement('li');
		element.dataset.key = item.id;
		const update = vi.fn((value: Item) => {
			if (element.textContent !== value.label) element.textContent = value.label;
		});
		const dispose = vi.fn();
		child.add(dispose);
		updates.set(item.id, update);
		disposals.set(item.id, dispose);
		rows.set(item.id, element);
		return { element, update };
	});
	function bind(source: Observable<readonly Item[]> = values) {
		return bindKeyedList(owner, container, source, item => item.id, create, errors);
	}
	return { owner, container, values, updates, disposals, rows, errors, create, bind };
}

afterEach(() => {
	while (owners.length) owners.pop()!.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe('bindKeyedList', () => {
	it('owns one scope per key and updates initial values before insertion', () => {
		const f = fixture();
		f.bind();
		f.values.next([a, b]);
		expect(f.container.textContent).toBe('AlphaBeta');
		expect(f.create).toHaveBeenCalledTimes(2);
		expect(f.updates.get('a')).toHaveBeenCalledExactlyOnceWith(a);
		expect(f.updates.get('b')).toHaveBeenCalledExactlyOnceWith(b);
		expect(f.disposals.get('a')).not.toHaveBeenCalled();
	});

	it('retains every keyed element across immutable updates and reordering', () => {
		const f = fixture();
		f.bind();
		f.values.next([a, b, c]);
		const original = [...f.container.children];
		f.values.next([c, { ...b, label: 'Updated' }, a]);
		expect([...f.container.children]).toEqual([original[2], original[1], original[0]]);
		expect(f.container.textContent).toBe('GammaUpdatedAlpha');
		expect(f.create).toHaveBeenCalledTimes(3);
		expect(f.disposals.get('b')).not.toHaveBeenCalled();
	});

	it('updates retained keys on each emission but performs no structural writes for unchanged order', () => {
		const f = fixture();
		f.bind();
		const same = [a, b];
		f.values.next(same);
		const insert = vi.spyOn(f.container, 'insertBefore');
		const clear = vi.spyOn(f.container, 'replaceChildren');
		const remove = vi.spyOn(f.rows.get('a')!, 'remove');
		const text = vi.spyOn(f.rows.get('a')!, 'textContent', 'set');
		f.values.next(same);
		f.values.next([{ ...a }, { ...b }]);
		expect(f.updates.get('a')).toHaveBeenCalledTimes(3);
		expect(insert).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
	});

	it('removes a deleted key and disposes only its child, exactly once', () => {
		const f = fixture();
		const lifetime = f.bind();
		f.values.next([a, b]);
		const removed = f.rows.get('a')!;
		f.values.next([b]);
		expect(removed.isConnected).toBe(false);
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
		expect(f.disposals.get('b')).not.toHaveBeenCalled();
		lifetime.unsubscribe();
		f.owner.dispose();
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
		expect(f.disposals.get('b')).toHaveBeenCalledTimes(1);
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('recreates a later reinserted key with a new child and element', () => {
		const f = fixture();
		f.bind();
		f.values.next([a]);
		const first = f.rows.get('a');
		const firstDispose = f.disposals.get('a');
		f.values.next([]);
		f.values.next([a]);
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(f.rows.get('a')).not.toBe(first);
		expect(f.create).toHaveBeenCalledTimes(2);
	});

	it('releases its source and rows on explicit unsubscribe, leaving its parent usable', () => {
		const f = fixture();
		const lifetime = f.bind();
		f.values.next([a]);
		lifetime.unsubscribe();
		f.values.next([b]);
		expect(f.owner.closed).toBe(false);
		expect(f.values.observed).toBe(false);
		expect(f.container.childNodes).toHaveLength(0);
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
	});

	it('retains completed-source rows until the returned lifetime is disposed', () => {
		const f = fixture();
		const lifetime = f.bind(of([a, b]));
		expect(lifetime.closed).toBe(false);
		expect(f.container.children).toHaveLength(2);
		lifetime.unsubscribe();
		expect(f.container.childNodes).toHaveLength(0);
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
	});

	it('clears stale shell children on the first empty collection only', () => {
		const f = fixture();
		f.container.innerHTML = '<li>Server shell</li>';
		const replace = vi.spyOn(f.container, 'replaceChildren');
		f.bind();
		f.values.next([]);
		f.values.next([]);
		expect(f.container.childNodes).toHaveLength(0);
		expect(replace).toHaveBeenCalledTimes(1);
	});

	it('does not activate or write when its parent is already closed', () => {
		const f = fixture();
		f.container.textContent = 'Untouched';
		f.owner.dispose();
		const activate = vi.fn();
		const lifetime = f.bind(new Observable(subscriber => {
			activate();
			subscriber.next([a]);
		}));
		expect(lifetime.closed).toBe(true);
		expect(activate).not.toHaveBeenCalled();
		expect(f.container.textContent).toBe('Untouched');
	});

	it('rejects duplicate keys before updating or creating any row, then cleans the failed list', () => {
		const f = fixture();
		const lifetime = f.bind();
		f.values.next([a, b]);
		f.updates.get('a')!.mockClear();
		f.updates.get('b')!.mockClear();
		f.values.next([{ ...a, label: 'Wrong' }, c, a]);
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Duplicate keyed-list key' }));
		expect(f.updates.get('a')).not.toHaveBeenCalled();
		expect(f.updates.get('b')).not.toHaveBeenCalled();
		expect(f.create).toHaveBeenCalledTimes(2);
		expect(f.container.childNodes).toHaveLength(0);
		expect(lifetime.closed).toBe(true);
		expect(f.values.observed).toBe(false);
	});

	it('cleans rows and reports source failures after cleanup', () => {
		const f = fixture();
		const failure = new Error('Source failed');
		f.errors.mockImplementation(() => {
			expect(f.container.childNodes).toHaveLength(0);
			expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
		});
		const lifetime = f.bind();
		f.values.next([a]);
		f.values.error(failure);
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(failure);
		expect(lifetime.closed).toBe(true);
	});

	it('owns a partially constructed row when its factory throws', () => {
		const f = fixture();
		const partialDispose = vi.fn();
		const failure = new Error('Construction failed');
		f.create.mockImplementationOnce((_item, child) => {
			child.add(partialDispose);
			throw failure;
		});
		const lifetime = f.bind(of([a]));
		expect(partialDispose).toHaveBeenCalledTimes(1);
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(failure);
		expect(lifetime.closed).toBe(true);
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('cleans every row when an update throws', () => {
		const f = fixture();
		const lifetime = f.bind();
		f.values.next([a, b]);
		const failure = new Error('Update failed');
		f.updates.get('a')!.mockImplementation(() => { throw failure; });
		f.values.next([a, b]);
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(failure);
		expect(lifetime.closed).toBe(true);
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
		expect(f.disposals.get('b')).toHaveBeenCalledTimes(1);
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('cleans a new child when DOM insertion throws', () => {
		const f = fixture();
		const failure = new Error('Insertion failed');
		vi.spyOn(f.container, 'insertBefore').mockImplementation(() => { throw failure; });
		const lifetime = f.bind(of([a]));
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(failure);
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
		expect(lifetime.closed).toBe(true);
	});

	it('rejects sharing one element between distinct key owners', () => {
		const f = fixture();
		const element = document.createElement('li');
		f.create.mockImplementation(() => ({ element, update: vi.fn() }));
		const lifetime = f.bind(of([a, b]));
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			message: 'Each keyed-list row must own a distinct element',
		}));
		expect(lifetime.closed).toBe(true);
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('prevents late insertion and stops a synchronous source when construction disposes its owner', () => {
		const f = fixture();
		const partialDispose = vi.fn();
		let sourceClosed = false;
		const sourceTeardown = vi.fn();
		f.create.mockImplementationOnce((_item, child) => {
			child.add(partialDispose);
			f.owner.dispose();
			return { element: document.createElement('li'), update: vi.fn() };
		});
		const lifetime = f.bind(new Observable(subscriber => {
			subscriber.next([a, b]);
			sourceClosed = subscriber.closed;
			if (!subscriber.closed) subscriber.next([c]);
			return sourceTeardown;
		}));
		expect(lifetime.closed).toBe(true);
		expect(sourceClosed).toBe(true);
		expect(sourceTeardown).toHaveBeenCalledTimes(1);
		expect(partialDispose).toHaveBeenCalledTimes(1);
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('prevents more row work when an update disposes the owner', () => {
		const f = fixture();
		const lifetime = f.bind();
		f.values.next([a, b]);
		f.updates.get('a')!.mockImplementation(() => f.owner.dispose());
		f.updates.get('b')!.mockClear();
		f.values.next([a, b, c]);
		expect(lifetime.closed).toBe(true);
		expect(f.updates.get('b')).not.toHaveBeenCalled();
		expect(f.create).toHaveBeenCalledTimes(2);
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('rejects a factory that independently disposes its supplied child before returning', () => {
		const f = fixture();
		const update = vi.fn();
		f.create.mockImplementation((_item, child) => {
			child.dispose();
			return { element: document.createElement('li'), update };
		});
		const lifetime = f.bind(of([a]));
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			message: 'Keyed-list row scope was disposed outside list reconciliation',
		}));
		expect(update).not.toHaveBeenCalled();
		expect(lifetime.closed).toBe(true);
		expect(f.container.childNodes).toHaveLength(0);
		lifetime.unsubscribe();
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('rejects an update that independently disposes its supplied child without reinserting a dead row', () => {
		const f = fixture();
		f.create.mockImplementation((_item, child) => ({
			element: document.createElement('li'),
			update() { child.dispose(); },
		}));
		const lifetime = f.bind(of([a]));
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			message: 'Keyed-list row scope was disposed outside list reconciliation',
		}));
		expect(lifetime.closed).toBe(true);
		expect(f.container.childNodes).toHaveLength(0);
		lifetime.unsubscribe();
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('never reuses a retained row whose supplied child was independently disposed between values', () => {
		const f = fixture();
		let rowScope: Scope | undefined;
		const update = vi.fn();
		f.create.mockImplementation((_item, child) => {
			rowScope = child;
			return { element: document.createElement('li'), update };
		});
		const lifetime = f.bind();
		f.values.next([a]);
		expect(f.container.children).toHaveLength(1);
		rowScope!.dispose();
		expect(f.container.childNodes).toHaveLength(0);
		f.values.next([a]);
		expect(f.errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			message: 'Keyed-list row scope was disposed outside list reconciliation',
		}));
		expect(update).toHaveBeenCalledTimes(1);
		expect(lifetime.closed).toBe(true);
		expect(f.values.observed).toBe(false);
		expect(f.container.childNodes).toHaveLength(0);
		lifetime.unsubscribe();
		expect(f.container.childNodes).toHaveLength(0);
	});

	it('removes a late insertion if a host DOM hook disposes the owner before inserting', () => {
		const f = fixture();
		const insert = f.container.insertBefore.bind(f.container);
		vi.spyOn(f.container, 'insertBefore').mockImplementation((node, before) => {
			f.owner.dispose();
			return insert(node, before);
		});
		const lifetime = f.bind(of([a, b]));
		expect(lifetime.closed).toBe(true);
		expect(f.container.childNodes).toHaveLength(0);
		expect(f.disposals.get('a')).toHaveBeenCalledTimes(1);
		expect(f.disposals.get('b')).toHaveBeenCalledTimes(1);
	});

	it('serializes reentrant collection emissions after the current synchronous commit', () => {
		const f = fixture();
		f.bind();
		f.values.next([a]);
		let queued = false;
		f.updates.get('a')!.mockImplementation(() => {
			if (!queued) {
				queued = true;
				f.values.next([b, a]);
			}
		});
		f.values.next([a, c]);
		expect([...f.container.children].map(element => (element as HTMLElement).dataset.key)).toEqual(['b', 'a']);
		expect(f.create).toHaveBeenCalledTimes(3);
		expect(f.disposals.get('c')).toHaveBeenCalledTimes(1);
		expect(f.errors).not.toHaveBeenCalled();
	});

	it('preserves focused input, unsent value and selection when the fallback moves its row', () => {
		const f = fixture();
		const inputs = new Map<string, HTMLInputElement>();
		f.create.mockImplementation(item => {
			const element = document.createElement('li');
			const input = document.createElement('input');
			input.value = item.label;
			element.append(input);
			inputs.set(item.id, input);
			return { element, update: vi.fn() };
		});
		Object.defineProperty(f.container, 'moveBefore', { value: undefined, configurable: true });
		f.bind();
		f.values.next([a, b]);
		const input = inputs.get('b')!;
		input.value = 'Unsent edit';
		input.focus();
		input.setSelectionRange(1, 7, 'backward');
		f.values.next([b, a]);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe('Unsent edit');
		expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([1, 7, 'backward']);
	});

	it('does not steal focus deliberately moved outside the list during a fallback move', () => {
		const f = fixture();
		const foreign = document.createElement('input');
		document.body.append(foreign);
		f.create.mockImplementation(() => {
			const element = document.createElement('li');
			element.append(document.createElement('input'));
			return { element, update: vi.fn() };
		});
		Object.defineProperty(f.container, 'moveBefore', { value: undefined, configurable: true });
		f.bind();
		f.values.next([a, b]);
		(f.container.children[1]!.firstElementChild as HTMLInputElement).focus();
		const insert = f.container.insertBefore.bind(f.container);
		vi.spyOn(f.container, 'insertBefore').mockImplementation((node, before) => {
			const result = insert(node, before);
			foreign.focus();
			return result;
		});
		f.values.next([b, a]);
		expect(document.activeElement).toBe(foreign);
	});

	it('preserves focused controls and selection when the list lives in a ShadowRoot', () => {
		const f = fixture();
		const host = document.createElement('section');
		const shadow = host.attachShadow({ mode: 'open' });
		document.body.append(host);
		shadow.append(f.container);
		f.create.mockImplementation(item => {
			const element = document.createElement('li');
			const input = document.createElement('textarea');
			input.value = item.label;
			element.append(input);
			return { element, update: vi.fn() };
		});
		Object.defineProperty(f.container, 'moveBefore', { value: undefined, configurable: true });
		f.bind();
		f.values.next([a, b]);
		const input = f.container.children[1]!.firstElementChild as HTMLTextAreaElement;
		input.value = 'Unsent shadow draft';
		input.focus();
		input.setSelectionRange(2, 6, 'backward');
		f.values.next([b, a]);
		expect(document.activeElement).toBe(host);
		expect(shadow.activeElement).toBe(input);
		expect(input.value).toBe('Unsent shadow draft');
		expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 6, 'backward']);
	});

	it('uses native moveBefore for a connected retained row when available', () => {
		const f = fixture();
		f.bind();
		f.values.next([a, b]);
		const move = vi.fn((node: Node, before: Node | null) => f.container.insertBefore(node, before));
		Object.defineProperty(f.container, 'moveBefore', { value: move, configurable: true });
		f.values.next([b, a]);
		expect(move).toHaveBeenCalledExactlyOnceWith(f.rows.get('b'), f.rows.get('a'));
		expect([...f.container.children]).toEqual([f.rows.get('b'), f.rows.get('a')]);
	});
});
