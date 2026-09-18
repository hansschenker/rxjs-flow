import { todoListSchema } from '../shared/todo.schema';

// A standalone transport diagnostic. The Todo application's model and rendering
// remain unchanged until M06. Each panel owns one native EventSource lifetime.
function required<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing checkpoint element: ${selector}`);
  return value;
}

function createConsumer(panel: HTMLElement, signal: AbortSignal): () => void {
  const status = required<HTMLElement>(panel, '[data-status]');
  const count = required<HTMLElement>(panel, '[data-count]');
  const snapshot = required<HTMLElement>(panel, '[data-snapshot]');
  const connect = required<HTMLButtonElement>(panel, '[data-connect]');
  const disconnect = required<HTMLButtonElement>(panel, '[data-disconnect]');
  let source: EventSource | undefined;
  let received = 0;

  function close(message = 'Disconnected'): void {
    const current = source;
    source = undefined;
    current?.close();
    status.textContent = message;
    connect.disabled = signal.aborted;
    disconnect.disabled = true;
  }

  function start(): void {
    if (signal.aborted || source) return;
    const current = new EventSource('/api/todos/stream');
    source = current;
    connect.disabled = true;
    disconnect.disabled = false;
    status.textContent = 'Connecting…';
    current.addEventListener('open', function opened() {
      if (source === current) status.textContent = 'Connected · waiting for a snapshot';
    });
    current.addEventListener('todos', function receivedSnapshot(event: MessageEvent<string>) {
      if (source !== current) return;
      try {
        // Guard the diagnostic display as well as the server's byte budget.
        if (event.data.length > 128 * 1_024) throw new Error('Snapshot exceeds the display limit');
        const todos = todoListSchema.parse(JSON.parse(event.data));
        const json = JSON.stringify(todos, null, 2);
        snapshot.textContent = json.length > 16_384 ? `${json.slice(0, 16_384)}\n… Display truncated` : json;
        count.textContent = String(++received);
        status.textContent = `Connected · ${todos.length} saved ${todos.length === 1 ? 'Todo' : 'Todos'}`;
      } catch {
        close('Invalid snapshot received · reconnect to try again');
      }
    });
    current.addEventListener('error', function interrupted() {
      if (source === current) close('Connection interrupted · reconnect when the server is ready');
    });
  }

  connect.addEventListener('click', start, { signal });
  disconnect.addEventListener('click', () => close(), { signal });
  return close;
}

function mountCheckpoint(): () => void {
  const owner = new AbortController();
  const consumers = [...document.querySelectorAll<HTMLElement>('[data-consumer]')]
    .map(panel => createConsumer(panel, owner.signal));
  const form = required<HTMLFormElement>(document, '#create-todo');
  const title = required<HTMLInputElement>(form, '#todo-title');
  const save = required<HTMLButtonElement>(form, 'button[type="submit"]');
  const status = required<HTMLElement>(form, '#write-status');
  let writing = false;

  async function saveTodo(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (writing || owner.signal.aborted || !title.value.trim()) return;
    writing = true;
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      const response = await fetch('/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.value.trim() }),
        signal: AbortSignal.any([owner.signal, AbortSignal.timeout(10_000)]),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(`Save failed (HTTP ${response.status})`);
      if (owner.signal.aborted) return;
      status.textContent = 'Saved. Connected consumers receive the committed collection.';
      title.value = '';
      // The mutation response never updates either consumer's snapshot display.
      void body;
    } catch (error) {
      if (!owner.signal.aborted) status.textContent = error instanceof Error ? error.message : 'Save failed';
    } finally {
      writing = false;
      save.disabled = owner.signal.aborted;
    }
  }

  form.addEventListener('submit', event => { void saveTodo(event); }, { signal: owner.signal });
  return function dispose(): void {
    owner.abort();
    consumers.forEach(close => close());
    save.disabled = true;
  };
}

const dispose = mountCheckpoint();
window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);
