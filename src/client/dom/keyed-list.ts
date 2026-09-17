import { concatMap, defer, EMPTY, type Observable, Subscription } from 'rxjs';
import { createScope, type Scope } from '../runtime/scope';

export interface KeyedRow<T> {
	readonly element: HTMLElement;
	update(value: T): void;
}

interface OwnedRow<T> extends KeyedRow<T> {
	readonly scope: Scope;
}

interface SelectionSnapshot {
	readonly element: HTMLInputElement | HTMLTextAreaElement;
	readonly start: number;
	readonly end: number;
	readonly direction: 'forward' | 'backward' | 'none' | null;
}

function selectionOf(element: Element): SelectionSnapshot | null {
	if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
	const start = element.selectionStart;
	const end = element.selectionEnd;
	return start === null || end === null
		? null
		: { element, start, end, direction: element.selectionDirection };
}

/** Moving a connected row should not blur its focused control. */
function placeRow(container: HTMLElement, element: HTMLElement, before: ChildNode | null): void {
	if (typeof container.moveBefore === 'function' && element.parentNode === container && element.isConnected) {
		container.moveBefore(element, before);
		return;
	}

	const document = container.ownerDocument;
	const root = element.getRootNode();
	const focusRoot = root instanceof ShadowRoot ? root : document;
	const documentFocus = document.activeElement;
	const active = focusRoot.activeElement;
	const focused = active instanceof HTMLElement && element.contains(active) ? active : null;
	const selection = focused ? selectionOf(focused) : null;
	container.insertBefore(element, before);
	// A blur handler can deliberately focus another control. Do not steal that focus.
	if (focused && focused.isConnected && focusRoot.activeElement !== focused
		&& (focusRoot.activeElement === document.body || focusRoot.activeElement === null)
		&& (document.activeElement === document.body || document.activeElement === null || document.activeElement === documentFocus)) {
		focused.focus({ preventScroll: true });
		if (selection && focusRoot.activeElement === focused) {
			const { element: input, start, end, direction } = selection;
			if (input.selectionStart !== start || input.selectionEnd !== end || input.selectionDirection !== direction) {
				input.setSelectionRange(start, end, direction ?? undefined);
			}
		}
	}
}

function reportBindingError(error: unknown): void {
	console.error(error);
}

function requireOpenRow(scope: Scope, element: HTMLElement): void {
	if (scope.closed) {
		// A caller may have resumed its update/insertion after child teardown.
		element.remove();
		throw new Error('Keyed-list row scope was disposed outside list reconciliation');
	}
}

/**
 * Own the container's children and one child scope per key. Values render
 * synchronously; reentrant emissions queue until the current commit finishes.
 * update receives the initial value and every subsequent value for its key.
 * Source completion retains rows. Explicit unsubscribe or scope disposal removes
 * all owned rows and their bindings; source/render errors also release the list.
 * A row must keep its supplied child scope open. Independently closing that scope
 * is a render failure on its next update; disposed rows are never reinserted.
 */
export function bindKeyedList<T, K>(
	scope: Scope,
	container: HTMLElement,
	items$: Observable<readonly T[]>,
	keyOf: (value: T) => K,
	create: (value: T, child: Scope) => KeyedRow<T>,
	onError: (error: unknown) => void = reportBindingError,
): Subscription {
	const lifetime = new Subscription();
	scope.add(lifetime);
	const owner = createScope();
	lifetime.add(() => owner.dispose());
	const rows = new Map<K, OwnedRow<T>>();
	owner.add(() => rows.clear());
	let initialized = false;

	function reconcile(items: readonly T[]): void {
		const values = new Map<K, T>();
		for (const item of items) {
			const key = keyOf(item);
			if (values.has(key)) throw new Error('Duplicate keyed-list key');
			values.set(key, item);
		}
		if (owner.closed) return;
		// This binding exclusively owns the container. Clear a pre-existing shell
		// only after validating the complete first collection.
		if (!initialized) {
			initialized = true;
			if (container.firstChild) container.replaceChildren();
		}
		if (owner.closed) return;
		for (const [key, row] of rows) {
			if (!values.has(key)) {
				rows.delete(key);
				row.scope.dispose();
				if (owner.closed) return;
			}
		}
		for (const [key, item] of values) {
			let row = rows.get(key);
			if (!row) {
				const child = owner.child();
				const created = create(item, child);
				child.add(() => created.element.remove());
				if (owner.closed) return;
				requireOpenRow(child, created.element);
				if ([...rows.values()].some(existing => existing.element === created.element)) {
					throw new Error('Each keyed-list row must own a distinct element');
				}
				row = { element: created.element, update: created.update, scope: child };
				rows.set(key, row);
			}
			requireOpenRow(row.scope, row.element);
			row.update(item);
			if (owner.closed) return;
			requireOpenRow(row.scope, row.element);
		}
		let before = container.firstChild;
		for (const key of values.keys()) {
			const row = rows.get(key)!;
			requireOpenRow(row.scope, row.element);
			const element = row.element;
			if (element !== before) placeRow(container, element, before);
			if (owner.closed) {
				// Host DOM hooks can dispose the owner during insertion itself.
				// A hook that resumes insertion after teardown must not leave a row.
				if (element.parentNode === container) element.remove();
				return;
			}
			requireOpenRow(row.scope, element);
			before = element.nextSibling;
		}
	}

	function commit(items: readonly T[]): Observable<never> {
		return defer(() => {
			reconcile(items);
			return EMPTY;
		});
	}

	function fail(error: unknown): void {
		try {
			lifetime.unsubscribe();
		} finally {
			onError(error);
		}
	}

	owner.subscribe(items$.pipe(concatMap(commit)), { error: fail });
	return lifetime;
}
