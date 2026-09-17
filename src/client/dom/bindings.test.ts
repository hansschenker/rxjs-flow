import { Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScope, type Scope } from '../runtime/scope';
import { bindAttribute, bindClass, bindIf, bindProperty, bindText } from './bindings';

const owners: Scope[] = [];

function owner(): Scope {
	const scope = createScope();
	owners.push(scope);
	return scope;
}

afterEach(() => {
	for (const scope of owners.splice(0)) scope.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe('scalar DOM bindings', () => {
	it('commits text synchronously and preserves existing children when unchanged', () => {
		const target = document.createElement('span');
		const text = document.createTextNode('ready');
		target.appendChild(text);
		const values$ = new Subject<string>();
		const binding = bindText(owner(), target, values$);
		values$.next('ready');
		expect(target.firstChild).toBe(text);
		values$.next('done');
		expect(target.textContent).toBe('done');
		binding.unsubscribe();
		values$.next('late');
		expect(target.textContent).toBe('done');
		expect(values$.observed).toBe(false);
	});

	it('keeps the final text after normal source completion', () => {
		const target = document.createTextNode('');
		const binding = bindText(owner(), target, of('first', 'last'));
		expect(binding.closed).toBe(true);
		expect(target.textContent).toBe('last');
	});

	it('does not overwrite matching input values or disturb focus and selection', () => {
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.value = 'unsent title';
		input.focus();
		input.setSelectionRange(2, 7, 'backward');
		const setter = vi.spyOn(input, 'value', 'set');
		bindProperty(owner(), input, 'value', of('unsent title', 'unsent title'));
		expect(setter).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(input);
		expect([input.selectionStart, input.selectionEnd, input.selectionDirection])
			.toEqual([2, 7, 'backward']);
	});

	it('compares each emission with native property changes instead of the prior emission', () => {
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		const values$ = new Subject<boolean>();
		bindProperty(owner(), checkbox, 'checked', values$);
		values$.next(false);
		checkbox.checked = true;
		values$.next(false);
		expect(checkbox.checked).toBe(false);
	});

	it('writes an attribute only when needed and removes it for null', () => {
		const target = document.createElement('div');
		const set = vi.spyOn(target, 'setAttribute');
		const remove = vi.spyOn(target, 'removeAttribute');
		bindAttribute(owner(), target, 'aria-busy', of(null, 'true', 'true', null, null));
		expect(set).toHaveBeenCalledExactlyOnceWith('aria-busy', 'true');
		expect(remove).toHaveBeenCalledExactlyOnceWith('aria-busy');
		expect(target.hasAttribute('aria-busy')).toBe(false);
	});

	it('toggles one class without touching other classes or repeating writes', () => {
		const target = document.createElement('div');
		target.className = 'row';
		const toggle = vi.spyOn(target.classList, 'toggle');
		bindClass(owner(), target, 'completed', of(false, true, true, false, false));
		expect(toggle.mock.calls).toEqual([['completed', true], ['completed', false]]);
		expect(target.className).toBe('row');
	});

	it('repairs independently changed attributes and classes on the next matching value', () => {
		const target = document.createElement('div');
		const text$ = new Subject<string | null>();
		const flags$ = new Subject<boolean>();
		bindAttribute(owner(), target, 'title', text$);
		bindClass(owner(), target, 'active', flags$);
		text$.next('expected');
		flags$.next(true);
		target.setAttribute('title', 'external');
		target.classList.remove('active');
		text$.next('expected');
		flags$.next(true);
		expect(target.title).toBe('expected');
		expect(target.classList.contains('active')).toBe(true);
	});

	it('releases every scalar source exactly once on owner disposal', () => {
		const scope = owner();
		const target = document.createElement('button');
		const release = vi.fn();
		const text$ = new Observable<string>(() => release);
		const flags$ = new Observable<boolean>(() => release);
		const bindings = [
			bindText(scope, target, text$),
			bindProperty(scope, target, 'disabled', flags$),
			bindAttribute(scope, target, 'title', text$),
			bindClass(scope, target, 'active', flags$),
		];
		scope.dispose();
		scope.dispose();
		expect(bindings.every(binding => binding.closed)).toBe(true);
		expect(release).toHaveBeenCalledTimes(4);
	});

	it('never activates scalar sources for a closed owner', () => {
		const scope = owner();
		scope.dispose();
		const target = document.createElement('button');
		const activate = vi.fn();
		const text$ = new Observable<string>(activate);
		const flags$ = new Observable<boolean>(activate);
		const bindings = [
			bindText(scope, target, text$),
			bindProperty(scope, target, 'disabled', flags$),
			bindAttribute(scope, target, 'title', text$),
			bindClass(scope, target, 'active', flags$),
		];
		expect(bindings.every(binding => binding.closed)).toBe(true);
		expect(activate).not.toHaveBeenCalled();
	});

	it('owns a synchronous source before a property commit can dispose it', () => {
		const scope = owner();
		const commits: string[] = [];
		const release = vi.fn();
		const target = {
			get text(): string { return ''; },
			set text(value: string) { commits.push(value); scope.dispose(); },
		};
		const values$ = new Observable<string>(subscriber => {
			subscriber.next('first');
			expect(subscriber.closed).toBe(true);
			subscriber.next('late');
			return release;
		});
		const binding = bindProperty(scope, target, 'text', values$);
		expect(binding.closed).toBe(true);
		expect(commits).toEqual(['first']);
		expect(release).toHaveBeenCalledOnce();
	});

	it('reports a throwing DOM commit through the error boundary and releases its source', () => {
		const failure = new Error('read-only target');
		const target = {
			get value(): string { return ''; },
			set value(_value: string) { throw failure; },
		};
		const release = vi.fn();
		const onError = vi.fn();
		const values$ = new Observable<string>(subscriber => {
			subscriber.next('write');
			expect(subscriber.closed).toBe(true);
			subscriber.next('late');
			return release;
		});
		const binding = bindProperty(owner(), target, 'value', values$, onError);
		expect(binding.closed).toBe(true);
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(release).toHaveBeenCalledOnce();
	});

	it('reports source errors without erasing the last committed DOM', () => {
		const target = document.createTextNode('');
		const values$ = new Subject<string>();
		const onError = vi.fn();
		const binding = bindText(owner(), target, values$, onError);
		values$.next('keep');
		const failure = new Error('source failed');
		values$.error(failure);
		expect(binding.closed).toBe(true);
		expect(target.textContent).toBe('keep');
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
	});

	it('reports unexpected faults by default when no host reporter is supplied', () => {
		const report = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failure = new Error('broken source');
		bindText(owner(), document.createTextNode(''), throwError(() => failure));
		expect(report).toHaveBeenCalledExactlyOnceWith(failure);
	});
});

describe('bindIf()', () => {
	it('keeps one child while true and disposes it before a fresh child is shown', () => {
		const scope = owner();
		const container = document.createElement('div');
		const sibling = document.createElement('p');
		container.appendChild(sibling);
		const visible$ = new Subject<boolean>();
		const titles$ = new Subject<string>();
		const release = vi.fn();
		const create = vi.fn((child: Scope) => {
			const node = document.createElement('span');
			child.add(release);
			bindText(child, node, titles$);
			return node;
		});
		bindIf(scope, container, visible$, create);
		visible$.next(false);
		expect(create).not.toHaveBeenCalled();
		visible$.next(true);
		const first = container.lastChild;
		titles$.next('first');
		visible$.next(true);
		expect(container.lastChild).toBe(first);
		expect(first?.textContent).toBe('first');
		expect(create).toHaveBeenCalledOnce();
		visible$.next(false);
		visible$.next(false);
		expect(container.childNodes).toHaveLength(1);
		expect(container.firstChild).toBe(sibling);
		expect(titles$.observed).toBe(false);
		expect(release).toHaveBeenCalledOnce();
		visible$.next(true);
		expect(container.lastChild).not.toBe(first);
		expect(create).toHaveBeenCalledTimes(2);
		scope.dispose();
		expect(release).toHaveBeenCalledTimes(2);
		expect(container.childNodes).toHaveLength(1);
	});

	it('retains child bindings after visibility completion until explicit unsubscribe', () => {
		const container = document.createElement('div');
		const titles$ = new Subject<string>();
		const release = vi.fn();
		const binding = bindIf(owner(), container, of(true), child => {
			const node = document.createElement('span');
			child.add(release);
			bindText(child, node, titles$);
			return node;
		});
		expect(binding.closed).toBe(false);
		titles$.next('still alive');
		expect(container.textContent).toBe('still alive');
		binding.unsubscribe();
		binding.unsubscribe();
		expect(container.childNodes).toHaveLength(0);
		expect(titles$.observed).toBe(false);
		expect(release).toHaveBeenCalledOnce();
	});

	it('retains a completed conditional until owner disposal and removes every fragment child', () => {
		const scope = owner();
		const container = document.createElement('div');
		const sibling = document.createTextNode('sibling');
		container.appendChild(sibling);
		const binding = bindIf(scope, container, of(true), () => {
			const fragment = document.createDocumentFragment();
			fragment.append(document.createTextNode('a'), document.createElement('span'));
			return fragment;
		});
		expect(container.childNodes).toHaveLength(3);
		scope.dispose();
		expect(binding.closed).toBe(true);
		expect(container.childNodes).toHaveLength(1);
		expect(container.firstChild).toBe(sibling);
	});

	it('does not subscribe or build conditional content for a closed owner', () => {
		const scope = owner();
		scope.dispose();
		const activate = vi.fn();
		const create = vi.fn(() => document.createElement('span'));
		const binding = bindIf(scope, document.createElement('div'), new Observable(activate), create);
		expect(binding.closed).toBe(true);
		expect(activate).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it('releases child resources and late source teardown when its factory disposes the owner', () => {
		const scope = owner();
		const container = document.createElement('div');
		const releaseSource = vi.fn();
		const releaseChild = vi.fn();
		const visible$ = new Observable<boolean>(subscriber => {
			subscriber.next(true);
			expect(subscriber.closed).toBe(true);
			subscriber.next(true);
			return releaseSource;
		});
		const create = vi.fn((child: Scope) => {
			child.add(releaseChild);
			scope.dispose();
			return document.createElement('span');
		});
		const binding = bindIf(scope, container, visible$, create);
		expect(binding.closed).toBe(true);
		expect(create).toHaveBeenCalledOnce();
		expect(container.childNodes).toHaveLength(0);
		expect(releaseChild).toHaveBeenCalledOnce();
		expect(releaseSource).toHaveBeenCalledOnce();
	});

	it('does not append a factory result after reentrant false', () => {
		const container = document.createElement('div');
		const visible$ = new Subject<boolean>();
		const release = vi.fn();
		bindIf(owner(), container, visible$, child => {
			child.add(release);
			visible$.next(false);
			return document.createElement('span');
		});
		visible$.next(true);
		expect(container.childNodes).toHaveLength(0);
		expect(visible$.observed).toBe(true);
		expect(release).toHaveBeenCalledOnce();
	});

	it('retains the newest child when a factory causes reentrant false then true', () => {
		const container = document.createElement('div');
		const visible$ = new Subject<boolean>();
		let count = 0;
		const releases: number[] = [];
		bindIf(owner(), container, visible$, child => {
			const id = ++count;
			child.add(() => releases.push(id));
			if (id === 1) { visible$.next(false); visible$.next(true); }
			return document.createTextNode(String(id));
		});
		visible$.next(true);
		expect(container.textContent).toBe('2');
		expect(container.childNodes).toHaveLength(1);
		expect(releases).toEqual([1]);
	});

	it('cleans setup resources when a child factory throws and reports the fault once', () => {
		const container = document.createElement('div');
		const visible$ = new Subject<boolean>();
		const release = vi.fn();
		const failure = new Error('construction failed');
		const onError = vi.fn();
		const binding = bindIf(owner(), container, visible$, child => {
			child.add(release);
			throw failure;
		}, onError);
		visible$.next(true);
		expect(binding.closed).toBe(true);
		expect(visible$.observed).toBe(false);
		expect(release).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(container.childNodes).toHaveLength(0);
	});

	it('cleans mounted content and bindings before reporting a source failure', () => {
		const container = document.createElement('div');
		const visible$ = new Subject<boolean>();
		const values$ = new Subject<string>();
		const failure = new Error('visibility failed');
		const onError = vi.fn(() => {
			expect(container.childNodes).toHaveLength(0);
			expect(values$.observed).toBe(false);
		});
		const binding = bindIf(owner(), container, visible$, child => {
			const node = document.createElement('span');
			bindText(child, node, values$);
			return node;
		}, onError);
		visible$.next(true);
		visible$.error(failure);
		expect(binding.closed).toBe(true);
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
	});

	it('releases content if the DOM append itself throws', () => {
		const container = document.createElement('div');
		const failure = new Error('append failed');
		vi.spyOn(container, 'appendChild').mockImplementation(() => { throw failure; });
		const release = vi.fn();
		const onError = vi.fn();
		const binding = bindIf(owner(), container, of(true), child => {
			child.add(release);
			return document.createElement('span');
		}, onError);
		expect(binding.closed).toBe(true);
		expect(release).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
	});

	it('removes a child when the child scope itself is disposed', () => {
		const container = document.createElement('div');
		let renderedScope: Scope | undefined;
		bindIf(owner(), container, of(true), child => {
			renderedScope = child;
			return document.createElement('span');
		});
		expect(container.childNodes).toHaveLength(1);
		renderedScope?.dispose();
		expect(container.childNodes).toHaveLength(0);
	});
});
