import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runWorkerSmoke } from './smoke-worker.mjs';

// Build first. This optional checkpoint uses caller-installed Playwright and
// Chromium; neither becomes an application dependency or a normal CI gate.
assert.equal(process.argv.length, 2, 'Usage: node scripts/m06-browser-checkpoint.mjs');
assert.ok(process.env.PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH to an installed Playwright module entry');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const browserArguments = JSON.parse(process.env.M06_CHROMIUM_ARGS ?? '[]');
assert.ok(Array.isArray(browserArguments) && browserArguments.every(value => typeof value === 'string'),
  'M06_CHROMIUM_ARGS must be a JSON array of browser arguments');

await runWorkerSmoke({ checkpoint: async ({ base, checks, stop, start }) => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true, args: browserArguments,
  });
  const clients = [];
  const errors = [];
  const mutationRequests = [];
  const acceptedMutations = [];
  let finiteListReads = 0;

  async function mount(name) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
    const page = await context.newPage();
    const client = { name, context, page, streamRequests: 0, frames: 0, latest: undefined };
    clients.push(client);
    page.on('pageerror', error => errors.push(`${name}: ${String(error)}`));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/todos/live') client.streamRequests++;
      if (path.startsWith('/api/todos') && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
        mutationRequests.push({ client: name, method: request.method(), path });
      }
      if (path === '/api/todos' && request.method() === 'GET') finiteListReads++;
    });
    page.on('response', response => {
      const request = response.request();
      if (new URL(request.url()).pathname.startsWith('/api/todos') && ['POST', 'PUT', 'DELETE'].includes(request.method()) && response.ok()) {
        acceptedMutations.push({ client: name, method: request.method(), status: response.status() });
      }
    });
    // Passive DevTools observation records the real native EventSource payload.
    // It does not replace or inject the application's transport or state stream.
    const devtools = await context.newCDPSession(page);
    await devtools.send('Network.enable');
    devtools.on('Network.eventSourceMessageReceived', event => {
      try {
        assert.equal(event.eventName, 'todo-snapshot');
        const snapshot = JSON.parse(event.data);
        assert.equal(snapshot.schemaVersion, 1);
        client.latest = snapshot;
        client.frames++;
      } catch (error) { errors.push(`${name} observed protocol: ${String(error)}`); }
    });
    await page.goto(base);
    assert.equal(await page.title(), 'rxjs-flow Todos');
    assert.match(await page.evaluate(() => EventSource.toString()), /native code/);
    await live(client);
    assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).count(), 1);
    return client;
  }

  async function live(client) {
    await client.page.waitForFunction(() => document.querySelector('#connection-state')?.getAttribute('data-state') === 'live', null, { timeout: 25_000 });
  }
  async function stale(client) {
    await client.page.waitForFunction(() => document.querySelector('#connection-state')?.getAttribute('data-state') === 'stale', null, { timeout: 10_000 });
    assert.match(await client.page.locator('#connection-detail').textContent(), /last confirmed list/);
  }
  function row(client, title) {
    return client.page.locator('#todo-list li').filter({ has: client.page.locator('span', { hasText: title }) });
  }
  async function present(client, title, expected = true) {
    await client.page.waitForFunction(({ title, expected }) => {
      const matches = [...document.querySelectorAll('#todo-list li > span')].filter(node => node.textContent === title);
      return matches.length === (expected ? 1 : 0);
    }, { title, expected }, { timeout: 10_000 });
  }
  async function settled(client) {
    await client.page.waitForFunction(() => document.querySelector('#pending-msg')?.textContent === 'All changes settled', null, { timeout: 10_000 });
  }
  async function save(client, title) {
    await client.page.getByLabel('New task').fill(title);
    await client.page.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(client);
    await Promise.all(clients.filter(value => value !== offlineClient).map(value => present(value, title)));
  }
  let offlineClient;

  try {
    const a = await mount('A');
    const b = await mount('B');
    assert.equal(a.streamRequests, 1, 'One connection for all mounted A view consumers');
    assert.equal(b.streamRequests, 1, 'One connection for all mounted B view consumers');
    assert.deepEqual(a.latest, b.latest, 'Independent pages start with one committed collection');

    await save(a, 'Shared task from A');
    await save(b, 'Temporary task from B');
    const retainedRow = await row(a, 'Shared task from A').elementHandle();
    await a.page.getByLabel('New task').fill('An unfinished draft stays here');
    await a.page.getByLabel('New task').evaluate(input => input.setSelectionRange(3, 13));
    await row(b, 'Shared task from A').getByRole('checkbox').check();
    await settled(b);
    await a.page.waitForFunction(() => document.querySelector('#todo-list li input')?.checked === true);
    assert.equal(await retainedRow.evaluate(node => node === document.querySelector('#todo-list li')), true, 'Live updates retain keyed rows');
    assert.deepEqual(await a.page.getByLabel('New task').evaluate(input => ({
      value: input.value, focused: document.activeElement === input, selection: [input.selectionStart, input.selectionEnd],
    })), { value: 'An unfinished draft stays here', focused: true, selection: [3, 13] });
    await row(b, 'Temporary task from B').getByRole('button').click();
    await settled(b);
    await Promise.all([present(a, 'Temporary task from B', false), present(b, 'Temporary task from B', false)]);
    for (const client of clients) assert.equal(await client.page.locator('#todo-list li').count(), 1, 'Each accepted mutation appears once in the collection');
    assert.deepEqual(mutationRequests.map(value => value.method), ['POST', 'POST', 'PUT', 'DELETE']);
    assert.deepEqual(acceptedMutations.map(value => value.status), [201, 201, 200, 204]);
    assert.deepEqual(a.latest, b.latest);

    const beforeManual = { a: a.streamRequests, b: b.streamRequests };
    await a.page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await live(a);
    assert.equal(a.streamRequests, beforeManual.a + 1);
    assert.equal(b.streamRequests, beforeManual.b, 'Reconnecting A leaves B connected');

    offlineClient = a;
    await a.context.setOffline(true);
    // Chromium's offline emulation can leave an existing SSE socket alive.
    // Reconnect explicitly releases that socket; the new attempt then fails
    // against the offline network. Server shutdown below independently tests
    // interruption of an already-open transport without a user action.
    await a.page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await stale(a);
    const disconnectedFrames = a.frames;
    await save(b, 'Saved while A was offline');
    assert.equal(await row(a, 'Saved while A was offline').count(), 0);
    assert.equal(a.frames, disconnectedFrames, 'Offline A receives no new snapshot');
    assert.equal(await row(a, 'Shared task from A').count(), 1, 'Stale A retains its last confirmed collection');
    await a.context.setOffline(false);
    offlineClient = undefined;
    await live(a);
    await present(a, 'Saved while A was offline');
    assert.deepEqual(a.latest, b.latest, 'Automatic reconnect supplies the complete current snapshot');

    const beforeRestart = structuredClone(b.latest);
    await stop();
    await Promise.all([stale(a), stale(b)]);
    await start();
    await Promise.all([live(a), live(b)]);
    assert.deepEqual(a.latest, beforeRestart, 'Ordinary process restart retains generation, revision and collection');
    assert.deepEqual(b.latest, beforeRestart);
    await save(b, 'Live after server restart');
    assert.equal(a.latest.stateGeneration, beforeRestart.stateGeneration);
    assert.ok(a.latest.revision > beforeRestart.revision);
    assert.deepEqual(a.latest, b.latest);
    assert.equal(a.latest.todos.length, 3);
    assert.equal(new Set(a.latest.todos.map(todo => todo.id)).size, 3);
    assert.deepEqual(mutationRequests.map(value => value.method), ['POST', 'POST', 'PUT', 'DELETE', 'POST', 'POST']);
    assert.equal(acceptedMutations.length, 6, 'No automatic replay of writes after disconnect or restart');
    assert.equal(finiteListReads, 0, 'Live application does not race finite GET against snapshots');
    if (process.env.M06_SCREENSHOT) await a.page.screenshot({ path: process.env.M06_SCREENSHOT, fullPage: true });
    const result = {
      check: 'two actual browser Todo applications', browser: browser.version(), builtWorkerAndAssets: true,
      independentBrowserContexts: 2, nativeEventSource: true, livePath: '/api/todos/live',
      mutationRequests, acceptedMutations, noFiniteListReads: true, noDuplicateRows: true,
      keyedRowIdentityPreserved: true, draftFocusAndSelectionPreserved: true,
      manualReconnectIsolated: true, reconnectWhileOfflineShowsStaleCollection: true,
      offlineCommitRecoveredAutomatically: true, fullRuntimeRestart: true, persistedHistoryRetained: true,
      automaticWriteReplay: false, finalTodoCount: a.latest.todos.length,
      streamRequests: { a: a.streamRequests, b: b.streamRequests }, snapshotCounts: { a: a.frames, b: b.frames },
      uncaughtBrowserErrors: errors.length,
    };
    assert.deepEqual(errors, [], 'No uncaught browser or observed protocol errors');
    // Close mounted pages first, then let the browser owner close its contexts.
    // This also supports callers using Chromium's single-process launch mode.
    for (const client of clients) await client.page.close();
    await browser.close();
    checks.push({ ...result, finalMountedPagesClosed: true, finalBrowserContextsClosed: true });
  } finally {
    await browser.close();
  }
} });
