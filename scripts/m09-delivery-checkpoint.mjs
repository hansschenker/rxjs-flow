import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectLive } from './m05d-checkpoint.mjs';
import { runWorkerSmoke } from './smoke-worker.mjs';

// Actual built assets and public HTTP/SSE, with isolated local persistence.
// This does not deploy or prove behavior of an actual remote Cloudflare service.
assert.equal(process.argv.length, 2, 'Usage: node scripts/m09-delivery-checkpoint.mjs');
const navigationHeaders = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' };
const clientDirectory = new URL('../dist/client/', import.meta.url);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out`)), 10_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function decodeSnapshot(data) {
  const snapshot = JSON.parse(data);
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['collectionId', 'revision', 'schemaVersion', 'stateGeneration', 'todos']);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.collectionId, 'local-reference');
  assert.equal(typeof snapshot.stateGeneration, 'string');
  assert.ok(snapshot.stateGeneration.length > 0);
  assert.ok(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0);
  assert.ok(Array.isArray(snapshot.todos));
  // The existing protocol tests prove full runtime schema rejection. This
  // checkpoint compares actual live contents with the acknowledged CRUD values.
  return snapshot;
}

await runWorkerSmoke({ checkpoint: async ({ base, signal, checks, stop, start }) => {
  const consumers = new Set();
  async function request(path, init = {}) {
    const url = new URL(path, base);
    assert.equal(url.origin, base, 'All checkpoint requests remain on the local origin');
    return fetch(url, { ...init, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
  }

  async function json(path, status, init = {}) {
    const response = await request(path, init);
    const body = await response.text();
    assert.equal(response.status, status, `${init.method ?? 'GET'} ${path}: ${body}`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.doesNotMatch(body, /<!doctype|<html/i, `${path}: API must not return the HTML shell`);
    return JSON.parse(body);
  }

  async function mutate(method, suffix, input) {
    const init = { method, headers: { 'Content-Type': 'application/json', Origin: base },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    };
    if (method !== 'DELETE') return json('/api/todos' + suffix, method === 'POST' ? 201 : 200, init);
    const response = await request('/api/todos' + suffix, init);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  }

  async function connect(name) {
    const consumer = await connectLive(base, signal, name, {
      path: '/api/todos/live', eventName: 'todo-snapshot', decode: decodeSnapshot,
    });
    consumers.add(consumer);
    return consumer;
  }

  async function disconnect(consumer) {
    assert.equal((await consumer.cancel()).kind, 'cancelled');
    consumers.delete(consumer);
  }

  async function expectSnapshot(consumer, previous, todos) {
    const snapshot = await consumer.waitFor(value => value.revision >= previous.revision + 1, 'next committed revision');
    assert.deepEqual(snapshot, { ...previous, revision: previous.revision + 1, todos });
    return snapshot;
  }

  // Check the exact emitted entry, its imported chunks and CSS. A successful
  // shell alone cannot prove that the client graph is served from this build.
  const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', clientDirectory), 'utf8'));
  const assets = new Set();
  const entries = new Set();
  function includeEntry(key) {
    if (entries.has(key)) return;
    entries.add(key);
    const entry = manifest[key];
    assert.ok(entry, `Manifest entry ${key} exists`);
    assets.add(entry.file);
    for (const file of entry.css ?? []) assets.add(file);
    for (const dependency of entry.imports ?? []) includeEntry(dependency);
  }
  includeEntry('src/client/browser.ts');
  const servedAssets = [];
  for (const file of assets) {
    assert.ok(file.startsWith('assets/') && !file.includes('..'));
    const emitted = await readFile(new URL(file, clientDirectory));
    const response = await request('/' + file);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', file.endsWith('.css') ? /text\/css/ : /(?:java|ecma)script/);
    const served = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(served, emitted, `${file}: served bytes equal the emitted build`);
    servedAssets.push({ path: '/' + file, bytes: served.length, sha256: sha256(served) });
  }
  checks.push({ check: 'built client manifest graph served on the API origin', servedAssets });

  const prefixChecks = [];
  for (const path of ['/api/', '/api/missing', '/api/api/todos', '/api/todos/missing-route', '/api/todosx']) {
    await json(path, 404, { headers: navigationHeaders });
    prefixChecks.push({ path, status: 404, contentType: 'application/json' });
  }
  const expectedList = await json('/api/todos', 200);
  for (const path of ['/api/todos/', '/api//todos//']) {
    assert.deepEqual(await json(path, 200, { headers: navigationHeaders }), expectedList);
    prefixChecks.push({ path, status: 200, contentType: 'application/json' });
  }
  for (const path of ['/todos', '/apiary']) {
    const response = await request(path, { headers: navigationHeaders });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /<title>rxjs-flow Todos<\/title>/);
    prefixChecks.push({ path, status: 200, contentType: 'text/html', reason: 'outside the /api boundary' });
  }
  checks.push({ check: 'one API prefix; API routing precedes SPA fallback', prefixChecks });

  const rejected = [];
  for (const path of ['/api/todos', '/api/todos/live', '/api//todos//']) {
    for (const [reason, suffix, headers] of [
      ['foreign origin', '', { Origin: 'https://foreign.invalid' }],
      ['cross-site request', '', { 'Sec-Fetch-Site': 'cross-site' }],
      ['collection query', '?collectionId=other', {}],
      ['collection header', '', { 'X-Collection-Id': 'other' }],
    ]) {
      const result = await json(path + suffix, 403, { headers: { ...navigationHeaders, ...headers } });
      assert.equal(typeof result.error, 'string');
      rejected.push({ path: path + suffix, reason, status: 403, contentType: 'application/json' });
    }
  }
  assert.deepEqual(await json('/api/todos', 200), expectedList, 'Rejected requests do not change collection state');
  checks.push({ check: 'local access rejections never become the HTML shell', rejected });

  try {
    const a = await connect('M09 consumer A');
    const b = await connect('M09 consumer B');
    const initial = await Promise.all([a.waitFor(() => true, 'initial snapshot'), b.waitFor(() => true, 'initial snapshot')]);
    assert.deepEqual(initial[0], initial[1]);
    assert.deepEqual(initial[0].todos, expectedList);
    const created = await mutate('POST', '', { title: 'M09 public API delivery' });
    const afterCreate = await Promise.all([
      expectSnapshot(a, initial[0], [...expectedList, created]),
      expectSnapshot(b, initial[0], [...expectedList, created]),
    ]);
    assert.deepEqual(afterCreate[0], afterCreate[1]);
    const updated = await mutate('PUT', '/' + created.id, { completed: true });
    assert.equal(updated.completed, true);
    let current = (await Promise.all([
      expectSnapshot(a, afterCreate[0], [...expectedList, updated]),
      expectSnapshot(b, afterCreate[0], [...expectedList, updated]),
    ]))[0];
    assert.deepEqual(await json('/api/todos?completed=true', 200), current.todos.filter(todo => todo.completed));

    await disconnect(a);
    const stoppedCount = a.count;
    const intervening = await mutate('POST', '', { title: 'M09 committed during disconnect' });
    current = await expectSnapshot(b, current, [...current.todos, intervening]);
    assert.equal(a.count, stoppedCount, 'Cancelled consumer observes no later snapshot');
    const reconnected = await connect('M09 consumer A resnapshot');
    assert.deepEqual(await reconnected.waitFor(() => true, 'resnapshot'), current);
    checks.push({ check: 'versioned public CRUD/SSE with two HTTP consumers',
      path: '/api/todos/live', event: 'todo-snapshot', collectionId: current.collectionId,
      stateGeneration: current.stateGeneration, initialRevision: initial[0].revision,
      revisionBeforeRestart: current.revision, mutationCount: 3,
      sameCommittedSnapshots: true, disconnectedConsumerStopped: true,
      reconnectIncludesInterveningCommit: true,
    });

    await stop();
    const ended = await within(Promise.all([b.closed, reconnected.closed]), 'live responses close on process stop');
    for (const result of ended) assert.notEqual(result.kind, 'cancelled');
    consumers.clear();
    await start();
    const restored = await connect('M09 reconstructed consumer');
    assert.deepEqual(await restored.waitFor(() => true, 'reconstructed snapshot'), current,
      'Full local process restart retains collection, generation, revision and Todos');
    assert.deepEqual(await json('/api/todos', 200), current.todos);
    const recoveredRevision = current.revision;
    for (const id of [created.id, intervening.id]) {
      await mutate('DELETE', '/' + id);
      current = await expectSnapshot(restored, current, current.todos.filter(todo => todo.id !== id));
    }
    assert.deepEqual(current.todos, expectedList);
    const highWaterBytes = Math.max(a.highWaterBytes, b.highWaterBytes, reconnected.highWaterBytes, restored.highWaterBytes);
    await disconnect(restored);
    checks.push({ check: 'durable reconstruction and continued public mutation delivery',
      sameCollectionGenerationRevisionAndTodos: true, recoveredRevision,
      finalRevision: current.revision, deletedCheckpointTodos: 2,
      retainedSnapshotsPerConsumer: 1, maxFrameBytes: 128 * 1_024,
      observedFrameHighWaterBytes: highWaterBytes, checkpointReadLoopsActive: consumers.size,
      scope: 'one restarted local workerd process; no remote routing or deployment claim',
    });
  } finally {
    await Promise.allSettled([...consumers].map(consumer => consumer.cancel()));
  }
} });
