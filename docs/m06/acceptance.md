# M06 — Typed live synchronization and recovery

Date: 2026-09-20. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.
Final test total: **931 passed** (766 Node/DOM + 165 workerd).

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m06/live-state`.
- Starting commit: **`540faec7086bb58223c5f475db91710ac0e7389b`**, verified
  `main` and merged [M05d PR #12](https://github.com/hansschenker/rxjs-flow/pull/12).
- Starting tree: **`a56c0aabfc100731faf33d493e892f967bc9450d`**.
- Implementation commit: **`f99ac5ddd75b5a10f47dce35410a1c6d0e6699f1`**.
- Implementation tree: **`05729a272471deb825697cda16737d83500e4dcd`**.
- [Execution record](execution.json): commands, timestamps, exit codes, toolchain,
  log digests and failure dispositions. Historical results are labelled separately.
- [Runnable checkpoint](local-development.md): the actual Todo application in two
  browser tabs, live convergence and recovery after an interruption.

The owner explicitly authorized M06 after the M05d checkpoint. PR #12's merge
and the current destination were checked before branch creation. A pristine
starting-tree baseline passed **834 tests: 676 Node/DOM tests in 40 files and
158 workerd tests in 6 files**. Implementation agents waited for both baseline
suites to finish before editing. Original Git history and attribution remain.

This milestone connects the verified live delivery path to the mounted Todo
application. It keeps RxJS 7, custom JSX, finite HTTP contracts, the legacy SSE
endpoint, the local collection access policy and bounded server ownership.
M07–M09 remain pending. No package release, remote resource creation, migration,
deployment, account change or domain change is part of this work.

## Canonical task mapping

The nine task rows are separate from the acceptance clauses below. References
identify what must be exercised; final results require the recorded gates.

| Task | Implementation decision and evidence | Result |
|---|---|---|
| 1. Separate finite and live contracts | `routes.test.ts`, `api.test.ts` and `todo-live.test.ts` verify finite/live type separation and decoding; `createTodoService` selects the live contract explicitly. Existing finite inference and response validation remain tested. | Pass |
| 2. Publish a versioned schema without silently changing the old wire | New `/todos/live` emits `todo-snapshot` with schema version 1. `/todos/stream` still emits `todos` with a bare Todo array. Shared runtime schemas reject invalid values. | Pass |
| 3. Make committed snapshots authoritative | Only accepted live snapshots replace the collection. HTTP mutation results settle their correlated pending operation; they do not append, toggle or delete the rendered collection independently. | Pass |
| 4. Own one shared connection per mounted app | The mounted application owns the live effect once. State/view subscribers share remembered state, so adding a consumer opens no transport. Initial loading and stale/reconnecting status are explicit. | Pass |
| 5. Order by logical collection history | `collectionId + stateGeneration + revision` identifies a snapshot. Revisions compare only within that collection/history; older and duplicate snapshots cannot regress state. Durable reconstruction preserves history. | Pass |
| 6. Keep connection identity separate | Each connection attempt has a fresh identity. Superseded callbacks are ignored; only the first validated snapshot from a new current connection can establish a changed generation for the pinned collection. | Pass |
| 7. Assign one bounded reconnect owner | The RxJS connection owner closes native EventSource on interruption, then schedules at most four retries after 1, 2, 4 and 8 seconds. A valid snapshot resets consecutive failures. Protocol failures and exhaustion require manual recovery. | Pass |
| 8. Cancel connections/retries and reject malformed data | Disposal closes transport and cancels scheduled retry/deadline work. A 10-second first-snapshot deadline prevents a silent opening connection from waiting indefinitely. Decoding begins from `unknown`; malformed data cannot enter collection state. | Pass |
| 9. State uncertainty explicitly | Reconnection reads current committed state without replaying mutations. Cancellation is not rollback, and lost HTTP replies do not prove a write failed. No historical event replay or exactly-once delivery claim. | Documented; reviewed |

## Acceptance criteria

| Canonical acceptance clause | Evidence to be recorded | Result |
|---|---|---|
| Two mounted clients converge after independent-handler writes | `src/worker/todo-model-live.test.ts` uses independently constructed Hono handlers and real Durable Object streams; `scripts/m06-browser-checkpoint.mjs` mounts two actual Todo pages. | Pass |
| Each accepted mutation applies once without dual HTTP/SSE updates | `todo.live-state.test.ts` and `todo-model-live.test.ts` exercise HTTP-before-SSE and SSE-before-HTTP, with one collection transition per accepted mutation. The browser observes six requests/six accepted writes without duplicate rows. | Pass |
| Duplicate/older revisions cannot regress the collection | `todo.live-state.test.ts`, `live-app.test.ts` and `live-connection.test.ts` exercise repeated revisions, delayed older snapshots, first-snapshot admission and valid newer revisions. | Pass |
| Authority restart retains persisted history | `todo-versioned-live.test.ts`, `todo-model-live.test.ts` and the browser process-restart checkpoint retain collection identity, generation, revision and Todos. | Pass |
| Explicit new history and superseded connections are handled | `todo.live-state.test.ts` and `live-app.test.ts` cover first-current-snapshot history replacement, pinned-collection rejection and old callbacks. Workerd tests replace persisted history through test-only storage setup. | Pass |
| Extra UI consumers open no extra connection | `live-app.test.ts` and `todo-model-live.test.ts` subscribe multiple state/view consumers while asserting one connection. Independent browser pages each start one transport. | Pass |
| Unmount during retry opens nothing later | `live-connection.test.ts` and `live-app.test.ts` advance injected scheduler time beyond pending retries/deadlines after disposal and assert no new EventSource construction. | Pass |
| Malformed payloads are rejected | `src/shared/todo-live.test.ts`, `live-connection.test.ts` and `live-app.test.ts` reject invalid schema/JSON and oversized/duplicate-identity payloads while preserving remembered collection and explicit recovery. | Pass |
| Retained Node reset-generation policy is separately labelled | `src/server/todos/todo.live.test.ts` verifies fresh factory/reset history and bounded reentrant publication; workerd tests retain durable history. Current Node lifecycle/socket tests retain shutdown and port-release coverage. | Pass |

## What flows and what owns it

The authority publishes complete committed Todo snapshots. Each mounted app
subscribes to one cold connection description. That subscription opens its
EventSource and owns all connection listeners, first-snapshot deadlines and retry
timers. Extra rendering/state consumers observe the app's shared remembered
state; they do not subscribe independently to the network source.

Validated connection facts flow back through the application's state model.
An accepted snapshot replaces the collection; derived values and existing owned
DOM bindings update the relevant rows, counters and connection status. Rendering
does not create a connection or initiate a mutation. Finite create/update/delete
operations keep their existing bounded, ordered effect policy. Their replies
settle pending operation status while collection content comes from snapshots.

The server remains the collection authority. The client does not maintain a
competing optimistic collection, and a Worker-global Subject is not a database.
The M05d race-free initial snapshot/live registration and bounded full-snapshot
coalescing remain in force. A consumer may skip intermediate complete snapshots
when it is slow; the latest accepted snapshot still describes the full collection.

## Public protocol and consistency policy

| Boundary | Contract |
|---|---|
| Hono/Worker live URL | `GET /api/todos/live` |
| Retained Node live URL | `GET /todos/live`; the Vite client proxy adds `/api` externally |
| SSE event | `todo-snapshot` |
| Snapshot fields | `schemaVersion: 1`, `collectionId`, `stateGeneration`, `revision`, `todos` |
| Legacy SSE | `/api/todos/stream` on Worker, `/todos/stream` on Node; `event: todos`, bare Todo array |
| Collection identity | Pinned by the first accepted snapshot for the app; a different collection cannot reset its model |
| Generation | Identifies collection history; ordinary Durable Object restart preserves it |
| Revision | Monotonic within one collection/generation; duplicate/older values do not replace accepted collection content |
| Connection identity | Per-attempt local identity; never used as the persisted generation |
| Changed generation | Accepted only as the first validated snapshot from a new current connection for the pinned collection |

Revisions from different histories are not numerically ordered. A delayed payload
cannot use a different generation to reset an already established connection.
A new current connection provides the explicit resynchronization boundary. An
equal first revision confirms the remembered collection without replacing its
items. An older first revision in the same history instead closes the attempt
and requires manual recovery. Later older/duplicate revisions are ignored, while
a mid-connection history change is a protocol failure. This policy trusts the
new connection's authorized server snapshot; it is not a universal ordering of
arbitrary generation identifiers.

In retained Node mode, each independent in-memory factory creates a fresh
generation and begins at revision 0. Explicit reset creates new history at
revision 0, interrupts versioned observers, and leaves legacy bare-array
observers active. A new connection reads the replacement history. Restarting
that server loses its collection. This demonstration policy is distinct from Durable Object
reconstruction, which reads the same persisted generation and revision. Collection
selection and authorization remain server-controlled; clients cannot select a
different authority by changing an arbitrary query parameter. The retained memory
factory keeps the 1,000-Todo/120-KiB snapshot limit and bounds reentrant publication
work to 32 active plus queued operations. Pure synchronous publication uses one
serialized queue so a reentrant mutation cannot overtake delivery to another
observer. There is no public reset endpoint; durable new-history replacement is
exercised through test-only storage setup.

## Connection, timing and recovery

The RxJS owner is the sole reconnect policy. EventSource is created per attempt
and closed immediately on an interruption before a retry is scheduled. Native
EventSource retry does not run alongside the application policy. The
[HTML EventSource contract](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface)
specifies its connection/close behavior; the implemented policy is additionally
checked against installed RxJS 7.8.2 and the local lifecycle tests. Transport
failure and the 10-second first-snapshot deadline use the bounded retry schedule
`[1, 2, 4, 8]` seconds. A validated current snapshot resets consecutive failure
count. Connection opening alone does not prove synchronized state.

Before the first accepted snapshot, the application shows loading. During a
gap it retains its last accepted Todos and identifies them as stale/reconnecting.
Protocol failure or exhausted retries leaves a visible terminal status and a
manual Reconnect action. Recovery creates a new owned connection that begins
with a complete current snapshot. Disposal cancels active transport and pending
retry/deadline work; advancing time cannot reactivate an unmounted app.

These are controlled application timings, not a guarantee about network or host
scheduling. The 10-second deadline applies only before an attempt's first valid
snapshot; it is not an idle-connection watchdog. There is no heartbeat or bounded
detection time for a silent network partition after synchronization. Reconnect
begins when EventSource reports failure, or the user requests it. Server SSE/
authority budgets remain those verified in M05d. There is no perpetual keep-alive
guarantee, new transport, background job or event log.

## Mutation uncertainty

A server may commit a mutation before its HTTP response is lost. Aborting the
local request or closing the page releases local resources; it does not undo an
accepted server operation. Reconnection repairs the current collection by
receiving a full committed snapshot. It does not recover every intermediate
event or prove which uncertain request produced a particular item.

There is no automatic mutation replay, idempotency protocol or exactly-once
delivery promise in M06. The tests assert that each accepted test mutation is
applied once under the tested execution and that HTTP plus SSE do not apply it
twice in client state. That is narrower than a distributed exactly-once claim.

## Verification and limits

The current full suites passed **766 Node/DOM tests in 46 files**
(`final-node-dom-2`) and **165 workerd tests in 8 files** (`final-workerd`):
**931 total, 97 more than the pristine 834-test baseline**. Focused runs supplement
these final regressions; their counts are not added to the total. The workerd model
integration runs real authority Fetch streams and independent Hono handlers;
controlled client timing uses injected schedulers. A 2,000-successful-reconnect
stress case checks that the retry owner does not retain an ever-growing chain.

| Command | Final result |
|---|---|
| `npm test` | Pass — 766 tests / 46 files (`final-node-dom-2`) |
| `npm run test:worker` | Pass — 165 tests / 8 files (`final-workerd`) |
| `npm run typecheck` | Pass — all configured TypeScript projects (`final-typecheck`) |
| `npm run cf:typecheck` | Pass — generated Worker declarations match configuration (`final-generated-types`) |
| `npm run build:worker` | Pass — browser and Worker output (`final-build`) |
| `npm run smoke:worker` | Pass — built assets, API precedence and access-disabled Todo 503 (`final-smoke-preview`) |
| `npm run smoke:worker -- --dev` | Pass — actual local Todo CRUD and failure recovery (`final-smoke-dev`) |
| `node scripts/m05c-checkpoint.mjs --preview` | Pass — two callers and persisted state after full runtime restart (`final-durable-restart`) |
| `node scripts/m05d-checkpoint.mjs` | Pass — retained legacy live stream, independent disconnect and restart (`final-legacy-live-dev`) |
| `node scripts/m05d-checkpoint.mjs --preview` | Pass — the same legacy checkpoint through built local Wrangler (`final-legacy-live-built`) |
| `node scripts/m06-browser-checkpoint.mjs` with supplied tooling | Pass — real two-page application synchronization and recovery (`browser-live-final`) |
| `git diff --check` | Pass; document/link review completed before publication |

The implementation tree is `05729a272471deb825697cda16737d83500e4dcd`.
Implementation commit: `f99ac5ddd75b5a10f47dce35410a1c6d0e6699f1`.
Exact review-head CI will be recorded in the
PR after verification, separately from these local gates.

`package.json` and `package-lock.json` are unchanged; the pinned M05d dependencies
were reused locally without upgrade. Local Node is 22.22.1 and npm is 11.9.0.
Clean installation remains a separate CI gate; reuse of local dependencies is
not recorded as a fresh local `npm ci`.

The actual browser checkpoint (`browser-live-final`) passed against built local
Worker assets with Chromium **153.0.8010.0** and Playwright **1.62.1**. It mounted
the real Todo application in two independent browser contexts and passively
observed native EventSource frames through DevTools. Six mutation requests
produced six accepted writes; no finite list GET or duplicate rows appeared.
Keyed row identity, draft text, focus and selection survived live updates.
Manual reconnect affected A only. An offline replacement attempt showed retained
stale data and recovered automatically, including a write made through B during
the gap. Full server stop interrupted established connections; restart preserved
collection/generation/revision and a subsequent write reached both pages.

| Browser observation | Recorded result |
|---|---|
| Initial connections | One per mounted application despite multiple UI consumers |
| Mutation requests / accepted replies | 6 / 6; POST, POST, PUT, DELETE, POST, POST |
| HTTP list reads / duplicate rows | 0 / 0 |
| Consumer A requests / received snapshots | 5 / 9 |
| Consumer B requests / received snapshots | 2 / 8 |
| Uncaught browser errors | 0 |
| Final cleanup | Both mounted pages and browser contexts closed |

The screenshot was inspected for readable status, controls and layout. Browser
tooling is supplied outside the repository; the optional
`scripts/m06-browser-checkpoint.mjs` uses caller-provided installed tooling and
adds no dependency or normal CI browser gate.

In Chromium, setting the browser context offline did not terminate already-open
EventSource requests. The offline checkpoint therefore requests Reconnect while
offline to exercise actual failed replacement connections; full server shutdown
separately proves spontaneous interruption of established streams. The offline
probe does not claim that every silent partition is detected within a fixed time.

The pristine 834-test baseline is current starting-tree evidence, not a substitute
for final regression gates. Node/DOM policy tests, actual workerd authority tests,
real local HTTP and browser tests establish different parts of the contract.
Local runtime restart is not evidence of Cloudflare global routing or a remote
outage. The deployable configuration still disables Todo access; no production
authentication, public endpoint or remote deployment is claimed. The ChatGPT
Project reference copy is not updated automatically by a Git commit.

Intermediate failures are retained in the command ledger. Early typechecks
found finite/live generic narrowing, incomplete test request/observer fixtures,
and DOM-versus-workerd `MessageEvent` typing differences; they were corrected
with explicit finite compatibility fixtures and a narrow structural message
contract. The first full Node/DOM run exposed three older finite HTTP app fixtures
now selecting the live default, plus an inert-import mock lacking `live$`.
Those fixtures explicitly select finite mode; the import test also asserts that
live construction stays inert. Their original behavioral assertions remain.
The subsequent complete suite passed 766 tests. Browser harness corrections
separated offline replacement failure from real server interruption and made
context cleanup compatible with the supplied single-process Chromium.

No implementation blocker remains. Intentional cancellation/failure probes emit
workerd diagnostics also seen in the pristine baseline; local proxy/toolchain
warnings remain visible. These server diagnostics are separate from the zero
uncaught errors observed in the actual browser scenario.
M06 review/merge and later milestone authorization remain separate decisions. M07 reference-app completion, M08 traces
and adversarial coverage, and M09 delivery review do not begin with this change.
