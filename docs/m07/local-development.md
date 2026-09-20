# M07 — Run the complete reference Todo application

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.

The reference application combines local filtering, draft validation, pending
operation feedback and live synchronization. Two pages share the saved Todo
collection; each page keeps its own draft and filter. Its live connection supplies
the current collection without requiring Refresh.

## Start development mode

Use Node **22.22.1**. While the milestone PR is under review:

```bash
git fetch origin
git switch m07/reference-app
npm ci
npm run dev:worker
```

After merge, use updated `main` instead. Open **http://localhost:5174** in two
browser tabs. This starts the browser page, Hono API and local Durable Object
runtime together; no separate Node backend or Cloudflare login is needed.

1. Wait until both pages say **Live**. A complete committed snapshot loads the
   collection; an initially empty collection has its own empty-state message.
2. Add a Todo in tab A. Both tabs receive the saved item without Refresh.
3. Toggle the item in tab B. Select **Active**, **Completed** and **All** to see
   the local projection change. Filtering sends no mutation or reload request.
   Summary counts still describe the full collection; a filter with no matching
   items has its own message and does not imply the saved collection is empty.
4. Start typing another Todo in A while B changes an existing item. The draft,
   focus and selection stay with the input. While a create is pending, Add is
   busy/disabled and the input remains editable for the next draft.
5. Leave the title blank or enter only spaces and leave the field. Validation
   explains the required input. Correct it and submit; server validation still
   applies to the actual request.
6. Delete a Todo and confirm both pages converge. Operation failure leaves a
   visible explanation and allows another corrected intent; it does not silently
   retry a write. **Dismiss message** clears the feedback when you have read it.

When a create succeeds, only its captured draft is cleared. Text entered later
is retained, including text changed away from and back to the submitted title.
The app tracks the draft revision, so identical text does not imply identical
input history.

## Try interruption and recovery

1. Keep a Todo saved, then stop `npm run dev:worker`.
2. Each page keeps its last confirmed collection and reports interrupted/live
   recovery status. Its saved collection is distinct from an unsent draft.
3. Restart the same command from the same checkout. An automatic retry receives
   the persisted snapshot. If retries have ended, press **Reconnect**.
4. Save another item and confirm both pages receive it.

Automatic retry delays are **1, 2, 4 and 8 seconds**. Each new connection has
**10 seconds** to supply its first validated snapshot. A valid snapshot resets
the consecutive-failure budget. Protocol failure or exhausted retries requires
manual Reconnect. The previous EventSource closes before a replacement starts.

Closing a tab releases that app's connection, listeners and pending retries.
Another tab and the saved collection continue. There is no heartbeat or fixed
detection deadline for a silent partition after synchronization; recovery begins
when the browser reports transport failure or you press Reconnect.

A failed connection does not prove a mutation failed to commit. Check the
resynchronized collection before deliberately submitting again. Reconnect
repairs current state and never automatically replays an uncertain write.

## Run built assets with the local Worker

```bash
npm run build:worker
npx wrangler dev --config dist/rxjs_flow_foundation/wrangler.json --local --var TODO_ACCESS_POLICY:local-loopback --persist-to .wrangler/state --ip 127.0.0.1 --port 4174
```

Open **http://localhost:4174** in two tabs and repeat the scenario. Stop any other
process using that port first. This uses built browser assets and the built
Worker, rather than Vite's Node backend proxy.

Ordinary `npm run preview:worker` retains the checked-in access-disabled
configuration, so Todo routes return 503. The explicit Wrangler command above
enables only local loopback access. Neither command deploys a public service.

The normal local durable collection is stored in SQLite below
`.wrangler/state/v3`. Keep the directory and use the same checkout for a restart.
Drafts and filters belong to each mounted browser app and are not saved in that
collection. The retained `npm run dev:server` / `npm run dev:client` workflow uses
an independent Node in-memory collection; restarting that server loses its data
and establishes a new generation. It does not use the durable collection.

## Inspect the live stream

In Chrome DevTools Network, select `live`; its EventStream view shows
`todo-snapshot` events. The request staying open is expected. Each payload
contains the complete collection plus schema version, collection identity,
generation and revision. A Todo's `createdAt` ending in `Z` represents UTC.

```bash
curl -N http://localhost:5174/api/todos/live
```

Use `curl.exe` in PowerShell if `curl` is an alias. The legacy
**http://localhost:5174/m05d-live.html** diagnostic still uses `/api/todos/stream`
and its bare-array `todos` event. The application uses `/api/todos/live`; neither
endpoint has been silently reinterpreted.

## Repeatable browser verification

The optional checkpoint runs the same complete scenario in two independent
browser contexts. Supply already installed Playwright/Chromium; no browser
package is added to repository dependencies:

```bash
export PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium
node scripts/m07-browser-checkpoint.mjs --dev
npm run build:worker
node scripts/m07-browser-checkpoint.mjs
```

Replace the paths with your installed tooling. `CHROMIUM_EXECUTABLE_PATH` is
optional if Playwright already manages its browser. `M07_CHROMIUM_ARGS` accepts
an optional JSON array of local launch arguments; `M07_SCREENSHOT` selects an
optional screenshot output path. Each run uses isolated temporary persistence,
keeping the normal development collection intact.

Both final runs passed: `browser-dev-final` and `browser-built-final`, using
Playwright **1.62.1** and Chromium **153.0.8010.0**. Each observed 13 DOM mutation
requests: 12 committed operations and one real 422 rejection. The final committed
HTTP reply was canceled locally during unmount; remount recovered the saved item.
Both pages finished with eight unique Todos and no uncaught browser errors.
The scenarios preserved newer and changed-away-and-back drafts, keyed rows,
focus/selection, validation/filter feedback and recoverable operation state.

The browser entry exports its existing `app` handle and `mountTodoApp` through
ordinary ES modules. The checkpoint obtains that already-loaded module, disposes
the app, proves its controls are inert, then mounts a fresh owned instance. The
built manifest identifies the same cached entry so importing it does not mount
an extra app. No product debug controls or global test controller are added.
Across four explicit disposals, native DevTools checks observed 36 DOM listeners
removed and zero final current-document owned requests.

During development server restart, Vite HMR reloaded each page. DevTools retained
one old-document SSE request ID per page without a terminal request event; the
ledger records those identities explicitly. Built mode recovered without page
navigation and had no such retired IDs. Both modes closed all pages and browser
contexts after their final ownership checks. These distinctions are detailed in
the acceptance report; development reload alone is not evidence for every
connection's autonomous recovery.

The script deliberately aborts one reconnect request and waits for its retry
interval before disposal. This isolates unmount-during-retry from Vite HMR.
Full offline and actual server-stop/restart checks remain separate scenarios.
The checked screenshots show the same complete layout in both runtime modes.

The harness observes native EventSource frames and real HTTP outcomes. It can
hold a real accepted reply to test continued typing while the server commit
already reaches other clients, and forward deliberately invalid input to the
real Hono route to verify authoritative validation. These controlled probes are
labelled in the [acceptance record](acceptance.md) and [execution ledger](execution.json).

The acceptance record maps every M07 task and criterion. Local tests do not
deploy a service, change `netxpert.ch`, authorize M08 or replace M09's final
delivery review.
