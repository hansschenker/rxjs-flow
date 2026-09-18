# M05c — Durable shared Todo authority

Date: 2026-09-18. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented; acceptance review/merge pending.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m05c/durable-todos`.
- Starting commit: **`1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`**, verified
  `main` and the merged [M05b PR #10](https://github.com/hansschenker/rxjs-flow/pull/10).
- Implementation commit: **`48b9a8a71de5167f9de9fa94fbb3109b07a3c055`**.
- Implementation tree: **`23f1daa0ce5f9df52106d6084718b150a974f202`**.
- [Execution record](execution.json): commands, versions, captured exit codes,
  baseline/final results, intermediate failures and their dispositions.
- [Runnable checkpoint](local-development.md): the existing page, two independent
  HTTP callers, overlapping mutations and restart against the same local storage.

The owner explicitly authorized M05c after confirming M05b's layout and input
preservation during Refresh. That manual observation confirms the M05b layout/Refresh behavior;
it does not independently verify M05c durability. M05c keeps RxJS 7, the shared
HTTP contracts, existing client and custom renderer. No remote resource creation,
remote migration, deployment, release or domain/account change was performed.
M05d live delivery and M06 application live integration remain pending.

## Acceptance criteria

The seven checks below map directly to the canonical roadmap's M05c acceptance.
Final command evidence is recorded below and in `execution.json`.

| Criterion | Implementation and evidence | Result |
|---|---|---|
| Independent in-memory test stores remain isolated | Separate `createTodoStore()` and memory repository instances use the same pure transitions without sharing mutable collection state. | Pass |
| Independent handlers for the same authorized collection see the same committed state | Each request receives a cold repository capability addressed through one configured Durable Object identity; independent workerd handlers and actual HTTP callers read each other's accepted writes. | Pass |
| Different collection identities remain isolated | Trusted test configurations address separate named Durable Objects; request-supplied collection selectors are rejected before authority selection. | Pass |
| Concurrent writes do not lose updates | The bounded owner serializes admitted operations; SQLite protects read/validate/transition/write atomically. Delayed/interleaved authority tests and overlapping actual HTTP writes check preserved creates and distinct updates to one Todo. | Pass |
| Revision and state persist consistently | One schema-versioned envelope stores identity, generation, revision and Todos. Each successful mutation advances one revision; reads preserve it. Results follow transaction and storage flush completion. | Pass |
| Storage failure and authority reconstruction are tested | Injected rollback/flush failures exercise failure outcomes. Workerd reconstruction and full local runtime stop/restart recover stored history; two fresh HTTP callers read the exact collection. | Pass |
| No speculative snapshot is advertised as committed | Results wait for durable settlement. Rejected transitions leave the stored envelope unchanged; uncertain flush blocks that activation. Lost-response tests distinguish committed state from delivery uncertainty. | Pass |

## Storage and operation ownership

`TodoRepository` exposes finite `list$`, `create$`, `update$` and `delete$`
capabilities. The domain Effects keep their stream-to-stream contract and runtime
validation. The retained memory adapter and durable authority reuse named
`createTodoTransition`, `updateTodoTransition`, `deleteTodoTransition` and
`filterTodos` functions. IDs and timestamps enter as boundary values; pure
transitions neither read platform bindings nor mutate their input.

The platform-required `TodoCollection` class delegates to the functional
`createTodoAuthority`. `TODO_COLLECTIONS` binds one SQLite-backed Durable Object
per configured logical collection. Migration `m05c-v1` declares
`new_sqlite_classes: ["TodoCollection"]`; it was exercised locally only.

Storage uses one `snapshot` key through synchronous SQLite KV APIs. Its envelope
is `{ schemaVersion: 1, collectionId, stateGeneration, revision, todos }`.
`transactionSync()` reads, validates, computes and writes the whole envelope in
one transaction. `storage.sync()` must succeed before the operation emits its
single result. The FIFO owner bounds admitted application work; SQLite supplies
the atomic commit boundary. Neither `concatMap` nor single-threaded execution
alone is treated as a persistence guarantee.

A new collection starts empty at revision 0 with an injected generation. The
first successful mutation produces revision 1. Existing state is decoded and
validated rather than silently replaced. Ordinary reconstruction preserves its
history identity. Unsupported schema, invalid stored state or identity mismatch
fails closed; there is no automatic destructive reset or speculative migration.
M05b's volatile sample contents are not automatically transferred.

An authority operation is inert until first subscription. The returned result
replays one settlement without duplicating the admitted operation. Unsubscribing
an HTTP observer stops local delivery; it does not cancel a mutation already
accepted by the authority. Admitted operations remain owned through settlement within the current activation.
Abrupt host termination can still interrupt work; durable state supplies recovery.
RPC Promise conversion stays inside the platform adapter, returned RPC objects
are disposed, and no automatic non-idempotent retry is added. Durable Object
`waitUntil()` has no effect, so no artificial lifetime extension was added;
see the [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/#waituntil).

| Boundary/failure | Outcome |
|---|---|
| Rejected input, missing Todo, duplicate identity or capacity violation | Defined failure before commit; no successful snapshot result |
| Synchronous storage transaction/callback failure | Rolled back; 503 storage error reports `outcome: "not-committed"` unless a more specific domain error applies |
| Storage flush failure after the transaction returns | 503 with `outcome: "unknown"`; this activation rejects further reads/writes until reconstructed |
| RPC response lost after accepted work | 503 with `outcome: "unknown"`; the mutation may already be committed |
| HTTP cancellation or deadline | Existing request owner terminates local response work; it does not establish remote rollback |

The internal snapshot and authority result schema are validated at the adapter
boundary. They do not introduce the application SSE wire protocol, which remains
M06. There is no public snapshot-admin endpoint or collection reset endpoint.

## Policy, bounds and remaining task coverage

The minimum reference policy is **local development only**. Trusted configuration
selects `local-reference`. Authorization checks a loopback request URL, matching
Origin when provided and no cross-site fetch indicator. Recognized query/header
collection selectors are rejected before obtaining a Durable Object stub. A
collection name is an address, never proof of access.

Development binds to loopback and enables `local-loopback` through the supported
Vite plugin configuration. Checked-in Wrangler and built configuration retain
`TODO_ACCESS_POLICY=disabled`; default Vite preview returns 503 for Todos.
An explicit local Wrangler command enables the built checkpoint. Early access
failures cancel any unlocked unread request body, preserving M05b cleanup. Access
policy is evaluated before the stream route: disabled access returns 503, while
authorized local streaming remains 501. No production
user-authentication policy or public release is claimed.

| Resource | Application budget |
|---|---|
| Active plus waiting authority operations | 32 total, including at most one active operation; overflow 503 before admission |
| Todos per collection | 1,000; a proposed overflow returns 507 before commit |
| Encoded snapshot JSON | 120 KiB; a proposed overflow returns 507 before commit |
| Revision | Nonnegative safe integer; exhaustion returns 507 without wrapping |
| Active live subscribers | 0 in M05c; no live registration API or retained subscription |

These application budgets do not bound Cloudflare's internal delivery queues or
establish overall production capacity. Persisted state outlives an activation;
running subscriptions do not persist. M05d must implement and test the race-free
current-snapshot/live-registration handoff at this authority. A separate read
followed by a later live subscription is not accepted as that proof. No ORM,
event log, job system, backup product or alternative database is introduced.

This covers roadmap tasks 1–3 (identity, capability and attached persistence),
4–6 (atomic commit, shared pure transitions and recovery), and 7–8 (budgets and
explicitly deferred live handoff).

## Verification and limits

The starting baseline passed **570 Node/DOM tests and 86 workerd tests**.
Final verification:

| Command | Result |
|---|---|
| `npm test` | Pass — 629 tests / 38 files |
| `npm run test:worker` | Pass — 108 tests / 4 files, including 22 durable authority/access tests |
| `npm run typecheck` | Pass — all five TypeScript projects; test types repeated after final cleanup regression |
| `npm run cf:typecheck` | Pass — generated types match the declared binding/migration |
| `npm run build:worker` | Pass — Worker 286.46 kB; browser JS 102.70 kB and CSS 2.58 kB unchanged |
| `npm run smoke:worker` | Pass — assets/foundation/API precedence and access-disabled Todo 503 |
| `node scripts/m05c-checkpoint.mjs` | Pass — actual HTTP CRUD, two callers, concurrent creates/field updates and exact collection after full restart |
| `node scripts/m05c-checkpoint.mjs --preview` | Pass — built assets and Worker through local Wrangler; same two-caller/restart proof |
| `git diff --check` | Pass |

All **737 tests** passed locally. No M05c implementation blocker remains. The milestone PR records the exact review head and final CI result; acceptance/merge is pending. No new dependency install was needed locally because package.json and package-lock.json are unchanged; the PR CI performs a clean `npm ci`.

Evidence is separated by boundary: pure/domain tests exercise controlled storage
interleavings and failures; workerd tests exercise the actual Durable Object
binding and attached storage; HTTP checkpoints exercise actual local sockets,
assets, concurrent callers and full process restart. A simulated failure or local
reconstruction does not force Cloudflare's global deployment scheduler or prove a
remote outage/recovery scenario. The HTTP checkpoint does not inject storage
faults or prove lost-response handling by itself.

The built checkpoint exposed a production-only HTTP regression: Vite removed an
unused `decodeURIComponent(path)` validation expression, so malformed path input
reached the domain as a missing Todo (404). The adapter now consumes the decoded
value in an absolute-path guard, preserving validation in the optimized build.
The original expected 400 assertion remains. The rebuilt checkpoint passes it (`checkpoint-built-path-guard`).

The automated checkpoints use private temporary databases, separate from the
normal `.wrangler/state` development collection. No new automated browser suite
is claimed; the existing browser renderer and client remain unchanged. Local
durability is not deployed durability, backup, disaster recovery or production
readiness. The ChatGPT Project reference copy is separately unverified.
