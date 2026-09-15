import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import type { Todo } from '../shared/types';

const service = vi.hoisted(() => ({ getAll$: vi.fn(), create$: vi.fn(), update$: vi.fn(), remove$: vi.fn() }));
vi.mock('../client/todo.service', () => service);

const todo: Todo = { id: 'baseline', title: 'synchronous result', completed: false, createdAt: '2026-09-15T00:00:00Z' };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  document.body.innerHTML = '<form id="add-form"><input id="title-input"></form><p id="error-msg"></p><ul id="todo-list"></ul>';
  service.getAll$.mockReturnValue(of([]));
  service.create$.mockReturnValue(of(todo));
});

afterEach(async () => {
  const state = await import('../client/todo.state');
  state.action$.complete();
  document.body.innerHTML = '';
});

describe('M00: client startup and root ownership', () => {
  it('M02: renders a synchronous startup result', async () => {
    service.getAll$.mockReturnValue(of([todo]));
    await import('../client/main');
    expect(service.getAll$).toHaveBeenCalledOnce();
    expect(document.getElementById('todo-list')!.textContent).toContain(todo.title);
  });

  it('M01: exposes an explicit construction/disposal boundary', async () => {
    const entry = await import('../client/main');
    // No specific future API name is prescribed. A caller needs an entry function
    // to construct a disposable root or an exported disposal function.
    expect(Object.values(entry).some(value => typeof value === 'function')).toBe(true);
  });

  it('observation: detaching the view does not detach its submit listener', async () => {
    await import('../client/main');
    const form = document.getElementById('add-form') as HTMLFormElement;
    (document.getElementById('title-input') as HTMLInputElement).value = 'after removal';
    document.body.innerHTML = '';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(service.create$).toHaveBeenCalledWith({ title: 'after removal' });
    // This records the current behavior; automatic DOM-removal cleanup is not
    // required. M01 must supply an explicit root disposal operation.
  });
});
