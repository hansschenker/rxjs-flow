# M08 — Time, causality and cleanup evidence

Date: 2026-09-20. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.
Final result: **1,018 tests passed** (847 Node/DOM + 171 workerd),
**50 more** than the pristine 968-test baseline.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m08/temporal-traces`.
- Starting commit: **`92f25680072da22d45e815ac411abd3651d002a5`**, verified
  current `main` and merged [M07 PR #14](https://github.com/hansschenker/rxjs-flow/pull/14).
- Starting tree: **`cfa1342fa68e10a52a6f4cb57e1e1585dc907c09`**.
- Implementation commit: **`1e6369c9bc0e17fc99da4f512cfa98df65b10191`**.
- Implementation tree: **`b249c6e78cfb965ea49df50cd00eaebb5b80f2cb`**.
- [Execution record](execution.json): captured command arguments, UTC timestamps,
  exits, result lines, log digests and intermediate failure dispositions.
- [Readable temporal traces](temporal-traces.md) and [local checkpoint](local-development.md).

The owner confirmed the completed reference application and explicitly authorized
the next milestone. Both pristine suites passed before implementation edits:
**803 Node/DOM tests in 47 files and 165 workerd tests in 8 files, 968 total**.
The destination and merged history were verified before creating the branch.
The M07 execution ledger remains unchanged historical evidence.

M08 adds optional observations at the existing dataflow boundaries and tests
their meaning. The same RxJS 7 model, effect policies, custom JSX, Hono HTTP,
durable authority and snapshot protocol remain. M09 delivery review, rich
devtools, deployment and publication are separate work. No remote account,
domain, access policy or resource change is part of this milestone.

## Canonical tasks

| M08 task | Implementation and evidence | Result |
|---|---|---|
| 1. Observe the selected boundaries | Source receipt, accepted intent, transition, effect lifecycle, authority commit/publication, rendering, connection changes and scope disposal. | Pass |
| 2. Make temporal and causal identity explicit | Runtime-local sequence and timestamps, owned scope/source/operation identities, collection/generation/revision and connection identity where relevant. | Pass |
| 3. Keep tracing observational and redacted | Constructor-injected tracing observes existing owned execution; bounded metadata records exclude payloads and credentials by default. On/off parity must establish unchanged request counts. | Pass |
| 4. Keep distinct test responsibilities | Existing pure, virtual-time, DOM, Workers-runtime and real transport tests remain; browser evidence verifies native resources and actual application behavior. | Pass |
| 5. Exercise adversarial timing and failures | The coverage map below identifies retained and new burst, queue, delay, malformed input, race, concurrency, failure/recovery and response-loss checks. | Pass |
| 6. Record local scope and resource/performance baselines | The report separates local handler/SQLite instrumentation from native-browser observations and actual remote deployment. | Pass |

## Acceptance criteria

| Canonical acceptance clause | Required recorded evidence | Result |
|---|---|---|
| Traces explain a complete operation | Accepted intent and effect execution connect to committed authority history, snapshot admission and rendering without claiming a total order across clocks. | Pass |
| Traces explain cancellation | Cancellation is distinguishable from error/completion and accompanied by actual transport/listener/resource checks. | Pass |
| Traces explain authority recovery | Reconstruction retains durable history; a fresh connection reads committed state without pretending the old subscription persisted. | Pass |
| Enabling traces leaves request counts unchanged | Equivalent trace-disabled and trace-enabled scenarios compare actual requests and effect/source activation counts. | Pass |
| Owned resources and queues return to bounds | Direct resource assertions accompany lifecycle records; trace buffers are bounded independently of application queues. | Pass |
| Current relevant tests pass at the recorded commit | Full suites, type checks, generated types, build, API/persistence/live smokes and browser gates, with exact implementation and review identities. | Pass |
| Local versus remote evidence and limits are explicit | No global routing, remote instance identity, deployed-service, universal performance or general glitch-freedom claim. | Documented |

## Adversarial coverage map

Existing tests are rerun at the M08 implementation; their earlier results alone
are not current acceptance. Focused runs overlap the full suites and are not
added to the final total.

| Property | Relevant tests or checkpoint | Evidence boundary |
|---|---|---|
| Burst admission, bounded writes and reentrant reservation | `src/client/todo.effects.test.ts` | 32 active plus waiting writes, FIFO reservation and busy create policy; synchronous sources and construction failures. |
| Latest-read cancellation and out-of-order results | `src/client/todo.effects.test.ts` | Superseded reads release ownership and obsolete results cannot replace current state. |
| Retry deadline, setup/dispose races and synchronous feedback | `src/client/live-connection.test.ts` | Virtual-time retry/deadline policy plus direct source, listener and scheduled-resource checks. |
| Delayed response bodies and malformed input | Worker HTTP adapter and HTTP-client integration tests | Actual local workerd `Request`/`Response` bodies, byte bounds, abort and reader-lock release. |
| Concurrent request owners | Worker HTTP and authority integration tests | Independently constructed local handlers and distinct request contexts; no assertion of remote routing. |
| Held commit, bounded authority queue and storage failure | Todo authority and workerd authority tests | No speculative candidate publication; attached SQLite rollback and flush uncertainty are separately tested. |
| Reconstruction and committed response loss | Worker authority and live-model integration tests; native-browser restart | Persisted history survives reconstruction; a lost reply does not imply rollback or authorize automatic replay. |
| Snapshot order and malformed live values | Client live-state/connection and Worker live-model integration tests | Runtime decoding, current-connection admission, duplicate/stale rejection and remembered state. |
| Native DOM and transport lifetime | M08 browser checkpoint and retained M07 scenario | Native HTTP/EventSource, actual controls and explicit disposal/remount. |
| Retained Node lifetime | Node lifecycle and SSE tests | Real local sockets, independent streams, shutdown and released listening port. |

Trace-specific tests add the following checks without replacing those retained
adversarial scenarios:

| Test file | Additional property |
|---|---|
| `src/shared/trace.test.ts` | Inert construction, safe metadata, immutable bounded retention, injected time, sink/clock/reentrancy failures and synchronous inline subscription teardown. |
| `src/client/runtime/trace.test.ts` | Generic program trace order, distinct source/transition identities and scope lifecycle without repeated model execution. |
| `src/client/todo.trace.test.ts` | Trace-disabled/enabled request parity, distinct mounted app operation identities, completed render correlation, error versus cancellation, queue admission and disposal. |
| `src/client/dom/keyed-list.trace.test.ts` | Rendering records follow actual keyed updates and do not add a second list subscription; child lifetime remains owned. |

The finite Todo operation trace sits after the operation's one-result selection
and empty-result validation, before its recoverable error mapping. An ordinary
accepted result completes that application operation; an actual operation error
is recorded before it becomes a failure fact. Unsubscribing pending work records
cancellation. Raw transport lifetime is a separate boundary.

`src/worker/todo-trace.integration.test.ts` adds six workerd tests for trace
parity across actual SQLite/Hono/client code, commit/publication settlement,
rollback/quarantine, stream metadata release and synchronous resource callbacks.
The authority unit suite also verifies that a diagnostic callback cannot overtake
an admitted FIFO operation. The [actual records](trace-records.json) and
[readable examples](temporal-traces.md) preserve the complete operation, canceled
reply and reconstruction evidence.

## Time, causality and observation

The local complete-operation fixture executes client/model/effect, Hono and
functional authority code inside **one `runInDurableObject` fixture**, using
actual attached SQLite and real request/response bodies. Its independently
constructed trace contexts have fixed clocks; they are not proof of separate
browser, Worker and Durable Object isolates. The native-browser checkpoint
provides that separate real client/server transport evidence.

An Observable describes work. Trace construction does not activate it. Existing
owners still decide when to subscribe, what can overlap, what queues, what is
superseded and when to cancel. A trace hook observes those already owned
boundaries; a reader of recorded data does not subscribe again to the effect.

A runtime-local sequence orders records emitted by that trace runtime. Clock
timestamps describe when its injected clock was read; equal timestamps do not
mean simultaneous notification or establish an order. Browser, Worker and
authority clocks are independent. Cross-boundary explanation uses operation
correlation and the committed collection/generation/revision, not sorting every
record by wall-clock time.

The complete local integration may inject trusted diagnostic correlation through
an in-process transport bridge. That is test evidence, not an HTTP header, new
public RPC parameter, production distributed tracing system or assertion about
remote instances. The native-browser checkpoint observes the actual network and
client records separately from that bridge.

`scope.dispose` records cancellation initiation, before all owned cleanup has
necessarily completed. Lifecycle records do not alone prove resource cleanup. The acceptance pairs
them with native listener and connection counts, source teardown/abort checks,
queue bounds and absence of later work after disposal. A cancel record does not
prove a committed server operation was undone.

## Verification and resource baseline

Full suites passed **847 Node/DOM tests in 51 files and 171 workerd tests in
9 files**, 1,018 total. Focused runs overlap those totals. The source was frozen
for the final complete suites, build and native browser gates; documentation
publication follows the implementation commit above.

| Gate | Recorded result |
|---|---|
| Pristine `npm test` / `npm run test:worker` | Pass — 803 / 165 tests (`baseline-node-dom`, `baseline-workerd`) |
| Final `npm test` | Pass — 847 tests / 51 files (`final-node-dom-complete`) |
| Final `npm run test:worker` | Pass — 171 tests / 9 files (`final-workerd`) |
| `npm run typecheck` | Pass — all configured projects (`final-typecheck`) |
| `npm run cf:typecheck` | Pass — generated declarations match (`final-generated-types`) |
| `npm run build:worker` | Pass — browser/Worker outputs (`final-build-guarded`) |
| Trace export reporter | Pass — six workerd trace tests and actual artifact (`server-trace-artifact-final`) |
| Built and development Todo HTTP smoke | Pass (`final-smoke-preview`, `final-smoke-dev`) |
| Durable process restart | Pass (`final-durable-restart`) |
| Legacy live delivery, development and built | Pass (`final-legacy-live-dev`, `final-legacy-live-built`) |
| M08 native browser, built and development | Pass (`browser-built-final`, `browser-dev-final`) |
| Existing M07 built browser regression | Pass — 13 mutations and 36 listeners released (`m07-browser-built-first`) |
| Exact review-head CI | Recorded separately in the PR after publication; no historical run substitutes for it |

Dependencies, Worker configuration/generated types, access policy and existing
CI workflow remain unchanged. The built application script is **65,227 bytes**;
this is an artifact size, not a speed measurement. All five existing HTTP/live
smokes passed without failure iterations. The legacy stream checkpoint retained
at most one full snapshot per consumer, observed a 306-byte high-water frame
against its 131,072-byte frame budget, and ended with zero active checkpoint
read loops.

### Request parity and native resources

Each M08 browser mode runs an equivalent trace-disabled and trace-enabled
scenario in two independent browser contexts. Each scenario issued exactly the
same ordered request vector: A made six live GET requests and two creates;
B made two live GET requests, one update and two deletes. That is **13 API
requests: eight live connections over successive owned lifetimes and five
mutations**. Additional public state/view/transition consumers opened no effects.
The full process-restart experiment occurs after this deterministic comparison;
retry counts there legitimately depend on timing.

| Observation | Final built local Worker | Final development |
|---|---:|---:|
| Trace-disabled / enabled scenario API requests | 13 / 13 | 13 / 13 |
| Steady live connections / mounted owner | 1 | 1 |
| Steady live connections across both pages | 2 | 2 |
| Recorded client trace records | 455 | 443 |
| Native listeners removed across explicit disposals | 160 | 180 |
| Final current-document API requests | 0 | 0 |
| Uncaught browser application errors | 0 | 0 |
| Trace drops / clock / sink / reentrancy / invalid-record failures | 0 | 0 |
| Navigation during full server restart | None | Both pages reloaded by Vite HMR |
| Retired-document request IDs missing a terminal CDP event | None | One per page, retained and labelled |

The browser observed a maximum of one active/admitted mutation in this scenario;
it did not fill the queue. Separate policy/authority tests exercise the 32-entry
admission bounds and full-queue behavior. Every recorder has an explicit
10,000-record capacity in this checkpoint. Scope records are paired with direct
native listener census, HTTP/SSE request census, actual abort observations,
public-stream completion, inactive disposed controls and explicit remount checks.
The native listener totals aggregate several owners; they are not listeners
retained by one mounted application.

In built mode, full server shutdown interrupted the existing live connection;
a bounded retry recovered the same durable generation/revision without browser
navigation. A later commit advanced the revision, and both pages converged.
Development HMR replaced both documents; CDP omitted the terminal request event
for one old-loader SSE ID per page. Those IDs and loader identities remain in
the evidence as **document replaced; no terminal CDP request event observed**.
They are not silently reassigned to the current app or asserted proven closed.
Both modes finished with current-document ownership at zero and closed their
pages/browser contexts. The built run, with no retired IDs, provides the direct
full request-census zero proof.

Both browser runs held a real committed HTTP reply, disposed the client, then
remounted and recovered the committed item. Real network/DOM checks accompany
client trace records; server-local trace records were not injected into the
native browser host. The unchanged M07 built regression separately verifies
forms, filtering, real server 422 feedback, draft revision races, focus and keyed
row identity under the newly instrumented runtime.

### Lightweight timing samples

These are single local samples using Playwright 1.62.1 and Chromium
153.0.8010.0. They include harness/browser scheduling and transport, and do not
isolate tracing cost. No relative-speed conclusion follows from them.

| Observed duration (ms) | Built off / on | Development off / on |
|---|---|---|
| Deterministic scenario elapsed | 951.608 / 898.697 | 1514.835 / 1181.547 |
| Mount to live, observed range | 12.133–29.015 / 21.854–75.941 | 13.906–39.030 / 16.725–35.065 |
| DOM submit to both clients observing the item | 87.708 / 75.696 | 85.998 / 106.170 |

The final screenshots were visually inspected; development and built images are
byte-identical with SHA-256
`fc1dbe72c59b1f75024f776990cae64645e1d30bc198ae783878c7e6c3be50e2`.
The existing pleasant Todo layout remains; traces are optional metadata, not a
new product control panel.

## Limits and blockers

Trace metadata is a diagnostic observation, not a durable audit log. Bounded
retention can discard older records. Application queue and snapshot budgets do
not count Cloudflare/browser/socket internal buffers. Callback or clock failure
must not alter domain execution; a deliberately slow synchronous diagnostic sink
can still consume host execution time. Recursive emission from a sink is dropped
and counted in `reentrantDrops`; a sink that itself performs application actions
is not guaranteed to produce a complete record of those actions. Identifiers
are developer-selected metadata, not free-form payload summaries; the host must
keep private values out of those labels. No universal speed claim follows from
one recorded local run.

The local durable target uses SQLite beneath `.wrangler/state`; automated
checkpoints use private temporary storage. The retained Node mode has a separate
in-memory history and resets on restart. Neither local test mode proves deployed
Cloudflare routing, production capacity, access control or disaster recovery.
The built deployment configuration keeps Todo access disabled. No Worker,
domain or account operation is authorized by M08 completion alone.

M06's bounded reconnect and first-snapshot deadline remain: delays of 1, 2, 4
and 8 seconds, a 10-second first-snapshot deadline, and explicit manual recovery
after protocol failure or retry exhaustion. There is no heartbeat or bounded
detection time for an idle partition after the first snapshot. Reconnect repairs
the current collection, not an exactly-once event history.

Optional browser tooling stays outside repository dependencies. Local dependencies
reuse the pinned installation; exact review-head CI verifies a clean install
separately. A repository commit does not automatically update the ChatGPT Project
reference copy. M09 remains pending.

No implementation blocker remains. Initial TypeScript/test-fixture failures and
the workerd console-export limitation are recorded with their corrections in
the execution ledger. A small host-side Vitest reporter exports actual trace
metadata through the supported test result rather than fabricating captured
output. All final local gates pass at the recorded implementation. The following
documentation commit and PR record review-head identity and CI separately.
Acceptance review/merge remains pending; M09 requires its own authorization.
