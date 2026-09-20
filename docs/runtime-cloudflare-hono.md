# ADR: Cloudflare Workers and Hono runtime direction

Date: 2026-09-17. Plan revision: **rxjs-flow migration r2 — Cloudflare/Hono**.

**Decision status:** selected planning direction following the owner's request to revise the plan. This document does not mean that Hono, Wrangler, a Worker, or Durable Object storage has been implemented or deployed. Repository adoption is reviewed through the documentation PR; implementation remains governed by the [canonical roadmap](roadmap-gpt-6-astra-2026-09-15.md).

**Inspected implementation baseline:** `c9197b68591e390a0a3add4667e5dd23717d6b6e` (`main`, M00 closeout, PR #2). M00 stays accepted. At that inspected planning baseline, M01–M09 were pending and the application used Node HTTP and an in-memory Todo store. Subsequent implementation status follows below.

**Subsequent implementation checkpoint:** M01 merged in PR #5 at `188f21f`.
M05a is accepted/merged in PR #6 at `eeb8d29`, with [local foundation evidence](m05a/acceptance.md):
a Hono/RxJS probe, generated types, Vite/Worker builds, workerd tests and local
preview. M04 is accepted/merged in PR #9 at `2b316a4`. M05b's
[owned finite HTTP and compatibility](m05b/acceptance.md) is accepted/merged in
PR #10 at `1cfbaec`. M05c is [accepted/merged in PR #11](m05c/acceptance.md) at
`d5500da`, with durable authority and a [local restart checkpoint](m05c/local-development.md).
M05d is [accepted/merged in PR #12](m05d/acceptance.md) at `540faec`, completing
parent M05. M06 is accepted and merged in PR #13 at
`36d644f529d5660506d6f2aa90e90af562d01440`; it implements
[typed live synchronization and recovery](m06/acceptance.md). The inspected planning baseline above is historical.
M07 reference-app completion is [accepted/merged in PR #14](m07/acceptance.md)
at `92f25680072da22d45e815ac411abd3651d002a5`. The owner explicitly authorized
M08 from that verified merge; its [temporal-trace implementation](m08/acceptance.md)
is locally verified with acceptance review/merge pending. M09 and deployment remain pending.

## 1. Context and authority

The owner has already started using Cloudflare with `netxpert.ch` and has selected Cloudflare as the deployment direction. This is owner-provided context, not an inspection of DNS, account resources, or a running application. Hono is selected for HTTP integration; RxJS 7 and TypeScript remain the application model.

The architectural lesson from the supplied SolidStart talk is separation of responsibilities, not adoption of its entire dependency stack. Our concrete choices below are project decisions, not claims that the speaker prescribed an RxJS/Hono architecture.

The decision supersedes the r1 requirement to retain Node HTTP as the permanent server architecture and the future Node-only delivery choice in [M00's build/start record](m00/build-start-strategy.md). It does not supersede or invalidate M00's executed evidence, source audit, authorship, license, or Git history. The r1 roadmap and architecture are retained under `docs/archive/`.

## 2. Responsibility allocation

| Layer | Selected owner | Boundary |
|---|---|---|
| Application dataflow | RxJS 7 + TypeScript + named domain functions | Typed messages, state transitions, effect policies, sharing, time and cancellation. |
| Browser rendering | Existing custom JSX and scope-owned DOM bindings | Targeted updates, keyed rows, focus/draft preservation and disposal. |
| HTTP integration | Hono plus a small rxjs-flow adapter | Matching, middleware and responses; extract values/capabilities before invoking application operations. |
| Server execution | Cloudflare Workers | Fetch request/response and platform binding boundary. |
| Shared Todo authority | One Durable Object per logical collection | Persisted state identity/revision, serialized validated mutations and committed snapshots. |
| Development/build | Vite + Cloudflare Vite plugin | Separate browser and Worker entries; build and preview in the selected runtime. |
| Cloudflare operations | Project-local Wrangler | Developer authentication, Worker configuration, generated types and separately authorized deployment. |

Hono's documented Workers integration exposes `app.fetch` and typed environment bindings [1]. Its context must not become an input to domain reducers. Hono HTTP middleware and rxjs-flow's existing RxJS `Middleware` are distinct contracts; adapt them deliberately rather than renaming one into the other. Preserve the existing stream-to-stream meaning of server `Effect`, with explicit type migration where Node-specific fields must change.

No adoption of Hono JSX, HonoX, Nitro, Vinxi, Bun, a second reactive state engine, a new browser router, or a custom CLI is implied. The separate `rxjs-fullstack` repository remains out of scope; this decision selects Hono independently and does not import that project's assumptions or milestone claims.

## 3. Lifetimes and execution

Application construction describes the graph. Activation connects it. Disposal releases owned resources. Importing application modules must not issue requests, open connections, subscribe to effects, or mutate application state. Inert Hono route registration and platform entry exports are allowed; defining a route is not starting an operation.

Keep request, live-response, authority activation and local development-server lifetimes distinct. A request-local operation receives an existing authority capability; it does not initialize a new empty database per request. An SSE connection owns its delivery subscription, not the logical collection.

At the host boundary, translate an owned Observable operation to the required response interface. Define finite-response cardinality, empty-result behavior, a bounded settlement policy, synchronous failure handling and teardown. Returning a streaming `Response` does not end the response-body lifetime.

An RxJS subscription is not a durable job or a platform keep-alive guarantee. Cloudflare documents invocation-bound execution and bounded `waitUntil()` extensions [5]. Do not use detached subscriptions or timers to implement perpetual background services. Cancellation must connect through the adapter to supported transport teardown; it does not reverse an accepted mutation.

## 4. Shared-state authority: a deliberate scope increase

Workers may handle requests in different instances; mutable Worker-global state is not a reliable deployed authority [4]. Local multicasting and local ordered queues do not establish consistency across those instances.

The r2 reference target selects one Durable Object per authorized logical Todo collection, using its attached durable storage. The minimum persisted representation contains the collection state, a schema version, a state-generation identifier and a revision. Use the simplest supported storage layout; no ORM, multi-database layer, event log, tenant-management product or general actor framework is required.

A thin platform entry class may delegate to function-based domain and dataflow code. This is a limited adapter exception to the function-first preference, not permission to introduce application class hierarchies. Durable Objects expose an entry-class API and private transactional storage [6]. They can be restarted, so correctness must not depend on a permanently resident Observable graph [7].

M05c must define and test the serialized read/validate/transition/commit boundary. Persist state and ordering metadata consistently before acknowledging a successful commit or publishing it as committed. Do not treat single-threaded JavaScript or `concatMap` in one browser as a transaction guarantee. Concurrent callers and interleaving around asynchronous work must be tested.

On storage failure, expose a typed failure and leave the prior committed state authoritative; speculative in-memory reductions must not leak as committed snapshots. After restart, reconstruct the same history. If a commit succeeds but a response is lost, report an uncertain outcome rather than automatically retrying a non-idempotent mutation. Exactly-once execution is not promised.

Collection identity is not authorization. The HTTP/authority boundary must enforce the intended access policy before selecting an authority; a public demo needs explicit release scoping and must not expose a privileged storage endpoint. Two independent test stores remain isolated. Two request handlers intentionally addressing the same collection must observe the same authority.

The in-memory Node store remains useful for baseline and pure contract tests, with its reset-on-restart limitation stated. It is not acceptance evidence for the deployed shared-state requirement. Data backup, disaster recovery, production capacity and full operational readiness remain separate claims.

**M05c implementation:** `TodoCollection` delegates to `createTodoAuthority` and
uses a SQLite-backed Durable Object binding `TODO_COLLECTIONS`. Migration
`m05c-v1` declares the class locally. Synchronous `storage.kv` reads/writes inside
`transactionSync()` keep the single `snapshot` envelope atomic; a successful
`storage.sync()` precedes acknowledgment. The envelope is schema version 1 and
contains `collectionId`, `stateGeneration`, `revision` and `todos`. Existing stored
state is validated on reads. Unsupported/corrupt storage fails without replacing
history. A new collection starts empty; no volatile M05b state is migrated.

Limits are 32 admitted application operations including one active operation,
1,000 Todos and 120 KiB of encoded snapshot JSON. M05d adds a separate maximum of 32 active or registering live subscribers. These are application budgets, not a claim that Cloudflare's internal
delivery queues or overall service capacity have been bounded. Overflow fails
before a proposed state is committed. Identity and time are injected into the
shared named pure transitions.

The explicit access policy is local development only. The server is bound to
loopback; authorization requires a loopback request URL, matching Origin when
present, no cross-site fetch indicator, and no request-supplied collection
selector. Trusted configuration chooses `local-reference`. The deployed
configuration keeps `TODO_ACCESS_POLICY=disabled`; development enables
`local-loopback`, and executing the built artifact locally requires an explicit Wrangler command. This is
not end-user authentication or a production release policy. No remote resource,
migration or deployment was performed.

The normal local runtime persists below `.wrangler/state`. Tests and automated
restart checkpoints use isolated storage. Known rollback reports a failed commit;
flush failure or lost RPC response reports an uncertain outcome. A flush failure
blocks that activation from advertising further snapshots. Reconstruction reads
committed storage again; no automatic mutation retry or rollback-on-disconnect
is promised. See [M05c acceptance](m05c/acceptance.md) for exact evidence and limits.

## 5. Snapshot and SSE contract

Retain HTTP for operations and SSE for live collection snapshots. The authority supplies committed full snapshots; mutation responses settle operation state rather than independently appending items to the UI collection.

The ordering identity is `collectionId + stateGeneration + revision`. M06 publishes these fields in the runtime-decoded schema-version-1 `todo-snapshot` event on a new `/todos/live` route, retaining `/todos/stream` as the legacy bare-array route. Generation denotes a collection history, not a Worker instance. It survives ordinary request handling and authority reconstruction; explicit reset/replacement creates a new history. Revisions increase within a history. Compare revisions only within the same collection and generation.

Track connection identity separately. Drop notifications from superseded connections, and accept a new generation only through the defined current-connection/resynchronization policy. Do not accept arbitrary delayed payloads merely because their generation differs.

M05d must prove the authority-to-Worker response path as well as browser disconnect handling. Initial snapshot acquisition and attachment to live updates must not lose a committed update; use a serialized registration/snapshot step or an equivalently tested handoff. The transport can coalesce full snapshots under a bounded latest-snapshot policy, but must not silently discard domain events.

Hono's streaming helper exposes abort handling and closes the stream when its callback completes [2]. The callback and owned subscription therefore need aligned lifetimes. Register cancellation safely before synchronous emissions; handle already-aborted input; serialize and await transport writes; prevent an unbounded chain of pending write promises. Post-header errors cannot be converted into a fresh JSON error response. Terminate or signal a documented protocol failure and release resources.

One client disconnect must not stop another client's response or delete committed state. A dropped connection is repaired by a new full snapshot, not by an exactly-once event-delivery claim. Persisted storage does not make live subscriptions durable or make SSE hibernate automatically. Measure active streaming resource use before deployment; do not replace SSE with WebSockets within this revision.

**M05d implementation:** authority `watch$()` uses the serialized owner for an
atomic initial committed snapshot and live registration. Mutations publish only
after storage settlement; storage failure interrupts live observers instead of
advertising speculative state. Client count never owns collection persistence.

A private Durable Object Fetch response carries newline-delimited internal
snapshot envelopes. A cold Worker reader bounds and validates each envelope,
then maps it to the retained public `todos` event containing a bare Todo array.
The Hono adapter returns a standards-based streaming Response with a separate
body owner; it does not use a prematurely returning streaming-helper callback.
The finite descriptor deadline does not limit the live body's lifetime.
The incoming-request `enable_request_signal` flag remains explicit, and reader
cancellation closes the upstream response as well as aborting a pending fetch.

Generic delivery preserves FIFO order with at most 16 pending frames, 256 KiB
pending bytes and 128 KiB per frame. Complete Todo snapshots explicitly choose
latest-snapshot coalescing with one pending snapshot. The authority transport's
maximum NDJSON frame is 120 KiB plus its newline. Overflow, encoding failure,
source error and interruption terminate the affected stream, release buffers and
subscriptions, and do not substitute JSON after headers. Native transport buffers
are outside these application counts. There are no detached write chains,
perpetual timer subscriptions, heartbeat service or hibernation claim.

The [M05d live checkpoint](m05d/local-development.md) preserves the legacy
transport demonstration. M06 connects the actual Todo application to a separate
versioned live route; two pages now converge without Refresh. One mounted app
owns one connection, independent of the number of state/view consumers.
HTTP mutation replies settle pending operations; accepted committed snapshots
alone replace the collection. A separate connection identity rejects superseded
callbacks. The first valid snapshot pins the collection; only the first snapshot
of a new current connection can establish changed history. Older/duplicate
revisions never replace accepted collection content.

The RxJS connection owner immediately closes an interrupted EventSource, then
schedules at most four retries after 1, 2, 4 and 8 seconds using injected timing.
Each attempt has a 10-second first-snapshot deadline. It is not an idle watchdog:
there is no heartbeat or fixed detection time for a later silent partition.
A valid snapshot resets consecutive failures; protocol failure and exhaustion
require manual Reconnect.
Disposal cancels the active source and scheduled work. Native EventSource retry
does not run alongside this policy. Loading before the first snapshot and stale/
reconnecting status during a gap are visible in the app; the latest accepted
collection remains visible. The [M06 guide](m06/local-development.md) records the
two-page synchronization/restart workflow. Local cancellation is not rollback,
and reconnect never automatically replays an uncertain mutation.

Node remains a tested retained mode
with an in-memory collection and a fresh generation per factory/reset, at most
32 active SSE responses per listener, `drain`-aware writes, explicit stream
shutdown and port release. Durable restart instead preserves history. M09
reviews its final support disposition. No remote deployment was performed.

M07 completes the reference UI around these unchanged HTTP/SSE boundaries.
Local filters and captured draft revisions stay in browser state; server
validation and committed snapshots remain authoritative. The [M07 checkpoint](m07/local-development.md)
runs the same two-context browser scenario in Vite/Cloudflare development and
against built browser/Worker output. A preserved browser entry export exposes
the ordinary app lifetime for explicit disposal/remount tests; this build change
does not alter Worker access policy, persistence, bindings or routing.
Current results and controlled failure/delay probes are recorded in
[M07 acceptance](m07/acceptance.md).

## 6. Vite and Wrangler workflow

Use Vite plus the official Cloudflare plugin for browser/Worker development, build and runtime preview [3]. Use project-local Wrangler for platform operations. Verify compatible package versions and pin the resolved toolchain/lockfile in M05a; this documentation revision adds no dependencies and assumes no particular future latest version.

`wrangler.jsonc` is the planned source of Worker configuration. Keep entry points, compatibility date/flags, bindings, migration declarations and environments explicit. Keep browser, Worker and Node-tooling TypeScript environments separate; generate Worker binding types with `wrangler types` [9]. Do not hide incompatible ambient types with an unrestricted shared environment.

After Wrangler is installed, document `npx wrangler login` and `npx wrangler whoami` for interactive developer authentication [8]. Device authorization is an optional version-checked alternative when needed. Login is not application-user authentication. Local tests/builds should not require a developer's production credentials. Do not auto-provision resources or enable remote bindings during local verification.

CI deployment credentials, application secrets and interactive OAuth state are separate. Keep credentials out of Git and out of documentation examples; ignore local secret files. Select least-privilege deployment access during a separately authorized release setup, not as a side effect of a plan change.

Do not rerun a starter generator over the repository. Use the existing Vite/JSX application. Define the same-origin asset/API arrangement, including whether `/api` is retained or stripped, and test unknown API routes/auth failures against HTML-fallback interception. M05a establishes the build path; M09 completes its documented delivery evidence.

## 7. Migration and evidence gates

M00 remains closed. The recommended order is:

`M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07 → M08 → M09`.

Retain the Node baseline until corresponding behavior has Worker acceptance evidence. Node listen/readiness/stop/port-release checks remain applicable to a supported Node adapter. Before deleting or retiring it, map its characterized failures to either a verified fix or a tested replacement, and document the support decision. Do not maintain two competing routing implementations indefinitely and do not remove tests merely to make a migration appear complete.

M05a must add a compatible Workers-runtime test setup, not wait until M08. Cloudflare provides an official Vitest integration [10]. M08 adds adversarial cross-boundary evidence. Pure reducer, RxJS policy, DOM, Worker, real-transport and browser tests have distinct responsibilities; one layer does not substitute for the others.

M08's opt-in trace capability records the already owned request, response and
authority boundaries. A local test may construct the functional authority over
actual attached SQLite and join Hono/client metadata through a trusted
in-process diagnostic bridge. This demonstrates the implementation in workerd;
it is not evidence that a test controlled Cloudflare's global routing or traced
production RPC across remote instances. No public tracing headers, Worker
bindings, environment settings or access-policy changes are needed. Native
browser runs separately observe real HTTP/EventSource and client records.

Runtime-local sequences and clocks stay separate. Committed history and explicit
operation correlation explain causality; wall-clock sorting does not create a
distributed total order. Trace-disabled/enabled comparisons and direct resource
counts check that observation does not repeat effects or retain owned work. See
[M08 acceptance](m08/acceptance.md) and [temporal traces](m08/temporal-traces.md).

## 8. Release and non-goals

This decision authorizes a documentation revision only. It does not authorize merging, starting implementation, publishing packages, creating remote resources, deploying, enabling automatic deployment, or changing `netxpert.ch` DNS, routes, domains, secrets or account settings.

Completion of local tests means local runtime verification. A deployable build means deployment readiness. Only an explicitly authorized, recorded remote verification establishes deployed behavior. Keep those claims separate, and require a documented release access policy before any public demo.

SSR/hydration/islands, browser routing, Hono JSX, server-function extraction, a plugin ecosystem, multi-provider portability, jobs/queues and rich devtools remain deferred. The distinctive work is the RxJS dataflow/lifecycle contract and custom rendering integration, not reimplementation of infrastructure.

## 9. Primary references checked on 2026-09-17

These references support platform facts, not claims that this repository has implemented them. Recheck against the pinned versions during implementation.

1. [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
2. [Hono streaming helper](https://hono.dev/docs/helpers/streaming)
3. [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
4. [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)
5. [Worker execution context](https://developers.cloudflare.com/workers/runtime-apis/context/)
6. [Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
7. [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
8. [Wrangler authentication commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)
9. [Worker TypeScript and generated types](https://developers.cloudflare.com/workers/languages/typescript/)
10. [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
