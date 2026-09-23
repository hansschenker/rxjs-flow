import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkerSmoke } from './smoke-worker.mjs';

// A complete snapshot is at most 120 KiB in the authority. Allow SSE field
// framing, but never accumulate an unbounded frame or history in this consumer.
const MAX_FRAME_BYTES = 128 * 1_024;
const TIMEOUT_MS = 10_000;

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description}: timed out`)), TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function decodeLegacyTodos(data) {
  const decoded = JSON.parse(data);
  assert.ok(Array.isArray(decoded), 'Legacy todos event is an array');
  return decoded;
}

/** One read at a time, a fixed frame buffer, and only the latest full snapshot. */
export async function connectLive(base, signal, name, {
  path = '/api/todos/stream', eventName = 'todos', decode = decodeLegacyTodos,
} = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let reader;
  let requestedClose = false;
  let latest;
  let count = 0;
  let highWaterBytes = 0;
  let pending;
  let end;
  const closed = deferred();
  function finish(value) {
    end = value;
    signal.removeEventListener('abort', onAbort);
    pending?.reject(new Error(`${name} ended while waiting for a snapshot (${value.kind})`));
    pending = undefined;
    closed.resolve(value);
  }
  try {
    const response = await within(fetch(new URL(path, base), {
      headers: { Accept: 'text/event-stream' }, signal: controller.signal,
    }), `${name} response headers`);
    assert.equal(response.status, 200, `${name}: ${await (response.ok ? Promise.resolve('') : response.text())}`);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(response.body);
    reader = response.body.getReader();
  } catch (error) {
    controller.abort(error);
    signal.removeEventListener('abort', onAbort);
    throw error;
  }

  // This single async read loop is the test transport boundary, not an async
  // observer callback. Slow consumers retain one latest value, not every event.
  void (async function read() {
    const frame = new Uint8Array(MAX_FRAME_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          assert.equal(size, 0, `${name}: incomplete SSE frame at EOF`);
          finish({ kind: requestedClose ? 'cancelled' : 'complete' });
          return;
        }
        for (const byte of value) {
          assert.ok(size < MAX_FRAME_BYTES, `${name}: SSE frame exceeds ${MAX_FRAME_BYTES} bytes`);
          frame[size++] = byte;
          highWaterBytes = Math.max(highWaterBytes, size);
          const complete = size >= 2 && frame[size - 1] === 10 && frame[size - 2] === 10;
          const crlfComplete = size >= 4 && frame[size - 4] === 13 && frame[size - 3] === 10
            && frame[size - 2] === 13 && frame[size - 1] === 10;
          if (!complete && !crlfComplete) continue;
          const lines = decoder.decode(frame.subarray(0, size)).split(/\r?\n/);
          size = 0;
          const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          assert.equal(event, eventName, `${name}: expected full Todo snapshot event`);
          latest = decode(data);
          count++;
          if (pending?.predicate(latest)) {
            pending.resolve(latest);
            pending = undefined;
          }
        }
      }
    } catch (error) {
      finish({ kind: requestedClose ? 'cancelled' : 'error', error: String(error) });
    } finally {
      try { await reader.cancel(); } catch { /* upstream may already have failed */ }
      reader.releaseLock();
    }
  })();

  return {
    get count() { return count; },
    get latest() { return latest; },
    get highWaterBytes() { return highWaterBytes; },
    closed: closed.promise,
    async waitFor(predicate, label) {
      if (latest && predicate(latest)) return latest;
      assert.ok(!pending, `${name}: exactly one pending snapshot condition`);
      assert.ok(!end, `${name}: stream already ended (${end?.kind})`);
      try {
        return await within(new Promise((resolve, reject) => { pending = { predicate, resolve, reject }; }), `${name}: ${label}`);
      } finally { pending = undefined; }
    },
    async cancel() {
      requestedClose = true;
      // Exercise response-body cancellation itself. The request controller is
      // retained only as a final fallback if a broken adapter hangs cleanup.
      try {
        await within(reader.cancel('checkpoint consumer disconnect'), `${name}: body cancellation`);
        return await within(closed.promise, `${name}: cancellation settles read loop`);
      } finally { controller.abort(); }
    },
  };
}

export async function runM05dCheckpoint({ development = true, browserCheck } = {}) {
  await runWorkerSmoke({ development, checkpoint: async ({ base, signal, checks, stop, start }) => {
    const consumers = new Set();
    async function connect(name) {
      const consumer = await connectLive(base, signal, name);
      consumers.add(consumer);
      return consumer;
    }
    async function create(title) {
      const response = await fetch(new URL('/api/todos', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }), signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      assert.equal(response.status, 201);
      return response.json();
    }
    const contains = todo => todos => todos.some(value => value.id === todo.id && value.title === todo.title);
    try {
      const pageResponse = await fetch(new URL('/m05d-live.html', base), { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      assert.equal(pageResponse.status, 200);
      const page = await pageResponse.text();
      assert.match(page, /Live connection checkpoint/);
      const pageScript = [...page.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
        .map(match => match[1]).find(path => development ? path === '/src/checkpoints/m05d-live.ts' : path.startsWith('/assets/'));
      assert.ok(pageScript, 'Standalone checkpoint browser entry is emitted');
      const scriptResponse = await fetch(new URL(pageScript, base), { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      assert.equal(scriptResponse.status, 200);
      assert.match(scriptResponse.headers.get('content-type') ?? '', /(?:java|ecma)script/);
      assert.ok((await scriptResponse.text()).length > 0);
      checks.push({ check: 'standalone browser checkpoint served', path: '/m05d-live.html', script: pageScript });
      const a = await connect('consumer A');
      const b = await connect('consumer B');
      const initial = await Promise.all([a.waitFor(() => true, 'initial snapshot'), b.waitFor(() => true, 'initial snapshot')]);
      assert.deepEqual(initial[0], initial[1]);
      const shared = await create('M05d shared live update');
      await Promise.all([a.waitFor(contains(shared), 'shared update'), b.waitFor(contains(shared), 'shared update')]);
      const aCount = a.count;
      assert.equal((await a.cancel()).kind, 'cancelled');
      consumers.delete(a);
      const intervening = await create('M05d written while A disconnected');
      await b.waitFor(contains(intervening), 'continues after A disconnects');
      assert.equal(a.count, aCount, 'Disconnected A receives no new values');
      const reconnected = await connect('consumer A reconnect');
      const fresh = await reconnected.waitFor(contains(intervening), 'fresh reconnect snapshot');
      assert.ok(contains(shared)(fresh));
      checks.push({ check: 'two actual HTTP SSE consumers', initialSame: true,
        sharedCommitDelivered: true, responseBodyCancellation: true,
        otherConsumerContinues: true, reconnectIncludesInterveningCommit: true,
        retainedSnapshotsPerConsumer: 1, maxFrameBytes: MAX_FRAME_BYTES,
        observedFrameHighWaterBytes: Math.max(a.highWaterBytes, b.highWaterBytes, reconnected.highWaterBytes),
      });

      const beforeRestart = b.latest;
      await stop();
      const terminal = await Promise.all([
        within(b.closed, 'consumer B sees runtime interruption'),
        within(reconnected.closed, 'reconnected A sees runtime interruption'),
      ]);
      for (const result of terminal) assert.notEqual(result.kind, 'cancelled');
      consumers.clear();
      await start();
      const restored = await connect('consumer after full runtime restart');
      assert.deepEqual(await restored.waitFor(() => true, 'reconstructed initial snapshot'), beforeRestart,
        'New stream reconstructs committed storage after full process restart');
      const recovered = await create('M05d stream continues after restart');
      await restored.waitFor(contains(recovered), 'live commit after restart');
      await restored.cancel();
      consumers.delete(restored);
      checks.push({ check: 'full runtime interruption and new stream', terminal,
        persistedSnapshotRecovered: true, newCommitDelivered: true,
        checkpointReadLoopsActive: consumers.size,
      });
      if (browserCheck) await browserCheck({ base, signal, checks, stop, start });
    } finally {
      await Promise.allSettled([...consumers].map(consumer => consumer.cancel()));
    }
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  assert.ok(arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--preview'),
    'Usage: node scripts/m05d-checkpoint.mjs [--preview]');
  await runM05dCheckpoint({ development: !arguments_.includes('--preview') });
}
