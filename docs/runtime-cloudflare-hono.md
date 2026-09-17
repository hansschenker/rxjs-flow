# ADR: Cloudflare Workers and Hono runtime direction

Date: 2026-09-17. Plan revision: **rxjs-flow migration r2 — Cloudflare/Hono**.

**Decision status:** selected planning direction following the owner's request to revise the plan. This document does not mean that Hono, Wrangler, a Worker, or Durable Object storage has been implemented or deployed. Repository adoption is reviewed through the documentation PR; implementation remains governed by the [canonical roadmap](roadmap-gpt-6-astra-2026-09-15.md).

**Inspected implementation baseline:** `c9197b68591e390a0a3add4667e5dd23717d6b6e` (`main`, M00 closeout, PR #2). M00 stays accepted. M01–M09 remain pending. The original application uses Node HTTP and an in-memory Todo store.

**Subsequent implementation checkpoint:** M01 merged in PR #5 at `188f21f`.
M05a now has [local foundation evidence awaiting review](m05a/acceptance.md):
a Hono/RxJS probe, generated types, Vite/Worker builds, workerd tests and local
preview. The inspected planning baseline above is historical. Todo migration,
durable authority, live synchronization and deployment remain unimplemented.

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

## 5. Snapshot and SSE contract

Retain HTTP for operations and SSE for live collection snapshots. The authority supplies committed full snapshots; mutation responses settle operation state rather than independently appending items to the UI collection.

The target ordering identity is `collectionId + stateGeneration + revision`. Names are proposed wire fields until M06 publishes a versioned schema. Generation denotes a collection history, not a Worker instance. It survives ordinary request handling and authority reconstruction; explicit reset/replacement creates a new history. Revisions increase within a history. Compare revisions only within the same collection and generation.

Track connection identity separately. Drop notifications from superseded connections, and accept a new generation only through the defined current-connection/resynchronization policy. Do not accept arbitrary delayed payloads merely because their generation differs.

M05d must prove the authority-to-Worker response path as well as browser disconnect handling. Initial snapshot acquisition and attachment to live updates must not lose a committed update; use a serialized registration/snapshot step or an equivalently tested handoff. The transport can coalesce full snapshots under a bounded latest-snapshot policy, but must not silently discard domain events.

Hono's streaming helper exposes abort handling and closes the stream when its callback completes [2]. The callback and owned subscription therefore need aligned lifetimes. Register cancellation safely before synchronous emissions; handle already-aborted input; serialize and await transport writes; prevent an unbounded chain of pending write promises. Post-header errors cannot be converted into a fresh JSON error response. Terminate or signal a documented protocol failure and release resources.

One client disconnect must not stop another client's response or delete committed state. A dropped connection is repaired by a new full snapshot, not by an exactly-once event-delivery claim. Persisted storage does not make live subscriptions durable or make SSE hibernate automatically. Measure active streaming resource use before deployment; do not replace SSE with WebSockets within this revision.

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
