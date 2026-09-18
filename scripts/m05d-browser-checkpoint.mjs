import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runM05dCheckpoint } from './m05d-checkpoint.mjs';

// Optional real-browser checkpoint using tools already installed by the caller.
// No Playwright/browser dependency is added to the application or normal CI.
// Build first. Supply an absolute Playwright entry path; Chromium executable,
// extra launch arguments (JSON array), and screenshot output are optional.
assert.equal(process.argv.length, 2, 'Usage: node scripts/m05d-browser-checkpoint.mjs');
assert.ok(process.env.PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH to an installed Playwright module entry');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const browserArguments = JSON.parse(process.env.M05D_CHROMIUM_ARGS ?? '[]');
assert.ok(Array.isArray(browserArguments) && browserArguments.every(value => typeof value === 'string'),
  'M05D_CHROMIUM_ARGS must be a JSON array of browser arguments');
await runM05dCheckpoint({ development: false, browserCheck: async ({ base, checks, stop, start }) => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true, args: browserArguments,
  });
  const errors = [];
  let streamRequests = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/todos/stream') streamRequests++; });
    await page.goto(new URL('/m05d-live.html', base).href);
    assert.equal(await page.title(), 'rxjs-flow · Live connection checkpoint');
    assert.match(await page.evaluate(() => EventSource.toString()), /native code/);
    const panel = name => page.locator(`[data-consumer="${name}"]`);
    async function waitSnapshot(name, title) {
      await page.waitForFunction(({ name, title }) => document.querySelector(`[data-consumer="${name}"] [data-snapshot]`).textContent.includes(title), { name, title }, { timeout: 10_000 });
    }
    async function count(name) { return Number(await panel(name).locator('[data-count]').textContent()); }
    async function save(title) {
      await page.getByLabel('Save a Todo to this local collection').fill(title);
      await page.getByRole('button', { name: 'Save Todo', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#write-status').textContent.startsWith('Saved.'), null, { timeout: 10_000 });
    }
    await page.getByRole('button', { name: 'Connect A', exact: true }).click();
    await page.getByRole('button', { name: 'Connect B', exact: true }).click();
    await waitSnapshot('a', 'M05d stream continues after restart');
    await waitSnapshot('b', 'M05d stream continues after restart');
    await save('Browser update received by A and B');
    await waitSnapshot('a', 'Browser update received by A and B');
    await waitSnapshot('b', 'Browser update received by A and B');
    await page.getByRole('button', { name: 'Disconnect A', exact: true }).click();
    const disconnectedCount = await count('a');
    await save('Browser update while A is disconnected');
    await waitSnapshot('b', 'Browser update while A is disconnected');
    assert.equal(await count('a'), disconnectedCount);
    assert.equal(await panel('a').locator('[data-status]').textContent(), 'Disconnected');
    await page.getByRole('button', { name: 'Connect A', exact: true }).click();
    await waitSnapshot('a', 'Browser update while A is disconnected');
    assert.equal(await count('a'), disconnectedCount + 1, 'Fresh initial snapshot on new browser connection');
    const persistedSnapshot = await panel('a').locator('[data-snapshot]').textContent();
    if (process.env.M05D_SCREENSHOT) await page.screenshot({ path: process.env.M05D_SCREENSHOT, fullPage: true });
    await stop();
    for (const name of ['a', 'b']) await page.waitForFunction(name => document.querySelector(`[data-consumer="${name}"] [data-status]`).textContent.startsWith('Connection interrupted'), name, { timeout: 10_000 });
    assert.ok(await page.getByRole('button', { name: 'Connect A', exact: true }).isEnabled());
    assert.ok(await page.getByRole('button', { name: 'Connect B', exact: true }).isEnabled());
    await start();
    await page.getByRole('button', { name: 'Connect A', exact: true }).click();
    await page.getByRole('button', { name: 'Connect B', exact: true }).click();
    await waitSnapshot('a', 'Browser update while A is disconnected');
    await waitSnapshot('b', 'Browser update while A is disconnected');
    for (const name of ['a', 'b']) {
      await page.waitForFunction(name => document.querySelector(`[data-consumer="${name}"] [data-status]`).textContent.startsWith('Connected ·'), name, { timeout: 10_000 });
      assert.equal(await panel(name).locator('[data-snapshot]').textContent(), persistedSnapshot);
    }
    await save('Browser live update after full runtime restart');
    await waitSnapshot('a', 'Browser live update after full runtime restart');
    await waitSnapshot('b', 'Browser live update after full runtime restart');
    const eventCounts = { a: await count('a'), b: await count('b') };
    assert.equal(streamRequests, 5, 'Two initial, one reconnect, two after restart; no automatic retries');
    await page.getByRole('button', { name: 'Disconnect A', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect B', exact: true }).click();
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    checks.push({ check: 'actual browser native EventSource', browser: browser.version(),
      builtWorkerAndAssets: true, twoSimultaneousConsumers: true, mutationViaVisibleForm: true,
      disconnectedConsumerStops: true, otherConsumerContinues: true, freshReconnectSnapshot: true,
      fullProcessInterruptionVisible: true, persistedSnapshotRecovered: true, liveCommitAfterRestart: true,
      streamRequests, eventCounts, uncaughtBrowserErrors: errors.length, finalPanelsDisconnected: true,
    });
    await page.close();
  } finally { await browser.close(); }
} });
