# M03 — Owned effect streams and validated HTTP outcomes

Date: 2026-09-17. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m03/effect-policies`.
- Starting commit: `7374557b6d264a9bfa572526a4f71233fc3aa24e`, verified merge of
  PR #7. M00, M01, M05a and M02 remain accepted; original history is preserved.
- Implementation commit: `54f08ce0629175691e66f8036d3331167dddf164`.
- Implementation tree: `a7cb3913b96f661b0ff781cfed37aa826c57aae7`.
- [Execution records](execution.json) preserve commands, UTC timestamps, exit
  codes, selected output and resolved intermediate failures. The following commit
  records documentation only; final PR-head CI is recorded in the PR.

The user authorized M03 after accepting PR #7. The sequence remains
M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07 → M08 → M09.
This checkpoint changes browser intents/effects, HTTP response contracts and
decoding, the generic SSE decoding boundary, and their tests. Package/lock files,
Node handlers, Worker implementation and CI are unchanged. No deployment, remote
runtime resource, account, domain or secret configuration changed.

## Implemented contract

`interpretTodoIntent`, `describeOperation`, `operationSucceeded` and
`operationFailed` are named pure functions. Components emit typed intents;
`todoEffects$` returns correlated result events. The mounted root owns exactly one
effect subscription and feeds its results into the M02 model's serialized ingress.
Views and traces observe the model. Extra state, view-model or transition consumers
cannot execute another request. The effect factory itself is cold: directly
subscribing to it again intentionally creates an independent run.

| Operation | Execution policy | Admission and settlement |
|---|---|---|
| Load/Refresh | `switchMap` | Unsubscribe the obsolete read, emit its cancellation, start the replacement; stale results cannot settle the new operation |
| Create | `exhaustMap` admission into the shared write queue | Capture the trimmed draft; ignore repeated creates while the accepted create waits or runs; release on success, failure or rejected admission |
| Create/update/delete | One `concatMap` queue | Default capacity 32, including active and waiting writes; configurable positive safe integer; overflow emits a visible rejection without starting work |

Queue position is reserved before publishing `OPERATION_QUEUED`. A completion
latch makes that fact precede `OPERATION_STARTED`, including direct reentrant
consumers. Pending state includes all accepted waiting/running operations, with
one ID per operation. A queued start does not register it twice. Settlement removes
only the matching operation. Form submission is disabled with `Adding…` and
`aria-busy` while its create is pending, including time spent behind another write.
Success preserves a newer draft.

Each finite capability settles on its first result and releases its subscription.
Empty completion becomes a recoverable missing-result failure. Thrown service
errors, transport errors and malformed service results become operation failures;
the next intent can still run. Interpretation/projection faults outside that
capability boundary terminate the effect graph and reach the host's error reporter.
Render work runs inside `tap`, so a thrown render fault also triggers owned cleanup.
Disposal releases requests/listeners/model and drops waiting writes. A replacement
read cannot cancel an accepted mutation. Natural source completion drains accepted
work; a never-settling capability remains pending until cancellation/disposal.
No arbitrary timeout, automatic retry, per-entity queues or generic effect runtime
was added.

Shared route metadata declares JSON with a Zod schema, empty status 204, or stream.
`createClient(contract, { fetch })` is injectable and subscription-driven. It checks
status before success decoding, reads JSON into `unknown`, validates with the route
schema and returns decoded domain values. The empty contract requires exactly an
empty 204 response; DELETE has no blanket success shortcut. The finite client
rejects streaming routes before fetching. Structured failures retain kind, status,
message, error body and details; diagnostic cause stays out of remembered state.
Non-JSON error bodies still produce HTTP failures. An error while reading an HTTP
error body retains the HTTP status.

Each subscription owns an AbortController and any active body reader. Unsubscribing
before headers aborts the request; unsubscribing during body consumption also
cancels the reader. Reader locks are released, and an injected transport's late
headers are discarded with body cancellation. Successful/error settlement releases
resources without manufacturing cancellation facts.

`fromEventSource` now requires an explicit `unknown` decoder and accepts an injected
EventSource factory. Malformed JSON, decoder failure and transport error terminate
and close that subscription exactly once. This repairs the generic ingestion
boundary; it does not activate application SSE, implement snapshots/revisions, or
change the existing terminal-on-error policy into reconnection. Those remain M06.

## Visible, executable evidence

The integrated HTTP failure test loads two Todos, receives DELETE **409** with
`{ error: 'Conflict', details: { id: '1' } }`, and checks the visible `Conflict`
message, preserved Todo, empty pending state and retained structured failure.
The next DELETE receives **204** and removes only that Todo. Three extra consumers
of each public stream do not increase the expected three total HTTP requests.
A separate malformed-create case retains the draft and accepts the next valid
create. These run through the real client decoder and app feedback loop with
injected native `Response` objects.

The Refresh integration test holds an actual `ReadableStream` body open. Pressing
Refresh aborts the first request, cancels its locked body once and renders only the
new response. The policy marble test records this same event order:

| Virtual frame | Fact | Transport subscription |
|---:|---|---|
| 0 | Load 1 started | Old read subscribes |
| 3 | Load 1 cancelled, load 2 started | Old read unsubscribes; new read subscribes |
| 5 | Load 2 succeeds | New read unsubscribes on its first result; old scheduled value is suppressed |

The write-policy test accepts update/delete/create at frames 0/2/4. Their asserted
inner subscription intervals are **[0,4]**, **[4,6]**, **[6,7]**. Update succeeds,
delete fails, then create succeeds. Separate tests cover exhausted creates while
queued, bounded overflow, reentrant admission order, synchronous producers and
disposal from started/queued/result publication.

Run the readable checkpoint from the repository:

```bash
npx vitest run src/client/todo.intents.test.ts src/client/todo.effects.test.ts src/client/api.test.ts src/client/todo.service.test.ts src/client/sse.test.ts src/client/effect-app.test.ts
```

For normal interactive Todo use, run the retained `npm run dev:server` and
`npm run dev:client` workflows in separate terminals.
The Worker preview remains the M05a foundation: `/api/todos` deliberately returns
404 until M05b. The new Refresh button and pending submission display are small
M03 policy affordances; keyed rendering and targeted DOM ownership remain M04.

## Acceptance criteria

| M03 criterion | Executed evidence | Result |
|---|---|---|
| Relevant non-2xx statuses become failure events | Parameterized client status/error-body tests; effects normalize failures; integrated DELETE 409 preserves the Todo and server details | Pass |
| Valid 204 succeeds | Empty-contract tests and integrated retry ending in `DELETE_SUCCEEDED` | Pass |
| Malformed bodies fail safely | Invalid JSON/domain schemas, wrong update identity, malformed injected service results and explicit SSE decoder tests; next create recovers | Pass |
| Cancellation before headers and during body releases resources | Abort-signal assertions, locked-reader cancellation/release, late-header disposal and Refresh integration | Pass |
| Policy marbles assert inner subscription intervals | Latest read, one ordered write queue, create exhaustion, capacity and owner-disposal tests use `expectSubscriptions` | Pass |
| Failure does not disable the next intent | Failed queued write followed by create, DELETE 409 then 204, malformed create then valid create | Pass |
| Additional consumers do not duplicate requests | Multiple state/view-model/transition consumers in integrated app and effect/model ownership tests | Pass |

Final totals: **451 tests / 30 Node/DOM files + 16 tests / 1 workerd file = 467 tests**.
This includes 69 intent/effect tests and eight new complete-app cases. M01/M02
ownership tests remain; the row-rebuild-during-write case now uses a refresh
snapshot because create correctly waits behind that write. The separate M00
characterization branch remains untouched. Its HTTP DELETE/status failures now
have tested replacements; M03 adds abort/body-consumption coverage, alongside
prior ownership/startup fixes. The M00 API probes did not exercise cancellation.

## Commands and results

Local Node **22.22.1**, npm **11.9.0**, RxJS **7.8.2**, TypeScript **6.0.3**, Vite
**8.0.12**, Vitest **4.1.6**. M05a's Hono/Cloudflare dependencies are unchanged.

| Command/check | Result |
|---|---|
| Baseline `npm test` | Pass: 318 Node/DOM tests / 27 files at PR #7 merge |
| Initial HTTP regression tests | Expected failures before implementing injected transport and response metadata; final HTTP suite passes |
| Intermediate TypeScript checks | Detected nullable DOM closure narrowing, missing error annotation and a void marble fixture; fixed before final checks |
| Independent policy review probe | Detected reentrant queue inversion; fixed and regression-tested; first probe invocation also hit a local tsx IPC restriction, resolved using Node's tsx import |
| `npm ci` | Pass: clean lockfile install, 153 packages |
| `npm run typecheck` | Pass: generated types and all five TypeScript projects |
| `npm test` | Pass: 451 Node/DOM tests / 30 files |
| `npm run test:worker` | Pass: 16 tests in workerd |
| `npm run cf:typecheck` | Pass: generated Worker types current |
| `npm run build:worker` | Pass: client 97.58 kB JS; Worker 103.38 kB JS |
| `npm run smoke:worker` | Pass: real local built-preview HTTP, client asset, foundation API and routing precedence |
| `git diff --check` and unchanged-boundary diff | Pass |

Git inspection used fetch/status/log/diff/rev-parse and destination-only remote
verification. PR #7 was verified merged; `main` was rechecked at the same starting
commit before publication. Repository reads and `rg` located the current roadmap,
contracts, ownership code and tests. The staged implementation tree was compared
with `git write-tree` before GitHub tree/commit/branch publication. Fetch and a
tree-equality-guarded `git reset --soft` synchronize the local commit without
discarding working changes. No merge is automatic.

## Blockers and limits

No local M03 blocker remains. Review fixed reentrant FIFO admission and render
fault cleanup; final gates pass. Proxy/experimental and inherited punycode warnings
are informational. Linux/jsdom, native streams, local workerd and preview HTTP are
verified; this does not claim a manual browser session, Windows execution or a
deployment.

The client queue orders one mounted app's accepted writes. Cancellation is not
proof that a remote write rolled back, and client ordering is not cross-client
transactional ordering. Hono Todo integration remains M05b, collection authority
M05c, and live convergence M06. The same HTTP outcome cases must run against the
Hono boundary in M05b. Hono context and Worker bindings never enter core reducers
or effect capabilities. No M04 or later implementation is included.
