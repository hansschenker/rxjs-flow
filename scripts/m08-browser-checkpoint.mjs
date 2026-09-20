import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runWorkerSmoke } from './smoke-worker.mjs';

// Optional native-browser evidence. Reuse M07's local Worker/asset harness and
// externally installed browser tools; normal CI does not download a browser.
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.every(argument => argument === '--dev'),
  'Usage: node scripts/m08-browser-checkpoint.mjs [--dev]');
assert.ok(process.env.PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const browserArguments = JSON.parse(process.env.M08_CHROMIUM_ARGS ?? '[]');
assert.ok(Array.isArray(browserArguments) && browserArguments.every(value => typeof value === 'string'),
  'M08_CHROMIUM_ARGS must be a JSON array of browser arguments');
const development = arguments_.includes('--dev');
const hostEntry = development ? '/src/client/browser.ts' : '/' + JSON.parse(
  await readFile(new URL('../dist/client/.vite/manifest.json', import.meta.url), 'utf8'),
)['src/client/browser.ts'].file;

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
async function waitFor(predicate, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
}
async function within(promise, description, timeout = 10_000) {
  const deadline = new AbortController();
  try {
    return await Promise.race([promise, delay(timeout, undefined, { signal: deadline.signal }).then(() => {
      throw new Error(`Timed out: ${description}`);
    })]);
  } finally { deadline.abort(); }
}

await runWorkerSmoke({ development, checkpoint: async ({ base, checks, stop, start }) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    headless: true, args: browserArguments });
  const clients = [];
  const errors = [];
  const holds = [];
  const records = [];
  const results = [];
  let phase = 'setup';
  let releasedListeners = 0;

  function currentRequests(client) {
    return [...client.active.entries()].filter(([, value]) => value.loaderId === client.loaderId);
  }
  function retiredRequests(client) {
    // Preserve missing terminal CDP events from documents replaced by Vite HMR.
    // They are not silently reassigned to, or counted as, the current program.
    return [...client.active.entries()].filter(([, value]) => value.loaderId !== client.loaderId)
      .map(([requestId, value]) => ({ requestId, ...value,
        disposition: 'document replaced; no terminal CDP request event observed' }));
  }
  async function live(client) {
    await client.page.waitForFunction(() =>
      document.querySelector('#connection-state')?.getAttribute('data-state') === 'live',
    null, { timeout: 25_000 });
    await waitFor(() => currentRequests(client).filter(([, value]) => value.path.endsWith('/live')).length === 1,
      `${client.name} owns exactly one current-document native SSE request`);
  }
  async function present(client, title) {
    await client.page.waitForFunction(value => [...document.querySelectorAll('#todo-list li > span')]
      .some(node => node.textContent === value), title, { timeout: 10_000 });
  }
  async function settled(client) {
    await client.page.waitForFunction(() =>
      document.querySelector('#pending-msg')?.textContent === 'All changes settled',
    null, { timeout: 10_000 });
  }
  function row(client, title) {
    return client.page.locator('#todo-list li').filter({
      has: client.page.locator('span', { hasText: title }),
    });
  }

  async function mount(name, traced) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
    const page = await context.newPage();
    const devtools = await context.newCDPSession(page);
    const client = { name, traced, context, page, devtools, host: undefined, latest: undefined,
      requests: [], active: new Map(), loaderId: undefined, navigations: 0, mounts: 0,
      traceOffset: 0, elapsed: [], documentEvents: [] };
    clients.push(client);
    page.on('pageerror', error => errors.push(`${name}: ${String(error)}`));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/todos')) client.requests.push({ method: request.method(),
        path: path.replace(/\/todos\/[^/]+$/, suffix => suffix === '/todos/live' ? suffix : '/todos/:id') });
    });
    await devtools.send('Network.enable');
    await devtools.send('Page.enable');
    devtools.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      client.loaderId = frame.loaderId;
      client.navigations++;
      client.documentEvents.push({ loaderId: frame.loaderId, url: frame.url });
    });
    devtools.on('Network.requestWillBeSent', event => {
      const path = new URL(event.request.url).pathname;
      if (path.startsWith('/api/todos')) client.active.set(event.requestId,
        { loaderId: event.loaderId, method: event.request.method, path });
    });
    function ended(event) { client.active.delete(event.requestId); }
    devtools.on('Network.loadingFinished', ended);
    devtools.on('Network.loadingFailed', ended);
    devtools.on('Network.eventSourceMessageReceived', event => {
      try {
        assert.equal(event.eventName, 'todo-snapshot');
        client.latest = JSON.parse(event.data);
        assert.equal(client.latest.schemaVersion, 1);
      } catch (error) { errors.push(`${name} protocol: ${String(error)}`); }
    });
    await page.goto(base);
    assert.match(await page.evaluate(() => EventSource.toString()), /native code/);
    await live(client);
    await importHost(client);
    await dispose(client);
    await remount(client);
    return client;
  }

  async function importHost(client) {
    const requestsBefore = client.requests.length;
    client.host = await client.page.evaluateHandle(async ({ entry, runtimeId, traced }) => {
      const module = await import(entry);
      const recorder = module.createTraceRecorder({ capacity: 10_000 });
      const trace = traced ? module.createTrace({ runtimeId, now: () => performance.now(), sink: recorder.sink }) : undefined;
      return { module, current: module.app, recorder, trace, completions: 0, observers: [], nextScope: 0 };
    }, { entry: hostEntry, runtimeId: `${client.name}-document-${client.navigations}`, traced: client.traced });
    client.traceOffset = 0;
    assert.equal(client.requests.length, requestsBefore, 'Importing the cached host entry starts no extra request');
  }
  async function collect(client) {
    const captured = await client.host.evaluate(host => ({ records: host.recorder.records(), dropped: host.recorder.dropped,
      diagnostics: host.trace?.diagnostics }));
    assert.equal(captured.dropped, 0, 'The bounded checkpoint recorder did not drop evidence');
    if (captured.diagnostics) {
      for (const key of ['clockFailures', 'sinkFailures', 'reentrantDrops', 'invalidRecords']) {
        assert.equal(captured.diagnostics[key], 0, `Trace ${key} must not silently discard checkpoint evidence`);
      }
    }
    records.push(...captured.records.slice(client.traceOffset));
    client.traceOffset = captured.records.length;
    return captured.records;
  }
  async function remount(client) {
    const before = client.requests.length;
    const started = performance.now();
    await client.host.evaluate(host => {
      host.current = host.module.mountTodoApp(document, { trace: host.trace,
        traceScope: `checkpoint-mount-${++host.nextScope}` });
      host.completions = 0;
      host.observers = [host.current.state$, host.current.viewModel$, host.current.transitions$]
        .map(stream => stream.subscribe({ complete: () => { host.completions++; } }));
    });
    await live(client);
    client.mounts++;
    client.elapsed.push({ operation: 'mount-to-live', milliseconds: Number((performance.now() - started).toFixed(3)) });
    assert.deepEqual(client.requests.slice(before), [{ method: 'GET', path: '/api/todos/live' }],
      'Mount plus three public stream consumers starts exactly one native live request');
  }
  async function dispose(client) {
    const targets = [];
    const selectors = ['#add-form', '#title-input', '#refresh-todos', '#filter-all',
      '#filter-active', '#filter-completed', '#dismiss-error'];
    const rowControls = await client.page.locator('#todo-list li input, #todo-list li button').count();
    const expressions = selectors.map(selector => `document.querySelector(${JSON.stringify(selector)})`);
    for (let index = 0; index < rowControls; index++) expressions.push(`document.querySelectorAll('#todo-list li input, #todo-list li button')[${index}]`);
    for (const expression of expressions) {
      const { result } = await client.devtools.send('Runtime.evaluate', { expression, objectGroup: 'm08-listeners' });
      assert.ok(result.objectId, `${expression}: actual native control exists`);
      const { listeners } = await client.devtools.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      assert.ok(listeners.length >= 1, `${expression}: application listener exists before disposal`);
      targets.push({ objectId: result.objectId, before: listeners.length });
    }
    await client.host.evaluate(host => { host.current.dispose(); });
    for (const target of targets) {
      const { listeners } = await client.devtools.send('DOMDebugger.getEventListeners', { objectId: target.objectId });
      assert.equal(listeners.length, 0, 'Disposal removes the actual native event listeners');
      releasedListeners += target.before;
    }
    await client.devtools.send('Runtime.releaseObjectGroup', { objectGroup: 'm08-listeners' });
    await waitFor(() => currentRequests(client).length === 0, `${client.name}: all owned current-document API requests close`);
    const consumers = await client.host.evaluate(host => ({ completions: host.completions,
      count: host.observers.length, closed: host.observers.every(subscription => subscription.closed) }));
    assert.equal(consumers.completions, consumers.count);
    assert.equal(consumers.closed, true);
    await collect(client);
  }
  async function save(client, title, peers) {
    const started = performance.now();
    await client.page.getByLabel('New task', { exact: true }).fill(title);
    await client.page.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(client);
    await Promise.all(peers.map(peer => present(peer, title)));
    client.elapsed.push({ operation: 'DOM-submit-to-two-client-observation',
      milliseconds: Number((performance.now() - started).toFixed(3)) });
  }
  async function holdAccepted(client) {
    const forwarded = deferred();
    const release = deferred();
    const finished = deferred();
    const hold = { forwarded: forwarded.promise, release: release.resolve, finished: finished.promise };
    holds.push(hold);
    await client.page.route('**/api/todos', async route => {
      try {
        assert.equal(route.request().method(), 'POST');
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        forwarded.resolve(await response.json());
        await release.promise;
        // Disposing the actual client may already have canceled this reply.
        try { await route.fulfill({ response }); } catch { /* observed abort is asserted through CDP */ }
      } catch (error) { errors.push(`${client.name} held reply: ${String(error)}`); }
      finally { finished.resolve(); }
    }, { times: 1 });
    return hold;
  }
  function requestSummary(pair) {
    return pair.map(client => ({ client: client.name.slice(-1), requests: client.requests.slice(),
      mounts: client.mounts, navigationCount: client.navigations }));
  }

  async function deterministicScenario(traced) {
    const started = performance.now();
    const label = traced ? 'traced' : 'untraced';
    phase = `${label}: paired operation and cancellation`;
    const a = await mount(`${label}-A`, traced);
    const b = await mount(`${label}-B`, traced);
    const pair = [a, b];
    await save(a, 'Complete operation', pair);
    await row(b, 'Complete operation').getByRole('checkbox').check();
    await settled(b);
    await waitFor(() => a.latest.todos.some(todo => todo.title === 'Complete operation' && todo.completed), 'A observes B update');
    const held = await holdAccepted(a);
    await a.page.getByLabel('New task', { exact: true }).fill('Committed before cancellation');
    await a.page.getByRole('button', { name: 'Add', exact: true }).click();
    const committed = await within(held.forwarded, 'real Hono/authority reply before local cancellation');
    await Promise.all(pair.map(client => present(client, 'Committed before cancellation')));
    assert.ok(currentRequests(a).some(([, request]) => request.method === 'POST'), 'Canceled operation has an active native finite request');
    await dispose(a);
    held.release();
    await within(held.finished, 'release canceled committed reply');
    await remount(a);
    await present(a, 'Committed before cancellation');
    assert.ok(a.latest.todos.some(todo => todo.id === committed.id), 'Cancellation does not roll back the committed write');
    for (const title of ['Complete operation', 'Committed before cancellation']) {
      await row(b, title).getByRole('button').click();
      await settled(b);
    }
    await waitFor(() => pair.every(client => client.latest.todos.length === 0), 'Both clients observe the empty collection');
    phase = `${label}: repeated mounting and resource census`;
    for (let index = 0; index < 3; index++) { await dispose(a); await remount(a); }
    const summary = requestSummary(pair);
    const liveRequest = { method: 'GET', path: '/api/todos/live' };
    assert.deepEqual(summary.map(client => client.requests), [
      [liveRequest, liveRequest, { method: 'POST', path: '/api/todos' },
        { method: 'POST', path: '/api/todos' }, liveRequest, liveRequest, liveRequest, liveRequest],
      [liveRequest, liveRequest, { method: 'PUT', path: '/api/todos/:id' },
        { method: 'DELETE', path: '/api/todos/:id' }, { method: 'DELETE', path: '/api/todos/:id' }],
    ], 'The deterministic scenario starts exactly its owned live requests and five deliberate mutations');
    for (const client of pair) await dispose(client);
    assert.ok(pair.every(client => currentRequests(client).length === 0));
    const result = { traced, requestSummary: summary,
      elapsedMilliseconds: Number((performance.now() - started).toFixed(3)),
      timingSamples: pair.flatMap(client => client.elapsed.map(sample => ({ client: client.name.slice(-1), ...sample }))),
      finalOwnedBrowserRequests: 0, successfulCommitSurvivesLocalCancellation: true,
      extraPublicConsumersRepeatNoEffects: true };
    results.push(result);
    return pair;
  }

  try {
    const untraced = await deterministicScenario(false);
    for (const client of untraced) await client.page.close();
    const [a, b] = await deterministicScenario(true);
    assert.deepEqual(results[1].requestSummary, results[0].requestSummary,
      'Enabling traces leaves exact per-client HTTP method/path sequences and mount counts unchanged');

    phase = 'traced authority reconstruction';
    await remount(a);
    await remount(b);
    await save(b, 'Survives authority reconstruction', [a, b]);
    const before = structuredClone(a.latest);
    const navigationsBefore = [a.navigations, b.navigations];
    await Promise.all([collect(a), collect(b)]);
    await stop();
    await Promise.all([a, b].map(client => client.page.waitForFunction(() =>
      document.querySelector('#connection-state')?.getAttribute('data-state') === 'stale',
    null, { timeout: 10_000 })));
    await Promise.all([collect(a), collect(b)]);
    const hostReloads = development ? [a, b].map(client => client.page.waitForEvent('framenavigated', {
      predicate: frame => frame === client.page.mainFrame(), timeout: 8_000,
    }).then(() => true, () => false)) : [];
    await start();
    const devHostReloads = await Promise.all(hostReloads);
    await Promise.all([live(a), live(b)]);
    assert.deepEqual(a.latest, before, 'Full local process reconstruction retains collection/generation/revision/content');
    assert.deepEqual(b.latest, before);
    if (!development) assert.deepEqual([a.navigations, b.navigations], navigationsBefore,
      'Built host recovers through its owned connection without navigation');
    for (const [index, client] of [a, b].entries()) {
      if (client.navigations !== navigationsBefore[index]) {
        await importHost(client);
        await dispose(client);
        await remount(client);
      }
    }
    await save(a, 'Committed after reconstruction', [a, b]);
    assert.equal(a.latest.stateGeneration, before.stateGeneration);
    assert.ok(a.latest.revision > before.revision);
    if (process.env.M08_SCREENSHOT) await a.page.screenshot({ path: process.env.M08_SCREENSHOT, fullPage: true });
    const finalSnapshot = { collectionId: a.latest.collectionId, stateGeneration: a.latest.stateGeneration,
      revision: a.latest.revision, todoCount: a.latest.todos.length };
    for (const client of [a, b]) await dispose(client);
    const retired = Object.fromEntries([a, b].map(client => [client.name, retiredRequests(client)]));
    if (!development) assert.ok(Object.values(retired).every(requests => requests.length === 0));
    assert.deepEqual(errors, []);
    assert.ok(records.length > 0, 'Opt-in native-browser trace records were captured');
    // Keep each runtime's own sequence; no cross-runtime clock sorting is valid.
    const runtimes = Map.groupBy(records, record => record.runtimeId);
    for (const runtimeRecords of runtimes.values()) {
      for (let index = 1; index < runtimeRecords.length; index++) {
        assert.ok(runtimeRecords[index].sequence > runtimeRecords[index - 1].sequence);
      }
    }
    const completedOperation = records.find(record => record.event === 'effect.complete' && record.sourceId === 'todo.create');
    const canceledOperation = records.find(record => record.event === 'effect.cancel' && record.sourceId === 'todo.create');
    assert.ok(completedOperation?.operationId, 'A complete finite operation has diagnostic correlation');
    assert.ok(canceledOperation?.operationId, 'The held finite operation has a correlated cancellation');
    for (const [terminal, expected] of [[completedOperation, ['effect.subscribe', 'effect.next', 'effect.complete']],
      [canceledOperation, ['effect.subscribe', 'effect.cancel']]]) {
      const observed = records.filter(record => record.operationId === terminal.operationId && record.sourceId === 'todo.create'
        && record.event.startsWith('effect.')).map(record => record.event);
      assert.deepEqual(observed, expected, 'Completion and cancellation are separate finite operation lifecycles');
    }
    const mutationQueues = records.filter(record => record.sourceId === 'todo.mutation-queue' && record.event === 'resource.state');
    assert.ok(mutationQueues.length > 0);
    for (const record of mutationQueues) {
      assert.ok(record.metadata.active <= 1 && record.metadata.queued >= 0);
      assert.equal(record.metadata.count, record.metadata.active + record.metadata.queued);
      assert.ok(record.metadata.count <= record.metadata.capacity);
      if (record.metadata.reason === 'disposed') assert.equal(record.metadata.count, 0);
    }
    assert.ok(records.some(record => record.event === 'connection.change' && record.metadata?.kind === 'reconnecting'),
      'The browser trace records interrupted connection recovery');
    for (const title of ['Complete operation', 'Committed before cancellation',
      'Survives authority reconstruction', 'Committed after reconstruction']) {
      assert.equal(JSON.stringify(records).includes(title), false, 'Default traces exclude Todo payloads');
    }
    const output = { evidence: 'actual local native-browser client traces and passive HTTP/SSE/resource observations',
      authorityTrace: 'not injected into this host; authority-local traces are separate Workers integration evidence',
      clocks: 'runtime-local performance.now; sequence orders a runtime; no cross-runtime total order',
      browser: browser.version(), mode: development ? 'Vite Cloudflare development' : 'built local Wrangler',
      traceRequestParity: true, deterministicScenarios: results,
      independentBrowserContextsPerScenario: 2, fullLocalRuntimeRestart: true,
      steadyNativeSseRequests: 2, steadyNativeSseRequestsPerMountedOwner: 1,
      completedOperationId: completedOperation.operationId, canceledOperationId: canceledOperation.operationId,
      clientMutationQueueCapacity: 32, clientMutationActiveMaximum: Math.max(...mutationQueues.map(record => record.metadata.active)),
      clientMutationAdmittedMaximum: Math.max(...mutationQueues.map(record => record.metadata.count)),
      todoPayloadsAbsentFromTraces: true,
      devHostReloads, builtRecoveryWithoutNavigation: !development,
      finalSnapshot, releasedNativeListeners: releasedListeners, finalCurrentDocumentApiRequests: 0,
      replacedDocumentRequestsWithoutTerminalEvent: retired, uncaughtBrowserErrors: errors.length,
      traceRecordCount: records.length,
      runtimeRecordCounts: Object.fromEntries([...runtimes].map(([id, values]) => [id, values.length])),
      eventCounts: Object.fromEntries([...Map.groupBy(records, record => record.event)].map(([event, values]) => [event, values.length])),
      performanceLimit: 'Single local samples include harness, browser scheduling and transport; no benchmark or speed claim.',
    };
    if (process.env.M08_TRACE_OUTPUT) await writeFile(process.env.M08_TRACE_OUTPUT,
      JSON.stringify({ ...output, records }, null, 2) + '\n');
    for (const client of [a, b]) await client.page.close();
    await browser.close();
    checks.push({ check: 'M08 temporal and ownership browser checkpoint', ...output,
      finalMountedPagesClosed: true, finalBrowserContextsClosed: true });
  } catch (error) {
    console.error(JSON.stringify({ phase, error: error.stack ?? String(error), errors,
      clients: clients.map(client => ({ name: client.name, requests: client.requests,
        active: [...client.active], navigations: client.documentEvents })),
    }, null, 2));
    throw error;
  } finally {
    for (const hold of holds) hold.release();
    await browser.close();
  }
} });
