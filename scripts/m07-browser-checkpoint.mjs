import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { runWorkerSmoke } from './smoke-worker.mjs';

// Optional real-browser acceptance. Install the browser tools outside this
// project; the application and normal CI do not acquire browser dependencies.
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.every(argument => argument === '--dev'),
  'Usage: node scripts/m07-browser-checkpoint.mjs [--dev]');
assert.ok(process.env.PLAYWRIGHT_MODULE_PATH,
  'Set PLAYWRIGHT_MODULE_PATH to an installed Playwright module entry');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const browserArguments = JSON.parse(process.env.M07_CHROMIUM_ARGS ?? '[]');
assert.ok(Array.isArray(browserArguments) && browserArguments.every(value => typeof value === 'string'),
  'M07_CHROMIUM_ARGS must be a JSON array of browser arguments');
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
  const timeoutOwner = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(timeout, undefined, { signal: timeoutOwner.signal }).then(() => {
        throw new Error(`Timed out: ${description}`);
      }),
    ]);
  } finally { timeoutOwner.abort(); }
}

await runWorkerSmoke({ development, checkpoint: async ({ base, checks, stop, start }) => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true, args: browserArguments,
  });
  const clients = [];
  const errors = [];
  const requests = [];
  const responses = [];
  const heldResponses = [];
  let finiteListReads = 0;
  let offlineClient;
  let phase = 'mount and validation';
  let releasedDomListeners = 0;

  async function mount(name) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
    const page = await context.newPage();
    const client = {
      name, context, page, streamRequests: 0, frames: 0, latest: undefined,
      activeStreams: new Set(), activeMutations: new Set(), host: undefined, navigations: 0, transportEvents: [],
      requestLoaders: new Map(), documentLoader: undefined,
    };
    clients.push(client);
    page.on('pageerror', error => errors.push(`${name}: ${String(error)}`));
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        client.navigations++;
        client.transportEvents.push({ type: 'navigation', url: frame.url() });
      }
    });
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/todos/live') client.streamRequests++;
      if (path.startsWith('/api/todos') && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
        requests.push({ client: name, method: request.method(), path });
      }
      if (path === '/api/todos' && request.method() === 'GET') finiteListReads++;
    });
    page.on('response', response => {
      const request = response.request();
      if (new URL(request.url()).pathname.startsWith('/api/todos')
        && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
        responses.push({ client: name, method: request.method(), status: response.status() });
      }
    });
    // Passive CDP observation neither replaces EventSource nor subscribes to
    // application effects. Its resource census covers browser requests only.
    const devtools = await context.newCDPSession(page);
    client.devtools = devtools;
    await devtools.send('Network.enable');
    await devtools.send('Page.enable');
    devtools.on('Page.frameNavigated', event => {
      if (event.frame.parentId) return;
      client.documentLoader = event.frame.loaderId;
      client.transportEvents.push({ type: 'document', loader: client.documentLoader });
    });
    devtools.on('Network.requestWillBeSent', event => {
      const path = new URL(event.request.url).pathname;
      if (path.startsWith('/api/todos')) client.requestLoaders.set(event.requestId, event.loaderId);
      if (path === '/api/todos/live') {
        client.activeStreams.add(event.requestId);
        client.transportEvents.push({ type: 'start', id: event.requestId, loader: event.loaderId });
      }
      if (path.startsWith('/api/todos') && ['POST', 'PUT', 'DELETE'].includes(event.request.method)) {
        client.activeMutations.add(event.requestId);
      }
    });
    function requestEnded(event) {
      if (client.activeStreams.has(event.requestId)) {
        client.transportEvents.push({ type: 'end', id: event.requestId, error: event.errorText });
      }
      client.activeStreams.delete(event.requestId);
      client.activeMutations.delete(event.requestId);
    }
    devtools.on('Network.loadingFinished', requestEnded);
    devtools.on('Network.loadingFailed', requestEnded);
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
    await waitFor(() => client.latest !== undefined, `${name} initial native snapshot`);
    return client;
  }

  async function live(client) {
    await client.page.waitForFunction(() =>
      document.querySelector('#connection-state')?.getAttribute('data-state') === 'live',
    null, { timeout: 25_000 });
  }
  async function stale(client) {
    await client.page.waitForFunction(() =>
      document.querySelector('#connection-state')?.getAttribute('data-state') === 'stale',
    null, { timeout: 10_000 });
    assert.match(await client.page.locator('#connection-detail').textContent(), /last confirmed list/);
  }
  async function retryWaiting(client) {
    await stale(client);
    await client.page.waitForFunction(() =>
      /Retry \d+ in [\d.]+ s\./.test(document.querySelector('#connection-detail')?.textContent ?? ''),
    null, { timeout: 10_000 });
  }
  function row(client, title) {
    return client.page.locator('#todo-list li').filter({
      has: client.page.locator('span', { hasText: new RegExp(`^${title}$`) }),
    });
  }
  async function present(client, title, expected = true) {
    await client.page.waitForFunction(({ title, expected }) => {
      const matches = [...document.querySelectorAll('#todo-list li > span')]
        .filter(node => node.textContent === title);
      return matches.length === (expected ? 1 : 0);
    }, { title, expected }, { timeout: 10_000 });
  }
  async function settled(client) {
    await client.page.waitForFunction(() =>
      document.querySelector('#pending-msg')?.textContent === 'All changes settled',
    null, { timeout: 10_000 });
  }
  async function save(client, title) {
    await client.page.getByLabel('New task', { exact: true }).fill(title);
    await client.page.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(client);
    await Promise.all(clients.filter(value => value !== offlineClient).map(value => present(value, title)));
  }
  async function filter(client, name) {
    const control = client.page.getByRole('radio', { name, exact: true });
    await client.page.locator('label').filter({ has: control }).click();
    assert.equal(await client.page.getByRole('radio', { name, exact: true }).isChecked(), true);
  }
  async function draft(client, value, selection) {
    const input = client.page.getByLabel('New task', { exact: true });
    await input.fill(value);
    if (selection) await input.evaluate((node, range) => node.setSelectionRange(...range), selection);
  }
  async function assertDraft(client, value, selection) {
    const actual = await client.page.getByLabel('New task', { exact: true }).evaluate(input => ({
      value: input.value, focused: document.activeElement === input,
      selection: [input.selectionStart, input.selectionEnd],
    }));
    assert.equal(actual.value, value);
    if (selection) assert.deepEqual(actual, { value, focused: true, selection });
  }

  async function holdAcceptedCreate(client) {
    const forwarded = deferred();
    const release = deferred();
    const finished = deferred();
    let canceled = false;
    const owner = { forwarded: forwarded.promise, release: release.resolve, finished: finished.promise,
      markCanceled: () => { canceled = true; } };
    heldResponses.push(owner);
    await client.page.route('**/api/todos', async route => {
      try {
        assert.equal(route.request().method(), 'POST');
        // This is a real Hono/DO commit. Only delivery of its finite HTTP reply
        // is delayed; the native live connection receives committed snapshots.
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        forwarded.resolve(await response.json());
        await release.promise;
        try { await route.fulfill({ response }); }
        catch (error) { if (!canceled) throw error; }
      } catch (error) { errors.push(`${client.name} held response: ${String(error)}`); }
      finally { finished.resolve(); }
    }, { times: 1 });
    return owner;
  }

  async function importHost(client) {
    // Import the same already-executed ESM entry used by this actual page.
    // The public host handle is exported in dev and built modes. No production
    // global, custom endpoint or lifecycle control is added for this script.
    client.host = await client.page.evaluateHandle(async entry => {
      const module = await import(entry);
      if (!module.app || typeof module.mountTodoApp !== 'function') {
        throw new Error('Application entry must export its host handle and mountTodoApp');
      }
      const host = { module, current: module.app, completions: 0, observers: [] };
      for (const stream of [host.current.state$, host.current.viewModel$, host.current.transitions$]) {
        host.observers.push(stream.subscribe({ complete: () => { host.completions++; } }));
      }
      return host;
    }, hostEntry);
  }
  function currentRequests(client, requests) {
    return [...requests].filter(id => client.requestLoaders.get(id) === client.documentLoader);
  }
  function retiredRequests(client) {
    // Chromium can omit Network.loadingFailed for an in-flight request from
    // a document replaced by Vite HMR. Preserve that missing observation in the
    // report instead of attributing it to the newly mounted program.
    return [...client.activeStreams].filter(id => client.requestLoaders.get(id) !== client.documentLoader)
      .map(id => ({ requestId: id, loaderId: client.requestLoaders.get(id),
        disposition: 'document replaced; no terminal CDP request event observed' }));
  }
  async function dispose(client) {
    const listenerTargets = [];
    // Read the actual browser listener registry for existing native controls,
    // retaining row references across removal. No application hooks are used.
    for (const [selector, expectedTypes] of [
      ['#add-form', ['submit']], ['#title-input', ['input', 'blur']],
      ['#refresh-todos', ['click']], ['#filter-all', ['change']],
      ['#filter-active', ['change']], ['#filter-completed', ['change']],
      ['#todo-list li input', ['change']], ['#todo-list li button', ['click']],
    ]) {
      const { result } = await client.devtools.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`, objectGroup: 'm07-listener-census',
      });
      assert.ok(result.objectId, `${selector}: mounted control exists`);
      const { listeners } = await client.devtools.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      assert.deepEqual(listeners.map(listener => listener.type).sort(), expectedTypes.toSorted(),
        `${selector}: only the expected application source listeners are attached`);
      listenerTargets.push({ objectId: result.objectId, selector, before: listeners.length });
    }
    await client.host.evaluate(host => {
      host.oldForm = document.querySelector('#add-form');
      host.oldRowButton = document.querySelector('#todo-list li button');
      host.current.dispose();
    });
    for (const target of listenerTargets) {
      const { listeners } = await client.devtools.send('DOMDebugger.getEventListeners', { objectId: target.objectId });
      assert.equal(listeners.length, 0, `${target.selector}: disposal removes actual native listeners`);
      releasedDomListeners += target.before;
    }
    await client.devtools.send('Runtime.releaseObjectGroup', { objectGroup: 'm07-listener-census' });
    await waitFor(() => currentRequests(client, client.activeStreams).length === 0,
      `${client.name} disposed current-document SSE requests closed`);
    await waitFor(() => currentRequests(client, client.activeMutations).length === 0,
      `${client.name} disposed current-document finite requests closed`);
  }
  async function remount(client) {
    const previousConnections = client.streamRequests;
    await client.host.evaluate(host => { host.current = host.module.mountTodoApp(document); });
    await live(client);
    assert.equal(client.streamRequests, previousConnections + 1, 'Remount opens exactly one fresh connection');
    assert.equal(currentRequests(client, client.activeStreams).length, 1);
  }

  try {
    const a = await mount('A');
    const b = await mount('B');
    assert.equal(a.streamRequests, 1);
    assert.equal(b.streamRequests, 1);
    assert.deepEqual(a.latest, b.latest);
    assert.match(await a.page.locator('#empty-state').textContent(), /list is clear/);

    const beforeInvalid = requests.length;
    await draft(a, '   ');
    await a.page.getByRole('heading', { name: 'Today’s list' }).click();
    assert.equal(await a.page.getByRole('button', { name: 'Add', exact: true }).isDisabled(), true);
    assert.equal(await a.page.locator('#title-input').getAttribute('aria-invalid'), 'true');
    assert.equal(await a.page.locator('#title-input').getAttribute('aria-describedby'), 'title-hint');
    assert.match(await a.page.locator('#title-hint').textContent(), /Enter a task title/);
    assert.equal(requests.length, beforeInvalid, 'Invalid draft never starts an HTTP write');

    phase = 'CRUD, targeted rendering and filters';
    await save(a, 'Shared task from A');
    await save(b, 'Temporary task from B');
    const retainedRow = await row(a, 'Shared task from A').elementHandle();
    await draft(a, 'A draft stays focused', [2, 11]);
    await row(b, 'Shared task from A').getByRole('checkbox').check();
    await settled(b);
    await waitFor(() => a.latest.todos.find(todo => todo.title === 'Shared task from A')?.completed,
      'A observes B toggle snapshot');
    assert.equal(await retainedRow.evaluate(node => node === document.querySelector('#todo-list li')), true);
    await assertDraft(a, 'A draft stays focused', [2, 11]);
    const beforeFilter = { requests: requests.length, streams: a.streamRequests };
    await filter(a, 'Completed');
    await present(a, 'Shared task from A');
    await present(a, 'Temporary task from B', false);
    assert.equal(await a.page.locator('#todo-list li').count(), 1);
    await filter(a, 'Active');
    await present(a, 'Temporary task from B');
    await present(a, 'Shared task from A', false);
    await row(b, 'Temporary task from B').getByRole('button').click();
    await settled(b);
    await present(a, 'Temporary task from B', false);
    assert.match(await a.page.locator('#filtered-empty-state').textContent(), /No active tasks/);
    assert.equal(await a.page.locator('#empty-state').textContent(), '');
    assert.equal(requests.length, beforeFilter.requests + 1, 'Filtering adds no HTTP request');
    assert.equal(a.streamRequests, beforeFilter.streams, 'Filtering adds no live connection');
    await filter(a, 'All');
    await present(a, 'Shared task from A');

    phase = 'accepted reply and newer draft';
    const delayed = await holdAcceptedCreate(a);
    await draft(a, 'Submitted before a newer draft');
    await a.page.getByRole('button', { name: 'Add', exact: true }).click();
    await within(delayed.forwarded, 'accepted delayed HTTP reply');
    await Promise.all([present(a, 'Submitted before a newer draft'), present(b, 'Submitted before a newer draft')]);
    assert.equal(await a.page.locator('#add-form').getAttribute('aria-busy'), 'true');
    assert.equal(await a.page.getByRole('button', { name: 'Adding…', exact: true }).isDisabled(), true);
    assert.equal(await a.page.locator('#title-input').isEnabled(), true);
    await draft(a, 'Newer text while saving', [3, 9]);
    await row(b, 'Shared task from A').getByRole('checkbox').uncheck();
    await settled(b);
    delayed.release();
    await within(delayed.finished, 'delivery of delayed HTTP reply');
    await settled(a);
    await assertDraft(a, 'Newer text while saving', [3, 9]);

    phase = 'accepted reply and newer same-text edit';
    const sameText = await holdAcceptedCreate(a);
    await draft(a, 'Same text with a newer edit');
    await a.page.getByRole('button', { name: 'Add', exact: true }).click();
    await within(sameText.forwarded, 'accepted same-text HTTP reply');
    await draft(a, 'An intervening edit');
    await draft(a, 'Same text with a newer edit', [4, 12]);
    sameText.release();
    await within(sameText.finished, 'delivery of same-text HTTP reply');
    await settled(a);
    await assertDraft(a, 'Same text with a newer edit', [4, 12]);
    await Promise.all([present(a, 'Same text with a newer edit'), present(b, 'Same text with a newer edit')]);

    phase = 'authoritative server rejection and deliberate recovery';
    let serverValidationStatus;
    await a.page.route('**/api/todos', async route => {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(JSON.parse(route.request().postData()), { title: 'Recover after server rejection' });
      // Deliberate harness mutation bypasses pure client validation. The actual
      // Hono endpoint and shared server schema authoritatively reject the body.
      const response = await route.fetch({ postData: JSON.stringify({ title: '' }) });
      serverValidationStatus = response.status();
      await route.fulfill({ response });
    }, { times: 1 });
    const beforeFailure = { requests: requests.length, snapshot: structuredClone(a.latest) };
    await draft(a, 'Recover after server rejection');
    await a.page.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(a);
    assert.equal(serverValidationStatus, 422);
    assert.ok((await a.page.locator('#error-msg').textContent()).length > 0);
    assert.match(await a.page.locator('#error-recovery').textContent(), /reject|correct|review/i);
    await assertDraft(a, 'Recover after server rejection');
    assert.deepEqual(a.latest, beforeFailure.snapshot, 'Rejected mutation publishes no committed snapshot');
    assert.equal(requests.length, beforeFailure.requests + 1, 'Rejected mutation is not automatically replayed');
    await a.page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
    assert.equal(await a.page.locator('#error-msg').textContent(), '');
    await assertDraft(a, 'Recover after server rejection');
    await a.page.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(a);
    await Promise.all([present(a, 'Recover after server rejection'), present(b, 'Recover after server rejection')]);
    await assertDraft(a, '');

    phase = 'offline recovery';
    offlineClient = a;
    await a.context.setOffline(true);
    // Offline emulation can leave established SSE sockets alive. Reconnect
    // closes the previous socket and opens a real failed network attempt.
    await a.page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await retryWaiting(a);
    const disconnectedFrames = a.frames;
    await save(b, 'Saved while A was offline');
    assert.equal(a.frames, disconnectedFrames);
    await present(a, 'Saved while A was offline', false);
    await a.context.setOffline(false);
    offlineClient = undefined;
    await live(a);
    await present(a, 'Saved while A was offline');
    assert.deepEqual(a.latest, b.latest);

    phase = 'full authority runtime reconstruction';
    const beforeRestart = structuredClone(b.latest);
    const beforeRestartNavigations = { a: a.navigations, b: b.navigations };
    await stop();
    await Promise.all([stale(a), stale(b)]);
    // Vite's development host may reload a document when its HMR socket finds
    // the restarted server. Settle that host action before importing handles.
    // Built mode has no HMR and independently proves SSE-only recovery.
    const hostReloads = development ? clients.map(client => client.page.waitForEvent('framenavigated', {
      predicate: frame => frame === client.page.mainFrame(), timeout: 8_000,
    }).then(() => true, () => false)) : [];
    await start();
    const devHostReloads = await Promise.all(hostReloads);
    await Promise.all([live(a), live(b)]);
    if (!development) {
      assert.deepEqual({ a: a.navigations, b: b.navigations }, beforeRestartNavigations,
        'Built app recovers through SSE without a document reload');
    }
    assert.deepEqual(a.latest, beforeRestart, 'Full local runtime restart preserves durable history');
    assert.deepEqual(b.latest, beforeRestart);
    await save(b, 'Live after authority reconstruction');
    assert.equal(a.latest.stateGeneration, beforeRestart.stateGeneration);
    assert.ok(a.latest.revision > beforeRestart.revision);

    phase = 'public host ownership and retry disposal';
    const beforeConsumers = a.streamRequests;
    await importHost(a);
    await importHost(b);
    assert.equal(a.streamRequests, beforeConsumers, 'Extra state/view/transition consumers do not repeat effects');
    offlineClient = a;
    // Fail one real native request while leaving the development HMR host
    // online. An unrelated host reload must not masquerade as app remount.
    await a.page.route('**/api/todos/live', route => route.abort('failed'), { times: 1 });
    await a.page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await retryWaiting(a);
    await dispose(a);
    assert.deepEqual(await a.host.evaluate(host => ({
      completions: host.completions, closed: host.observers.every(subscription => subscription.closed),
    })), { completions: 3, closed: true });
    const afterDisposal = { requests: requests.length, streams: a.streamRequests, frames: a.frames };
    await a.host.evaluate(host => {
      document.querySelector('#title-input').value = 'A former control must not submit';
      host.oldForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      host.oldRowButton?.click();
    });
    // Real browser timers are intentionally observed across the pending first
    // retry deadline. Scheduler-controlled cancellation is tested separately.
    await delay(1_250);
    assert.equal(a.streamRequests, afterDisposal.streams, 'Disposed retry opens no later connection');
    assert.equal(requests.length, afterDisposal.requests, 'Disposed DOM controls emit no operation');
    await save(b, 'Saved while A was unmounted');
    assert.equal(a.frames, afterDisposal.frames);
    await remount(a);
    offlineClient = undefined;
    await present(a, 'Saved while A was unmounted');
    assert.deepEqual(a.latest, b.latest);

    phase = 'finite request cancellation and remount';
    const canceled = await holdAcceptedCreate(a);
    await draft(a, 'Committed before local cancellation');
    await a.page.getByRole('button', { name: 'Add', exact: true }).click();
    await within(canceled.forwarded, 'accepted reply before cancellation');
    await present(b, 'Committed before local cancellation');
    canceled.markCanceled();
    await dispose(a);
    canceled.release();
    await within(canceled.finished, 'release of canceled HTTP reply');
    await remount(a);
    await present(a, 'Committed before local cancellation');
    assert.deepEqual(a.latest, b.latest, 'Local HTTP cancellation does not roll back an accepted commit');

    phase = 'final convergence and cleanup';
    for (const client of clients) {
      assert.equal(await client.page.locator('#todo-list li').count(), client.latest.todos.length);
      assert.equal(new Set(client.latest.todos.map(todo => todo.id)).size, client.latest.todos.length);
    }
    assert.equal(finiteListReads, 0, 'Mounted live app never starts a competing finite list read');
    assert.deepEqual(errors, [], 'No uncaught browser or observed protocol errors');
    if (process.env.M07_SCREENSHOT) {
      await a.page.screenshot({ path: process.env.M07_SCREENSHOT, fullPage: true });
    }
    const result = {
      check: 'complete reference application in two actual browser contexts',
      mode: development ? 'Vite Cloudflare development' : 'built assets with local Wrangler',
      browser: browser.version(), nativeEventSource: true, livePath: '/api/todos/live',
      domIntentThroughRealHonoAuthorityAndSnapshot: true, independentBrowserContexts: 2,
      invalidDraftStartsNoWrite: true, accessibleValidation: true,
      filtersStartNoRequestsOrConnections: true, filteredEmptyDistinctFromCollectionEmpty: true,
      targetedRowIdentityPreserved: true, inputFocusAndSelectionPreserved: true,
      newerDraftPreservedAfterAcceptedReply: true, newerSameTextEditPreservedAfterAcceptedReply: true,
      actualServerValidationStatus: serverValidationStatus, deliberateFailureRecovery: true,
      harnessOverrides: ['hold actual committed HTTP 201 reply', 'forward invalid POST body to actual server for HTTP 422',
        'abort one native reconnect request before disposing its pending retry'],
      offlineReconnectRecovery: true, unsolicitedServerInterruption: true,
      fullRuntimeRestart: true, persistedHistoryRetained: true,
      devHostReloads, documentNavigations: { a: a.navigations, b: b.navigations },
      builtRestartWithoutNavigation: !development,
      extraConsumersRepeatNoEffects: true, disposeCompletesOwnedStreams: true,
      disposedDomControlsInert: true, actualNativeDomListenersRemoved: true, unmountCancelsPendingRetry: true,
      unmountCancelsFiniteRequestAndSse: true, remountReadsCurrentCommittedState: true,
      localCancellationIsNotRollback: true, noFiniteListReads: true, noDuplicateRows: true,
      mutationRequests: requests, mutationResponses: responses,
      finalTodoCount: a.latest.todos.length,
      streamRequests: { a: a.streamRequests, b: b.streamRequests },
      snapshotCounts: { a: a.frames, b: b.frames }, uncaughtBrowserErrors: errors.length,
    };
    await Promise.all(clients.map(dispose));
    assert.ok(clients.every(client => currentRequests(client, client.activeStreams).length === 0
      && currentRequests(client, client.activeMutations).length === 0));
    const replacedDocumentRequestsWithoutTerminalEvent = {
      a: retiredRequests(a), b: retiredRequests(b),
    };
    if (!development) {
      assert.deepEqual(replacedDocumentRequestsWithoutTerminalEvent, { a: [], b: [] });
      assert.ok(clients.every(client => client.activeStreams.size === 0 && client.activeMutations.size === 0));
    }
    // Closing contexts in parallel crashes callers using single-process
    // Chromium; pages close first and the browser owner releases contexts.
    for (const client of clients) await client.page.close();
    await browser.close();
    checks.push({ ...result, releasedDomListeners, finalCurrentDocumentRequests: 0,
      replacedDocumentRequestsWithoutTerminalEvent,
      finalMountedPagesClosed: true, finalBrowserContextsClosed: true });
  } catch (error) {
    console.error(JSON.stringify({ browserCheckpointPhase: phase, error: error.stack ?? String(error), errors,
      clients: clients.map(client => ({ name: client.name, activeStreams: [...client.activeStreams],
        activeMutations: [...client.activeMutations], transportEvents: client.transportEvents })),
    }, null, 2));
    throw error;
  } finally {
    for (const held of heldResponses) held.release();
    await browser.close();
  }
} });
