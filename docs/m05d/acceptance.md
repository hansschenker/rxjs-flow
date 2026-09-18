# M05d — SSE ownership and bounded live delivery

Date: 2026-09-18. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.
Final test total: **834 passed**. Command/CI evidence is recorded below.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m05d/owned-sse`.
- Starting commit: **`d5500da407611e7856e9e67481a08e15e530aece`**, verified
  `main` and merged [M05c PR #11](https://github.com/hansschenker/rxjs-flow/pull/11).
- Implementation commit: **`5614e7a84cfbe1bf7b3e81538138a26deb79c427`**.
- Implementation tree: **`a04c13ce2a4edb70aa0ccac6dec13e91df55ae20`**.
- A following evidence/documentation commit adds the optional browser probe.
  Runtime code, tests and HTTP checkpoints are identified by the implementation
  commit above; the browser runner supplies repeatable verification without
  adding a repository dependency or CI browser gate.
- [Execution record](execution.json): exact commands, versions, timestamps,
  exit codes, baseline/final results and intermediate failure dispositions.
- [Runnable checkpoint](local-development.md): two live consumers, independent
  disconnect/reconnect, retained collection and bounded response ownership.

The owner authorized the next milestone after reporting PR #11 completed. The
canonical order makes M05d next. M05c's page and Refresh request were manually
confirmed; that observation is separate from the automated restart evidence.
M05d keeps RxJS 7, the custom JSX Todo application, finite route contracts and the
local-only collection access policy. The public stream keeps its existing
`todos` event name and bare-array data. Versioned live state, reconnect policy and
integration into the Todo application remain M06. No remote resource creation,
remote migration, deployment, release or domain/account change was performed.

## Acceptance criteria

These rows map every clause of the canonical M05d acceptance. Final command
results are below and in the execution record; implementation references are not
substitutes for executing those gates.

| Criterion | Implementation and evidence | Result |
|---|---|---|
| Synchronous complete/error and already-aborted requests clean up | `owned-byte-stream.test.ts`, `todo-live.test.ts` and `node-sse.test.ts` exercise inert construction, teardown registered before activation, synchronous termination, setup failure, reentrant abort and throwing finalizers. | Pass |
| SSE stays active after request-body completion | Live ownership is separate from the finite descriptor; real Node sockets and the local Worker checkpoint receive a later committed update after the GET request completes. | Pass |
| Real response cancellation releases owned work | Public body cancellation releases the Worker source, cancels the private authority reader and removes its live registration. Workerd ownership assertions and actual local HTTP disconnect/reconnect supply distinct evidence. | Pass |
| Another client continues | Independent streams address the same durable collection; closing A leaves B receiving writes and preserves committed state for A's new connection. | Pass |
| Writes preserve defined order with bounded queues | Generic FIFO tests assert order and overflow failure; explicit full-snapshot mode coalesces only one pending snapshot. Node waits for `drain`; Worker enqueues only on downstream pull. | Pass |
| Setup cannot miss an intervening commit | Initial committed read and registration share the authority's serialized operation queue. Delayed storage/interleaved mutation and queued-cancel tests assert the handoff and bounded admission. | Pass |
| Source failures and authority interruptions are visible | Source errors, malformed/oversized internal records, storage failure and authority interruption terminate the stream; reconnect reads committed state. Workerd reconstruction retains storage history. | Pass |
| Listeners, subscriptions and buffers return to baseline | Byte-owner counters return to zero; authority live registrations return to zero while the logical collection remains; Node response/drain/error listeners are removed. Queue cancellation retains accounting until drained. | Pass |
| Retained Node shutdown disposes streams and releases its port | Current `node-lifecycle.test.ts` and `node-sse.integration.test.ts` real socket checks verify shutdown and port reuse, complemented by bounded Node transport tests. The adapter is retained. | Pass |

## Values and ownership across the live path

`watch$()` is cold. Subscribing first admits a live registration to the authority's
bounded operation owner. In one queue turn it reads the committed snapshot and
makes that registration ready before subsequent mutations can run. An earlier
accepted mutation is included in the initial read; a later accepted mutation is
published to the ready registration. There is no read/subscribe gap.

Successful create/update/delete operations publish only after attached storage
settles. Publication uses the committed immutable envelope. A rejected domain
transition publishes no new state. A storage failure interrupts live consumers;
uncertain storage settlement retains M05c's fail-closed behavior. A canceled
queued watch releases its live slot immediately but retains its counted operation
slot until drained, when it skips storage. Repeated connect/cancel cannot create
an uncounted queue. The persistent collection does not depend on subscriber count.

The platform-required `TodoCollection` entry exposes a private Fetch path reached
through the already-authorized namespace capability. Its response sends internal
snapshot envelopes as bounded newline-delimited JSON. Each public Worker response
owns one cold `createDurableTodoLive` reader. It validates collection identity,
schema, UTF-8 and frame size, then maps the envelope to the unchanged public
`event: todos` with a bare Todo array. The internal envelope is not a published
M06 browser protocol, and no Worker-global Subject becomes a second authority.

The Hono adapter prepares and validates the streaming response descriptor under
M05b's finite request owner. It activates the distinct body owner only after that
descriptor succeeds. Returning the Response or completing the incoming request
body does not dispose the live source. The finite 10-second settlement deadline
applies to descriptor selection, not the established stream's lifetime.

The body is a standards-based `ReadableStream` with a zero high-water mark and
one bounded application queue. A downstream pull permits one enqueue. This
avoids a chain of concurrent async observer writes. Cancellation aborts a pending
authority fetch, cancels an acquired authority reader and cancels a late body that
arrives after disposal. The existing `enable_request_signal` compatibility flag
remains explicit. Local tests verify the selected runtime; they do not prove
remote proxy behavior.

## Bounds and terminal behavior

| Resource | Declared bound/policy |
|---|---|
| Active plus waiting authority operations | 32 total, including at most one active operation; unchanged M05c admission budget |
| Active Node SSE responses per listener | 32; the 33rd receives finite 503 without activating its source; capacity returns on disposal |
| Live registrations per collection | 32, including setup waiting for an initial snapshot; overflow fails with `TODO_LIVE_BUSY` |
| Durable snapshot | 1,000 Todos and 120 KiB encoded envelope JSON; unchanged M05c limit |
| Authority NDJSON pending data | One latest complete snapshot, at most 120 KiB plus one newline |
| Worker internal record decoder | 120 KiB record buffer; malformed, incomplete or oversized input terminates |
| Generic Worker/Node pending SSE | FIFO, at most 16 frames and 256 KiB; overflow terminates visibly |
| Encoded public SSE frame | At most 128 KiB, measured in UTF-8 bytes |
| Explicit Todo snapshot delivery | Replace the single pending full snapshot with the latest; intermediate snapshots may coalesce |

The generic queue never silently drops domain events. Latest-snapshot mode is
valid only when each payload completely replaces collection state. These limits
cover application-owned pending data, not platform/socket buffers or total
production capacity. A handed-off frame can be in transport while one later
snapshot waits. Node honors `write(false)`, so its writable high-water mark can
be crossed by at most one permitted frame before waiting for `drain`; native
transport and OS buffers remain outside the application queue count. Live subscriptions are memory resources, not persisted state.
There is no replay log, exactly-once delivery, heartbeat service, detached timer,
`waitUntil()` keep-alive loop or SSE hibernation claim.

| Boundary | Outcome |
|---|---|
| Invalid response status/header/descriptor before live activation | Finite structured error; live source is never activated |
| Already-aborted response | No live source activation; owned resources remain at baseline |
| Source completes | Release source; deliver already accepted bounded frames in order, then close |
| Encoding/write/source failure or queue overflow | Discard pending frames, terminate the body visibly and release ownership |
| Failure after headers | Error/close the existing stream; never substitute a fresh JSON response |
| Client cancellation | Release this response's source/listeners/buffers and upstream reader; other clients and stored state remain |
| Authority interruption | Current live body terminates; a new connection acquires a full current committed snapshot |
| Retained Node backpressure | Stop writes on `write() === false`, resume on `drain`; response close/error and app stop release the wait |

SSE event/id fields reject newline or NUL injection, and JSON encoding failures
are contained. Error reporters/finalizers cannot prevent remaining cleanup.
Normal complete, error and cancel are distinct terminal policies. A response
that has handed a frame to its transport cannot retract that frame.

## Parent M05 acceptance and historical dispositions

M05's four substeps are separately evidenced. This report combines their
recorded commits with current regression gates; it does not relabel old test
counts as current results. Parent M05 acceptance remains review pending until
all rows and the M05d gates are verified.

| Parent requirement | Evidence identity and disposition |
|---|---|
| M05a platform/build foundation | Implementation `3e29ed1775bad5b5ca15d6acd44822272caf76be`, merged PR #6 `eeb8d2989884372fa42f4e321295aa7f3e8faa75`; [M05a evidence](../m05a/acceptance.md). Current typecheck/build/workerd/preview gates rerun below. |
| M05b HTTP compatibility and request ownership | Implementation `407ce32ad041df6c60fbfab043927bebe38e811e`, merged PR #10 `1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`; [route/lifecycle matrix](../m05b/acceptance.md). Current finite HTTP tests remain. |
| M05c durable authority | Implementation `48b9a8a71de5167f9de9fa94fbb3109b07a3c055`, merged PR #11 `d5500da407611e7856e9e67481a08e15e530aece`; [storage/failure matrix](../m05c/acceptance.md). Current authority tests and restart checks remain. |
| M05d owned bounded live path | Current implementation `5614e7a84cfbe1bf7b3e81538138a26deb79c427` and the nine acceptance rows above. |
| Original characterization requirements | Every concern from immutable M00 commit `5640870a1f5b0cc92946b42e8dba261fcd0eacb6` has a disposition below. The intentionally failing branch is not merged. |
| Supported-runtime status | Hono/workerd is the selected local target. Node remains a tested in-memory mode with real startup/stop/port-release evidence; no permanent dual-runtime support promise. Final disposition remains M09. |
| Authority-to-live-response path ready for M06 | Committed authority → private Fetch body → validated Worker reader → bounded public SSE, with race-free registration and independent cancellation; legacy browser payload preserved. |

The original 15 failing M00 assertions were grouped into eight concerns. Passing
controls and historical evidence are preserved, with no rewrite of archived
records.

| M00 concern | Verified fix/replacement and current regression location |
|---|---|
| Non-2xx client responses incorrectly emit success (7 assertions) | M03 implementation `54f08ce0629175691e66f8036d3331167dddf164`: structured HTTP errors; `src/client/api.test.ts` plus workerd client-to-Hono integration. |
| Failed DELETE incorrectly completes successfully (2 assertions) | Same M03 implementation: only declared 204 emits `undefined`; non-2xx DELETE remains failure. Current HTTP/client tests retain it. |
| Synchronous startup feedback is lost | M02 implementation `52c930c99ffa6edb5f28db5889ba25981b901951`, with M01 ownership: state/feedback attach before startup; current app/model/runtime tests retain synchronous service cases. |
| Missing root construction/disposal seam | M01 implementation `7cd4b412ab7e536e86609a7d4ec2964bb093e64c`: inert factory, explicit mount/disposal and detached listener cleanup; current app/lifetime/DOM tests retain it. |
| Malformed route parameter stops the listener | M05b implementation `407ce32ad041df6c60fbfab043927bebe38e811e`: real Node 400 followed by successful request. M05c additionally preserved malformed-path validation in the optimized Worker bundle; current Node/workerd/built HTTP checks retain it. |
| Synchronous handler construction stops the listener | Same M05b owner contains construction failure and returns bounded 500; current Node lifecycle and workerd HTTP tests verify a following valid request. |
| Real SSE disconnect leaks the source | M05b repaired Node response-close ownership; M05d adds bounded Node writes and the authority-to-Worker cancellation path. Current real sockets and workerd resource assertions verify separate consumers and cleanup. |
| App stop leaves SSE active | M05b fixes response disposal and port release; current Node lifecycle tests retain this while M05d adds backpressure cleanup and local Worker interruption/reconnect evidence. |

## Verification and remaining limits

Starting baseline: **629 Node/DOM tests in 38 files and 108 workerd tests in
4 files**. An initial 629-test Node/DOM suite rerun passed after HEAD verification;
implementation could already be starting in parallel, so this is not claimed as
a frozen pristine starting-tree run. A pristine workerd baseline was not rerun: its 108/4 count is reused from M05c's recorded implementation and
verified PR #11 exact-head [CI run 35348851104](https://github.com/hansschenker/rxjs-flow/actions/runs/35348851104).
The current workerd suite was rerun and passed below. Toolchain and unchanged dependency
resolution are recorded in `execution.json`.

| Command | Final result |
|---|---|
| `npm test` | Pass — 676 tests / 40 files after the final Node descriptor regressions |
| `npm run test:worker` | Pass — 158 tests / 6 files |
| `npm run typecheck` | Pass — generated types and all five TypeScript projects |
| `npm run cf:typecheck` | Pass — generated Worker declarations match configuration |
| `npm run build:worker` | Pass — browser and Worker outputs, including the separate diagnostic page |
| `npm run smoke:worker` | Pass — built assets/foundation/API precedence and access-disabled Todo 503 |
| `npm run smoke:worker -- --dev` | Pass — actual local Todo HTTP CRUD and failure recovery |
| `node scripts/m05c-checkpoint.mjs` | Pass — two HTTP callers, concurrent mutations and exact collection after full restart |
| `node scripts/m05c-checkpoint.mjs --preview` | Pass — the durable two-caller/restart checkpoint through built local Wrangler |
| `node scripts/m05d-checkpoint.mjs` | Pass — actual HTTP stream cancellation, continued consumer, reconnect and full restart |
| `node scripts/m05d-checkpoint.mjs --preview` | Pass — the same live checkpoint through built assets and local Wrangler |
| `git diff --check` | Pass |

Final total after the Node descriptor follow-up: **834 tests**, 97 more than
the 737-test M05c baseline. The preceding integrated run passed 829 tests; the
reviewer added regressions for no-body SSE statuses, invalid delivery policy and
fixed Content-Length handling before the final run. Current focused
suites separate controlled Node backpressure, pure authority
interleavings, actual workerd Fetch/stream/cancellation and real HTTP sockets.
The resource assertions check explicit ownership, not only finalizer callbacks:

| Boundary | Observed sequence/terminal assertion |
|---|---|
| Authority live registrations | Two open responses: 2; cancel A: 1; cancel B: 0; committed revision 2 remains readable |
| Cancel before first read | One private authority registration returns to 0 on body cancellation |
| Worker response owner | `active`, `listener`, `pendingEvents`, `pendingBytes` all return to 0 after terminal cleanup |
| Retained Node source subscriptions | 2 → 1 after A closes → 2 after A reconnects → 0 at app stop; the same port is rebound |
| Node live admission | 32 accepted; 33rd gets 503 without subscription; cancel restores capacity |
| Local HTTP checkpoint read loops | Two connected consumers, one disconnect/reconnect, full runtime interruption and a new stream; 0 owned checkpoint loops remain after cleanup |

The development and built local Wrangler checkpoints both passed actual HTTP
body cancellation, continued B delivery, A's fresh snapshot, full process-stop
stream errors, persisted-state recovery and a new live commit after restart.
These HTTP probes do not expose production resource counters; workerd/Node
ownership assertions supply the corresponding internal measurements.

Authority interruption and reconstruction have separate probes. Workerd
`state.abort()` interrupts an established stream visibly. For reconstruction,
the consumer cancels first, live registration count reaches zero, the test evicts
the authority, and a fresh stream reads the same persisted history. An initial
attempt to call the eviction helper while live HTTP references existed waited
30 seconds and rejected because the helper could not evict that active instance.
That test-harness limitation did not establish stale delivery, and no artificial
lease/keep-alive policy was added. A full local process stop separately terminates
active HTTP streams and verifies recovery through a new process.

The diagnostic page is served at `/m05d-live.html` in development and in the
built local artifact. It provides two independently owned native EventSource
connections, explicit Connect/Disconnect controls, a bounded latest-snapshot
display and a Save form. It closes on errors rather than starting a competing
automatic retry policy. Actual browser verification passed against built assets and the built local
Worker using Chromium **153.0.8010.0** and Playwright **1.62.1**. Native EventSource
opened two connections; a visible form write reached both; A disconnected while B
continued; A reconnected to a fresh snapshot; full process shutdown interrupted
both; reconnect recovered persisted state and another live commit. The scenario
observed exactly **5 stream requests**, **5 snapshots per consumer**, **0 uncaught
browser errors**, and both panels disconnected at the end.

Browser tooling was supplied outside the repository. The standard Chromium CDN
download failed, and initial fallback extraction lacked a complete binary and
software-graphics libraries. Corrected extraction from the npm binary package
resolved those environment issues before the passing browser scenario. Exact
captured commands and uncaptured recovery dispositions are in `execution.json`.
The optional `scripts/m05d-browser-checkpoint.mjs` reruns this scenario with
caller-supplied Playwright and Chromium; see the local guide. Portable runner
verification passed (`browser-portable-final`, exit 0). A screenshot of the
1180-pixel-wide checkpoint was also inspected: both panels, status, controls,
snapshot payloads and form were readable without overflow. Final CI is pending
at the evidence commit; its exact review-head result will be recorded in the PR,
separately from local execution.

No automated Todo application live convergence is claimed: the app still uses
finite reads and Refresh. M06 supplies versioning, stale/reconnecting state,
connection identity, shared app ownership and recovery policy. A diagnostic
consumer or transport test does not satisfy M06/M07 browser-loop acceptance.

Local runtime reconstruction, cancellation and storage tests do not force
Cloudflare global routing or prove a remote outage. Application resource budgets
do not bound network/platform buffers, establish production capacity or supply a
public release access policy. Production Todo access remains disabled. There is
no remote deployment, login/account verification or ChatGPT Project reference-copy
synchronization claim. No implementation blocker remains. Parent M05 acceptance
and the M05d merge remain review decisions; M06 does not start automatically.
