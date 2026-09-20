# RxJS-Flow: dataflow implementation roadmap

Updated: 2026-09-20. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**. Filename retained: `roadmap-gpt-6-astra-2026-09-15.md`.

**ChatGPT Project:** `rxjs-flow`  
**Development repository:** `hansschenker/rxjs-flow`  
**Historical source repository:** `hansschenker/rxjs-stack`  
**Original audited source baseline:** `cbc91eefbccdeaf17221d06c75bdd237fe5e5499` on the source repository's `main`.  
**Inspected destination baseline for this revision:** `c9197b68591e390a0a3add4667e5dd23717d6b6e` on `rxjs-flow/main`.

**Implementation status, 2026-09-20:** M00 is accepted and closed by merged PR #2 at the destination baseline above. M01 is accepted/merged in PR #5 at `188f21f`. M05a is accepted/merged in PR #6 at `eeb8d29`. M02 is [accepted/merged in PR #7](m02/acceptance.md) at `7374557b6d264a9bfa572526a4f71233fc3aa24e`. M03 is [accepted/merged in PR #8](m03/acceptance.md) at `c64fda113b599ff9b0b21ae3e20aeff0c473a358`. M04 is [accepted/merged in PR #9](m04/acceptance.md) at `2b316a477600c91b3105c9e390949c29e90046d3`. M05b is [accepted/merged in PR #10](m05b/acceptance.md) at `1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`. M05c is [accepted/merged in PR #11](m05c/acceptance.md) at `d5500da407611e7856e9e67481a08e15e530aece`. Its [local Todo checkpoint](m05c/local-development.md) uses a configured Durable Object collection with attached SQLite storage, bounded admission, atomic state/metadata persistence and restart reconstruction. The built configuration leaves Todo access disabled; an explicit local Wrangler command is available. M05d is [accepted/merged in PR #12](m05d/acceptance.md) at `540faec7086bb58223c5f475db91710ac0e7389b`, completing parent M05. Its legacy [live checkpoint](m05d/local-development.md) remains available. M06 is [accepted/merged in PR #13](m06/acceptance.md) at `36d644f529d5660506d6f2aa90e90af562d01440`. The owner confirmed its [two-tab checkpoint](m06/local-development.md) and explicitly authorized M07 from that verified merge. M07 reference-app completion is [implemented; acceptance review/merge pending](m07/acceptance.md), with a [local application guide](m07/local-development.md). M08–M09 remain pending. The retained Node application and independent test stores remain in memory. The ChatGPT Project reference copy remains separately unverified.

This is a continuation of the existing application, not a fresh scaffold, repository rename, history reset or import from `rxjs-fullstack`. It explicitly amends r1's permanent Node HTTP and in-memory-only target assumptions. Preserve domain behavior and tested contracts while moving the platform boundary through reviewable steps. No runtime replacement occurs in this documentation change.

Read with the [dataflow architecture contract](dataflow-architecture.md), [Cloudflare/Hono runtime decision](runtime-cloudflare-hono.md), [M00 evidence](baseline-rxjs-flow-m00.md), and [historical source audit](repository-audit-2026-09-15.md).

## 0. Project identity, migration gate, and document authority

### One development destination

| Role | Identity | Rule |
|---|---|---|
| ChatGPT implementation workspace | `rxjs-flow` | Use this revision and the architecture contract; verify whether the reference copy matches. |
| Repository for new branches, commits and PRs | `hansschenker/rxjs-flow` | Verify the destination and current base before every write. |
| Original implementation/audit provenance | `hansschenker/rxjs-stack` | Read/reference only; do not modify, rename, archive or delete it. |
| Earlier source URL | `hansschenker/rxjs-full` | Historical alias, not the development destination. |
| Separate project | `hansschenker/rxjs-fullstack` | Out of scope. Selecting Hono here does not import its Bun assumptions, code or milestone claims. |

### M00 is closed; preserve its evidence

Recovery PR #1 merged at `27f8f2cbcc7ba68ff6bc1062ebf25cc46f363769`; closeout PR #2 merged at `c9197b68591e390a0a3add4667e5dd23717d6b6e`. The original application/history and dated acceptance evidence remain the baseline. Do not reopen M00 or repeat the import merely because the runtime target changes. A fresh checkout still requires ordinary environment verification and relevant current tests.

The original migration gate, exact provenance rules, M00 tasks and r1 acceptance requirements are retained in the [unmodified r1 roadmap snapshot](archive/roadmap-rxjs-flow-migration-r1-2026-09-15.md). Historical documentation commit `d701cb72f14293e96acac2cb163e6434e5fb0f54` and source PR `hansschenker/rxjs-stack#21` remain provenance, not current destination state. The separate characterization commit `5640870a1f5b0cc92946b42e8dba261fcd0eacb6` and `m00/characterize-baseline` probes must not be merged as an intentionally failing main baseline. Housekeeping commit `37735b6ef4b34d4b251514a9ab9161f6ff6ea601` removed an unused CLI; selecting Hono now does not undo that cleanup or prove Hono was present then.

No force pushes, reference deletion, re-import over new work, source-repository writes, credential copying, package publishing or deployment are authorized by this revision. Record new evidence against the actual destination commit, not a historical source CI run.

### One active roadmap

The canonical path remains **`docs/roadmap-gpt-6-astra-2026-09-15.md`**. `docs/roadmap.md` is an index, not a second plan. The architecture contract specifies behavior; `runtime-cloudflare-hono.md` records the supporting platform decision. Milestone status and dependencies belong here.

The [r1 roadmap](archive/roadmap-rxjs-flow-migration-r1-2026-09-15.md), [r1 architecture](archive/dataflow-architecture-r1-2026-09-15.md), historical source audit, prior release records and M00 logs are historical evidence. Archived snapshots are byte-preserved from the inspected baseline; their original relative links can be followed in the [baseline repository view](https://github.com/hansschenker/rxjs-flow/tree/c9197b68591e390a0a3add4667e5dd23717d6b6e), rather than interpreted as a competing active plan. Do not rewrite attribution or old repository names in them.

Only the future delivery choice in [M00's build/start strategy](m00/build-start-strategy.md) is superseded by the Cloudflare decision. Executed probes, reported limitations and original files remain evidence of the Node baseline. Plan approval, merge, implementation acceptance and deployment are distinct states. A plan revision does not complete an implementation milestone.

## 1. Product decision

Prioritize **a small reactive application core plus a complete reference application**, as the foundation for an RxJS-centered metaframework. Do not expand immediately into a general-purpose, batteries-included framework.

```text
events → Observable streams → state streams → derived streams → rendering
                      ↘ effect policies → external work → result events ↗
```

Rendering and network/storage effects are separate branches. Rendering must not initiate a server write. Results re-enter the state loop as typed messages. Across browser, Worker and state-authority boundaries, transport carries validated data, not Observable objects, subscriptions or automatic distributed cancellation.

Retain **RxJS 7**, TypeScript, the custom JSX factory, Zod validation, shared route contracts, the Todo application, authentication behavior and the HTTP/SSE starting point. Prefer named pure domain functions and function-based factories. Do not introduce a component framework, Zone.js, decorators or a second reactive state engine. Platform-required entry classes may delegate to the function-based core; that exception does not create an application class hierarchy.

### Selected infrastructure and bounded scope change

| Responsibility | r2 decision |
|---|---|
| Reactive application behavior and DOM integration | Owned by rxjs-flow; M01–M04 remain the core proof. |
| HTTP matching, middleware and response integration | Hono with a small, owned RxJS adapter; platform context stays outside domain functions. |
| Server execution target | Cloudflare Workers. Keep Node as the migration baseline until corresponding behavior is verified. |
| Shared Todo state | One Durable Object per logical collection, with minimal attached persistence and revision metadata. |
| Development/build | Vite with the official Cloudflare Vite plugin. Establish the path in M05a, not only at M09. |
| Cloudflare operations | Project-local Wrangler for authentication, configuration, generated types and separately authorized deployment. |

The first completion target is **architectural completeness for a client-rendered, real-time Todo application with a verified Cloudflare/Hono boundary and explicit durable shared-state authority**. M05c's minimum persistence is a deliberate addition to r1's in-memory-only scope, not an incidental deployment detail. No ORM, multi-provider database interface or production-readiness claim follows from it. Node in-memory mode remains useful for baseline/tests and is explicitly non-durable.

Cloudflare/Hono facts and current primary references are recorded in the [runtime decision](runtime-cloudflare-hono.md). Do not assume mutable Worker-global state is shared authority, or that an active Observable keeps a Worker alive. Hono handles HTTP, not distributed consistency. Hono's presence does not select Hono JSX, HonoX or a browser router.

## 2. Existing work to preserve

| Existing capability | Baseline paths | r2 treatment |
|---|---|---|
| Observable HTTP source and server `Effect` | `src/server/core/http.ts`, `bootstrap.ts`, `types.ts` | Retain as baseline; migrate platform-dependent contracts explicitly in M05b. Preserve stream-to-stream `Effect` meaning. |
| App context, routes, middleware, response helpers and validators | `src/server/core/` | Preserve behavior through a compatibility matrix, not indefinite duplication of routers. |
| Authentication wrapper | `src/server/core/middleware.ts`, `app.ts` | Preserve verification/access behavior; do not build a new auth product or mistake Wrangler login for user auth. |
| Shared route contracts and typed client | `src/shared/routes.ts`, `src/client/api.ts` | Retain inference and a single endpoint contract; improve decoding and transport outcomes. |
| MVU reducer and accumulated client state | `src/client/todo.state.ts` | Preserve reducer behavior; replace module-global lifetime with instance ownership. |
| Custom JSX and TodoItem | `src/client/h.ts`, `components/todo-item.tsx` | Keep the renderer; add owned bindings and keyed updates. |
| Todo store and SSE primitives | `src/server/todos/`, `src/client/sse.ts` | Preserve domain behavior; separate authority, activation and live-response lifetimes. |
| Vitest, DOM/HTTP tests and CI | `src/**/*.test.ts`, `.github/workflows/ci.yml` | Extend with compatible Workers-runtime tests; preserve relevant regression evidence. |

Package version `1.0.0` is not a milestone-completion claim. Preserve the original v0.2/v0.3/v0.4 release history and authorship. No dependency or package-version changes are part of this revision.

Node retirement is an explicit later decision: retain the baseline until corresponding Worker acceptance passes; map each characterized failure to a fix or a tested replacement before removing code/tests. While the Node adapter remains supported, its readiness, shutdown and port-release requirements still apply. Do not claim permanent dual-runtime support by default.

## 3. Milestone overview

| ID | Outcome | Depends on | Status |
|---|---|---|---|
| M00 | Verified import, baseline and reconciled status | — | Accepted/closed; PR #2 merged at `c9197b6` |
| M01 | Explicit application/component/source lifetimes | M00 | Accepted/merged; PR #5 at `188f21f` |
| M02 | Instance-owned state and coherent derived streams | M01 | Accepted/merged; [PR #7 at `7374557`](m02/acceptance.md) |
| M03 | Effect policies and correct HTTP outcomes | M02 | Accepted/merged; [PR #8 at `c64fda1`](m03/acceptance.md) |
| M04 | Owned, targeted reactive DOM rendering | M02, M03 | Accepted/merged; [PR #9 at `2b316a4`](m04/acceptance.md) |
| M05 | Cloudflare/Hono request, authority and SSE correctness | M05a–M05d | Accepted; [all four substeps merged](m05d/acceptance.md) |
| M05a | Cloudflare/Hono development and build foundation | M01 | Accepted/merged; PR #6 at `eeb8d29` |
| M05b | HTTP compatibility and request ownership | M05a | Accepted/merged; [PR #10 at `1cfbaec`](m05b/acceptance.md) |
| M05c | Durable shared Todo authority | M05b | Accepted/merged; [PR #11 at `d5500da`](m05c/acceptance.md) |
| M05d | Owned SSE and bounded authority-to-client delivery | M05b, M05c | Accepted/merged; [PR #12 at `540faec`](m05d/acceptance.md) |
| M06 | Typed live synchronization and recovery | M03, M05 | Accepted/merged; [PR #13 at `36d644f`](m06/acceptance.md) |
| M07 | Complete reference Todo app and forms | M04, M06 | Implemented; [acceptance review/merge pending](m07/acceptance.md) |
| M08 | Temporal traces and adversarial integration evidence | M07 | Pending |
| M09 | Documented API/builds, release readiness and completion review | M08 | Pending |

**Recommended serial order:** revision review → M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07 → M08 → M09.

M05 substeps retain one parent milestone; they do not renumber M06–M09. M05b–M05d do not depend on the UI implementation after their listed prerequisites, but the serial order keeps changes manageable. M03's transport cases must also run against Hono after M05b; prior Node results alone are insufficient for target acceptance. Never integrate the application's live SSE loop before all M05 substeps pass.

Tests accompany every milestone. M05a starts Workers-runtime testing; M08 is not where testing begins. Each completed milestone provides visible evidence as a static acceptance document or a runnable checkpoint, with exact commands/commit and limitations. Do not fabricate runnable evidence for a documentation-only change.

## M00 — Verify the import and establish the baseline

**Status:** accepted and closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e`; not reopened by r2.

**Purpose and retained evidence:** verify original history/application, reproducible install/typecheck/tests, dependency review, characterization and the original build/start probes. See [M00 evidence](baseline-rxjs-flow-m00.md) and the [unmodified r1 tasks and acceptance](archive/roadmap-rxjs-flow-migration-r1-2026-09-15.md).

**r2 treatment:** preserve all executed evidence and the separate intentionally failing characterization branch. Supersede only future Node-only hosting assumptions. Characterized failures retain milestone owners: M01 startup/disposal, M03 HTTP outcomes, M05b request isolation, M05d SSE cleanup. The corresponding acceptance reports record fixes or tested replacements. A subsequent platform replacement must account for those requirements rather than deleting failing cases without explanation.

## M01 — Make lifetime and source ownership explicit

**Implementation checkpoint, 2026-09-17:** browser ownership is implemented and
locally verified; [acceptance evidence](m01/acceptance.md) records the exact starting
and implementation commits, 219-test result and remaining boundaries. Review/merge
completed in PR #5 at `188f21ff307ff7d2146d9f90b24e5ee5c7dfd99d`. The r2 order
is unchanged: M01, then M05a, then M02–M04.

**Purpose:** every subscription and external resource has an owner before further abstraction is added.

**Touch:** new `src/client/runtime/scope.ts`, `src/client/runtime/sources.ts` and tests; extract browser startup from `main.tsx`; adapt `h.ts` only where ownership requires it.

**Tasks**
1. Define a function-based application scope with idempotent disposal and child component scopes. RxJS `Subscription` may implement ownership internally; do not create a parallel subscription system.
2. Make application construction inert. An explicit mount/start operation attaches sources and sinks. Importing feature modules must not subscribe, touch the DOM, open a connection, or issue a request.
3. Adapt DOM events to typed source streams. Capture the required event data synchronously, including `preventDefault` at the event boundary, before any asynchronous policy.
4. Define ownership contracts for event listeners, HTTP operations, EventSource connections, scheduled work, bindings, and child rows. Every resource declares whether it is per subscription, per component, or per app.
5. Register hot sources deliberately. A DOM event producer exists independently; adding a listener does not make the browser event producer cold.
6. Attach HMR disposal at the application boundary. A second mount must not inherit the previous mount's listeners or pending operations.
7. Keep the ownership primitive free of Node/Hono imports and assumptions about one permanent server process. Do not implement server infrastructure in this client milestone.

**Acceptance tests:** create without start performs no external work; one start attaches one owned set of sources; dispose twice is safe; mount/unmount/remount leaves exactly one active listener set; removing one child does not stop its siblings; no event or result updates a disposed app.

**Not included:** a general component framework or automatic dependency tracking. **Visible evidence:** a lifecycle acceptance record or mount/dispose demonstration.

## M02 — Build the state machine and derived-stream contract

**Implementation checkpoint, 2026-09-17:** [acceptance evidence](m02/acceptance.md)
records the state/transition implementation and historical local verification.
Accepted and merged in PR #7 at `7374557b6d264a9bfa572526a4f71233fc3aa24e`.

**Purpose:** make memory, ordering, and sharing explicit while preserving the existing pure reducer approach.

**Touch:** `todo.state.ts`, new `todo.model.ts` / `todo.selectors.ts`, `src/client/runtime/program.ts`, state/runtime tests. Names are proposed file locations, not existing APIs.

**Tasks**
1. Replace the module-global `action$`, `state$`, and `dispatch` instance with a factory. Separate app instances and tests receive independent state and lifecycle.
2. Extend the existing `Action` union with UI intents, operation-started/succeeded/failed/cancelled facts where relevant, and server snapshot/connection facts. Keep intent, event, and transport message meanings distinct; no mandatory `Command` vocabulary.
3. Model initial loading, empty data, pending mutations, recoverable errors, form draft state, and connection status explicitly. Prefer readonly domain data and named update functions.
4. Accumulate state with `scan` and emit the initial state deliberately. Keep one shared accumulation alive for the mounted scope. Specify replay and reset behavior rather than using the positional `shareReplay(1)` default as a lifecycle design.
5. Connect the state owner and feedback consumers before enabling event sources or startup effects. Serialize reentrant feedback with a documented ingress policy; synchronous test effects must behave correctly too.
6. Where effects need state, give them a coherent transition record containing the accepted message and the appropriate state snapshot. Do not depend on incidental subscriber order between `actions$` and `state$`.
7. Derive a coherent `viewModel$` from a single state snapshot. Use named selectors and explicit equality. Do not split coupled fields into a diamond and then claim `combineLatest` makes updates transactional.
8. Distinguish browser-local UI state from the server's collection authority. The browser model receives validated collection snapshots; it does not import Cloudflare bindings or require a shared global browser state instance.

**Acceptance tests:** reducer determinism and immutability; isolated instances; initial value before the first external action; late subscribers see current state; extra consumers do not repeat reductions; synchronous startup feedback is not lost; coherent derived fields; state survives temporary loss of a view while the app owns it; a new scope resets to its own initial state.

**Important:** `shareReplay({ bufferSize: 1, refCount: true })` alone does not specify app lifetime. The mounted runtime must own the state connection; disposal must release that ownership and references. **Visible evidence:** state-transition and derived-value examples from the tested instance model.

## M03 — Separate effect streams and repair HTTP outcomes

**Implementation checkpoint, 2026-09-17:** [acceptance evidence](m03/acceptance.md)
records extracted owned effects, bounded mutation admission, recoverable correlated
outcomes, validated HTTP responses, abort through body consumption and the required
generic SSE decoder. Accepted and merged in PR #8 at
`c64fda113b599ff9b0b21ae3e20aeff0c473a358`. Targeted DOM ownership is recorded in
the M04 checkpoint below, and the application live
protocol/reconnect integration remains M06. No later milestone starts automatically.

**Purpose:** events describe intent, pure functions determine meaning, and effect streams implement explicit execution policies.

**Touch:** new `todo.effects.ts`, `todo.intents.ts`, `src/client/runtime/effects.ts` only if reuse is demonstrated; existing `api.ts`, `todo.service.ts`, relevant shared contracts and tests.

**Tasks**
1. Move network subscriptions and success/error dispatching out of rendering and TodoItem callbacks. Components emit typed intent values. Effect functions return result-event streams; the runtime owns their subscriptions and feeds results to state.
2. Use existing route contracts, but check status before decoding. Failed DELETE must not emit success. Handle expected empty bodies by response contract/status, not by a blanket method shortcut. Preserve structured server errors.
3. Decode external data from `unknown` with shared Zod schemas or explicit decoders. Generic return types and `as T` do not validate HTTP/SSE payloads.
4. Make HTTP work subscription-driven and connect unsubscription to transport abort, including body consumption. Inject the client/transport so tests do not depend on global fetch behavior.
5. Catch recoverable errors inside each operation. A failed save must not terminate future UI intent processing. Unexpected runtime faults are reported and cleaned up, not silently swallowed.
6. Correlate pending operations and their results. Request failure is not the same as cancellation; cancellation is not proof that a server write was rolled back.
7. Ensure extra subscribers to state, view models, or traces cannot execute an effect twice.
8. Keep operation capabilities independent of Hono context. Run the same transport outcome cases against the Hono boundary after M05b; this milestone does not pre-implement that boundary.

**Reference policies**

| Situation | Policy | Required qualification |
|---|---|---|
| Refresh/search reads | `switchMap`: latest request wins | Late results cannot overwrite newer intent. |
| Repeated create submit | `exhaustMap`: ignore while accepted submission is pending | Capture accepted draft; visibly disable/indicate pending. |
| Todo mutations | `concatMap`: serialize accepted writes in the initial implementation | Bound the pending queue; do not auto-retry non-idempotent writes. |
| Independent test/demo work | `mergeMap` with explicit concurrency limit | A concurrency limit alone does not bound queued inputs. |

Start with one simple ordered mutation queue. Per-entity queues are a later optimization only with bounded key lifetime and conflict tests. A newer query is not a reason to cancel an already accepted mutation. Local client ordering is not cross-client transactional ordering; M05c owns the authority boundary.

**Acceptance tests:** all relevant non-2xx statuses become failure events; valid 204 succeeds; malformed bodies fail safely; cancel-before-headers and cancel-during-body release resources; policy marble tests assert inner subscription intervals; a failed request does not disable the next intent; no duplicate request from additional consumers. **Visible evidence:** a recoverable operation failure and an obsolete-read cancellation.

## M04 — Render from streams with targeted DOM ownership

**Implementation checkpoint, 2026-09-17:** accepted and merged in PR #9 at
`2b316a477600c91b3105c9e390949c29e90046d3`. [Acceptance evidence](m04/acceptance.md) and the
[minimal binding sample](m04/minimal-sample.md) document a stable shell, owned
scalar bindings and keyed rows with child scopes. `todo.view.tsx` owns rendering;
the app root connects its streams. Synchronous targeted commits preserve node
identity, focus and selection, and removing rows/views releases their ownership.
M05b is now implemented as the next authorized checkpoint; see its acceptance record below.

**Purpose:** make rendering an explicit sink without turning every state emission into a full reconstruction.

**Touch:** `h.ts`, `components/todo-item.tsx`, new `src/client/dom/bindings.ts`, `src/client/dom/keyed-list.ts`, `todo.view.tsx`, and DOM tests.

**Tasks**
1. Retain the small JSX element factory. Add narrow, scope-owned binding functions for text, properties, attributes, classes, and conditional content rather than introducing a second framework.
2. Build a stable shell once. Bind coherent derived values to the relevant DOM locations. Replace `listEl.innerHTML = ''` on every state emission with keyed Todo rows.
3. Give each row a child scope. Updating/reordering an existing key retains node identity; deleting it disposes listeners and bindings exactly once.
4. Event handlers capture input and emit intents only. They must not subscribe to HTTP work or mutate shared state directly.
5. Start with synchronous rendering for straightforward semantics and tests. Any frame coalescing must be a named, injectable policy with cancellation and order tests; do not globally delay all application messages.
6. Preserve focus, selection, unsent input, and native form behavior. Rendering the same view model again must not trigger writes.

**Acceptance tests:** an unrelated error/pending-state change does not rebuild the todo list; an unchanged row retains identity; update touches the intended row; delete tears down its scope; focus and draft survive server updates; removing the view releases all bindings; render never invokes an effect.

**Visible checkpoint:** the existing CRUD app now runs through sources → owned state → derived values → DOM, with effects outside the renderer. Selecting Hono does not replace this renderer with Hono JSX.

## M05 — Establish the Cloudflare/Hono server boundary

**Purpose:** preserve application behavior while separating HTTP request, streaming response and shared-state authority lifetimes. Complete M05a–M05d as independently reviewed substeps; no whole-server rewrite in one change.

**Touch:** existing server contracts/effects/tests; proposed platform adapter modules under `src/server/`; Vite/Wrangler and test configuration in M05a. Exact new file names are implementation decisions, not existing APIs.

**Parent acceptance:** all four substeps pass, original characterization requirements have an explicit disposition, the supported-runtime status is documented, and the complete authority-to-live-response path is ready for M06. A working health endpoint is not M05 completion.

### M05a — Cloudflare/Hono development and build foundation

**Implementation checkpoint, 2026-09-17:** [acceptance evidence](m05a/acceptance.md)
records the exact baseline/implementation, 252 tests across Node/DOM/workerd and
real local dev/preview checks. [Run the checkpoint](m05a/local-development.md).
Accepted and merged in PR #6 at `eeb8d2989884372fa42f4e321295aa7f3e8faa75`.
This paragraph records the historical M05a checkpoint; subsequent substep status is recorded below.

**Depends on:** M01. **Timing:** perform immediately after M01 in the recommended sequence.

**Tasks**
1. Add project-local, compatibility-checked Hono, Wrangler and Cloudflare Vite integration without regenerating the existing repository. Record resolved versions and lockfile changes. Preserve the Node baseline commands until an explicit transition replaces them; do not restore the removed `@hono/cli` by assumption.
2. Establish an explicit Worker entry and `wrangler.jsonc`, with selected compatibility date/flags and environment policy. Keep Hono routing registration inert. Do not use a dependency upgrade as permission for unrelated changes.
3. Preserve custom JSX and split browser, Worker and Node-tooling TypeScript environments. Generate Worker types from configuration; test that browser output excludes server-only code and secrets.
4. Establish development, build and preview scripts using Vite plus the Cloudflare plugin. Define who owns `/api` prefix handling and static assets; prove a built asset and one typed RxJS operation invoked through Hono. Do not claim Todo backend migration from this probe.
5. Add the compatible official Workers-runtime test integration alongside current tests. Record which tests execute in Node, DOM and `workerd`; do not assume Node tests prove Worker compatibility.
6. Document project-local Wrangler OAuth login and account verification. Separate developer login, CI deployment credentials and application-user authentication. Local runtime tests/builds must not require production credentials or silently use remote bindings.
7. Add secret-file ignore rules and local configuration examples when implementing this substep. No real credentials, account mutation, DNS configuration or automatic deployment belongs in the foundation change.

**Acceptance:** clean install/typechecks/existing tests and a Worker-runtime test pass at the recorded toolchain; current JSX assets build; a Hono endpoint executes a typed RxJS operation with owned cleanup; the built output can be previewed in the Workers runtime; server-only imports do not enter client output. Login/account verification is documented and recorded only when actually performed; remote access is not required to prove the local foundation.

**Visible checkpoint:** locally runnable browser asset plus Worker endpoint and a build/runtime evidence document. Authentication, dependency installation and deployment are not claimed by this plan revision.

### M05b — HTTP compatibility and request ownership

**Accepted/merged, 2026-09-18:** [PR #10](https://github.com/hansschenker/rxjs-flow/pull/10)
at `1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`. The [acceptance record](m05b/acceptance.md)
records 656 passing tests and final-head CI; the owner also confirmed the local
page layout and input preservation during Refresh.

**Depends on:** M05a.

**Tasks**
1. Establish a compatibility matrix for existing routes, auth, middleware, status codes, headers, request context, body limits, validators and structured errors. Keep one authoritative endpoint contract and explicitly test its mapping to Hono; avoid independent drifting route trees.
2. Move Node-only raw request/response objects out of platform-independent contracts or into an explicit adapter-specific escape hatch. Keep Hono `Context`, environment bindings and Durable Object stubs outside pure domain functions. Inject narrow values/capabilities.
3. Preserve or deliberately migrate the existing stream-to-stream server `Effect` contract. Hono middleware is not an RxJS `OperatorFunction`; make the adapter visible instead of silently conflating the two.
4. Give each request operation its own execution owner and cancellation bridge. Guard matching, decoding, synchronous effect construction and response conversion, not only downstream operators. One bad request must not terminate unrelated requests.
5. Specify finite-response cardinality, empty-handler behavior, settlement deadlines and cleanup. A finite operation must settle as one response or a defined failure; test empty, multiple, never-settling and synchronously failing cases rather than letting them hang or blindly hiding extra results. An SSE response descriptor is separate from its body lifetime.
6. Rerun M03 transport cases against Hono, including non-2xx, 204, malformed bodies and cancellation before headers/during consumption. Verify protected routes cannot bypass auth through alternative mounts or asset fallback.
7. Retain Node-specific readiness/listen-error/repeated-start/stop/port-release tests while that adapter remains supported. Before its retirement, document equivalent behavioral coverage and resolve the characterization ledger rather than merely deleting the tests.

**Acceptance:** a valid request succeeds after malformed input or a synchronous handler throw; simultaneous request contexts are isolated; canceling A does not stop B; body bounds/validation/auth and finite-response outcomes are verified; no duplicate execution from extra consumers; Worker and retained Node compatibility claims have separate evidence.

**Visible evidence:** route compatibility and request-lifecycle acceptance records.

### M05c — Durable shared Todo authority

**Accepted/merged, 2026-09-18:** [PR #11](https://github.com/hansschenker/rxjs-flow/pull/11)
at `d5500da407611e7856e9e67481a08e15e530aece`. The [acceptance record](m05c/acceptance.md)
records 737 passing tests; the [two-caller/restart checkpoint](m05c/local-development.md)
uses actual local HTTP and persistent storage. The owner confirmed the page and
Refresh request. M05d/M06 remain independently reviewed milestones.

**Depends on:** M05b. **Scope:** a deliberate, minimal persistence addition to r1.

**Tasks**
1. Define a logical collection identity and authorized mapping to one Durable Object. A collection key alone is not access control. Begin with the minimum reference-app collection policy; do not introduce a tenant-management framework.
2. Provide a narrow authority/store capability to request operations. Creating a request scope must not create a fresh empty collection, and Worker-global mutable state must not become deployed authority. Keep independent in-memory factories for isolated tests and the Node baseline.
3. Persist collection state, schema version, state generation and revision using attached storage. Select and test the simplest supported layout and local migration declaration. Remote resource creation/migrations require separate release authorization.
4. Define a serialized read/validate/transition/commit boundary. Commit state and ordering metadata consistently before publishing a committed snapshot or acknowledging commit success. Test interleavings around asynchronous work; local `scan`, `concatMap` or single-threaded JavaScript is not the durability guarantee.
5. Reuse named pure domain transitions and inject IDs/time at boundaries. Permit only the thin platform-required entry class; keep domain/state/effect composition function-based.
6. Reconstruct the committed history after authority restart. A storage failure must not expose speculative state as committed. Distinguish a failed commit from a committed operation whose response was lost; do not automatically retry non-idempotent operations.
7. Define bounded admission, pending operations and active subscriber budgets. An authority outlives an individual connection logically, but its activation need not remain resident. State is persisted; subscriptions are reconstructed, not persisted.
8. Reserve live registration/current-snapshot behavior for a race-free handoff completed and tested with M05d. A minimal storage adapter is sufficient; no ORM, general event log, backup product, job system or alternative database is required.

**Acceptance:** two independent in-memory test stores remain isolated; two independently constructed request handlers addressing the same authorized collection observe the same committed state; different collection identities stay isolated; concurrent writes do not lose updates; revision/state persist consistently; storage failure and authority reconstruction are tested; no uncommitted snapshot is advertised as committed. Do not claim a simulated test forced Cloudflare's global deployment scheduler.

**Visible evidence:** a two-caller authority example and restart/failure acceptance record, explicitly distinguishing local-runtime evidence from any future deployed evidence.

### M05d — SSE ownership and bounded live delivery

**Accepted/merged, verified 2026-09-20:** [PR #12](https://github.com/hansschenker/rxjs-flow/pull/12)
at `540faec7086bb58223c5f475db91710ac0e7389b`. The [acceptance record](m05d/acceptance.md)
records 834 passing tests and the [two-consumer live checkpoint](m05d/local-development.md).
All four parent M05 substeps are accepted. The public legacy `todos` event retains
its bare-array payload; M06 adds a separate versioned route for application state.

**Depends on:** M05b, M05c.

**Tasks**
1. Preserve HTTP/SSE transport. Prove the authority-to-Worker response path as well as browser delivery; a local Worker Subject must not become an accidental second authority.
2. Make each live subscription a child of its response lifetime. In a Hono streaming helper, keep the callback alive for that stream; returning from the callback must not close a still-needed subscription. Register cleanup before synchronous emissions and handle already-aborted input and setup failures.
3. Tie response/body cancellation and disconnect to owned subscription/resource teardown using the selected runtime's supported APIs/settings. Do not equate Node `IncomingMessage.close` with SSE response termination. Returning `Response` does not end a streaming body's lifetime.
4. Serialize transport writes and define a bounded pending-data policy. Await writes in the transport owner rather than spawning an unbounded sequence of async observer callbacks. Full snapshots may coalesce to the latest under a stated policy; domain events may not be silently dropped.
5. Define complete/error/cancel behavior before and after headers. Post-header stream failure cannot be replaced with a new JSON response. Cleanup is idempotent on source failure, completion, disconnect, authority interruption and local-runtime shutdown.
6. Make initial current-snapshot acquisition and live registration race-free against committed mutations. Prove that a write during connection setup cannot disappear between an initial read and later subscription.
7. Keep state authority independent of client count. Closing client A must not stop client B or remove committed collection state. Reconnect creates a new owned stream; persisted storage does not preserve running subscriptions.
8. Record active-stream resource and operational limits. An Observable or `waitUntil()` is not a perpetual keep-alive mechanism; do not assume SSE has WebSocket hibernation behavior. No WebSocket rewrite is part of this milestone.

**Acceptance:** synchronous complete/error and already-aborted requests clean up; SSE stays active after request-body completion; real response cancellation releases owned work; another client continues; writes preserve defined order with bounded queues; setup cannot miss an intervening commit; source failures and authority interruptions are visible; listeners/subscriptions/buffers return to baseline. Retained Node shutdown also disposes streams and releases its port, or its retirement is explicitly documented with replacement evidence.

**Visible checkpoint:** two locally connected live consumers, one disconnect/reconnect, and a resource-lifetime record. M05 closes only after M05a–M05d pass.

## M06 — Close the server-to-client live-state loop

**Implementation checkpoint, 2026-09-20:** [acceptance record](m06/acceptance.md)
and [two-tab Todo synchronization/reconnect checkpoint](m06/local-development.md).
The verified start is M05d PR #12 merge `540faec7086bb58223c5f475db91710ac0e7389b`;
both pristine baseline suites passed before editing (834 tests). M06 was explicitly
authorized. The new `/todos/live` route emits schema-versioned `todo-snapshot`
events; `/todos/stream` keeps its legacy bare-array event. One app-owned live
connection feeds authoritative snapshots into state; HTTP replies only settle
pending operations. Bounded RxJS-owned retry, separate connection identity and
manual recovery make interruptions explicit. M06 is accepted and merged in
PR #13 at `36d644f529d5660506d6f2aa90e90af562d01440`. The owner subsequently
authorized M07; its separate checkpoint follows.

**Purpose:** integrate the verified SSE path with the actual application using logical authority identity and a defined consistency policy.

**Touch:** `src/shared/routes.ts`, shared live-state schemas/contracts, `src/client/sse.ts`, `todo.effects.ts`, `todo.state.ts`, authority/stream adapter and integration tests.

**Tasks**
1. Distinguish finite JSON routes from live stream routes in contracts/client construction. A live route must not become an ordinary `res.json()` call. Keep finite-route inference intact.
2. Publish an explicit versioned live Todo schema with runtime decoding. Keep the old bare-array endpoint or document a coordinated migration; never silently reinterpret it.
3. Use committed server snapshots as the authoritative Todo collection. Mutation HTTP results settle pending-operation status; snapshots replace the collection. Do not append once from HTTP and again from SSE.
4. Attach one shared live connection per mounted app. Initial connection and reconnection supply a complete current snapshot. Show loading before the first snapshot and stale/reconnecting state during interruption.
5. Use logical ordering identity `collectionId + stateGeneration + revision`, or an equivalently explicit tested schema. Generation identifies collection history, not a Worker instance. It survives ordinary authority restart; reset/replacement changes history. Compare revisions only within the same collection/generation and reject stale/duplicate snapshots.
6. Track connection/session identity separately and discard callbacks from superseded connections. Accept a changed generation only through the defined current-connection/resynchronization policy; an arbitrary delayed different-generation payload cannot reset the model.
7. Assign one reconnect owner: browser EventSource or the RxJS adapter, never independent competing mechanisms. Inject timing where the chosen mechanism permits it; document browser-controlled behavior otherwise. Define limits, terminal failures and manual recovery.
8. Cancel connections/retries on disposal. Decode from `unknown`; malformed payloads must not corrupt state. Define protocol-failure recovery and test connection setup/disposal races.
9. Document uncertainty: reconnection repairs current collection state, not every historical event. A disconnected mutation may already have committed; local cancellation is not rollback, and automatic replay is not safe without an explicit idempotency protocol. No exactly-once delivery claim is made.

**Acceptance:** two mounted clients on the same collection converge after writes through independent request handlers; each test's accepted mutation is applied once without dual HTTP/SSE client updates; duplicates/older revisions do not regress the collection; authority restart retains persisted history; explicit new history and superseded connections are handled correctly; extra UI consumers open no extra connections; unmount during retry opens nothing later; malformed payloads are rejected. Retained Node in-memory mode has a separately labelled reset-generation policy.

**Visible checkpoint:** an end-to-end two-browser synchronization and reconnect demonstration.

## M07 — Complete the reference application

**Implementation checkpoint, 2026-09-20:** explicitly authorized after M06
[PR #13](https://github.com/hansschenker/rxjs-flow/pull/13) merged at
`36d644f529d5660506d6f2aa90e90af562d01440`. The pristine starting tree passed
931 tests (766 Node/DOM and 165 workerd) before implementation edits.
Implementation on `m07/reference-app` passed 968 tests (803 Node/DOM and 165
workerd) and the same complete native-browser scenario in development and built
local Worker modes. The [acceptance record](m07/acceptance.md) and
[runnable guide](m07/local-development.md) record all six tasks, form/filter
behavior, failure/reconstruction and actual unmount/remount evidence. Acceptance
review/merge is pending; M08 does not start automatically.

**Purpose:** prove the whole model through user-visible behavior rather than disconnected utilities.

**Touch:** `src/client/main.tsx`, Todo feature modules, `index.html`, form/view tests, browser end-to-end tests and scripts.

**Tasks**
1. Reduce `main.tsx` to construction, mount and disposal of the Todo program. Preserve the existing application rather than scaffolding a second demo.
2. Complete load/create/toggle/delete, filtering, loading/empty/error displays, live connection status and recoverable operation feedback.
3. Represent form draft, validation and pending state through the same state/effect model. Capture the submitted draft; only clear the relevant accepted draft, not newer text typed while a request is pending.
4. Keep client validation pure and server validation authoritative. Use accessible native controls and explicit disabled/error states.
5. Demonstrate two browsers against the Cloudflare-oriented local runtime: server update, network interruption, failed mutation, authority reconstruction, and mount/unmount/remount. Distinguish durable target behavior from the Node in-memory baseline's reset-on-restart behavior.
6. Run through the built asset/API arrangement as well as development mode. Do not rely solely on Vite's old Node development proxy. No nested browser router, auth product, ORM, custom CLI or renderer replacement is required.

**Acceptance:** a real browser test executes DOM intent → effect → Hono HTTP → authority commit → live snapshot → client reducer → targeted DOM update; another client sees the same state; failures remain recoverable; teardown releases owned resources; form/focus tests pass during updates. Local evidence is not a deployed-service claim.

**Visible checkpoint:** the complete runnable reference application with documented limits and recovery behavior.

## M08 — Make time, causality, and cleanup inspectable

**Purpose:** verify overlap, cancellation, failures, authority recovery and repeated mounting across the selected boundaries.

**Touch:** small opt-in runtime/transport trace hooks, `src/testing/` helpers only where useful, integration/temporal tests and CI.

**Tasks**
1. Trace source receipt, accepted intent, state transition, effect subscribe/next/error/complete/cancel, authority commit/publication, render commit, connection changes and scope disposal.
2. Give records runtime-local sequence, scope/source and operation correlation identifiers plus clock/scheduler timestamps. Record collection/generation/revision and connection identity where relevant. Equal timestamps do not establish order; client, Worker and authority clocks do not create a global total order.
3. Keep tracing observational: it must not add a subscription that repeats effects. Redact credentials and sensitive payloads by default.
4. Retain pure reducer, RxJS virtual-time and DOM tests. Extend the Workers-runtime tests established in M05a, plus real transport and browser tests for properties virtual time cannot prove. Test resource ownership, not only `finalize` observations.
5. Exercise bursts, admission/queue bounds, delayed bodies, out-of-order results, malformed input, reconnect/dispose/setup races, synchronous sources, concurrent clients, storage failure before publication, authority reconstruction, and commit-success/response-loss uncertainty.
6. Distinguish independently constructed handlers in local tests from actual verified remote instances. Do not claim a test forces global routing. Record lightweight performance/resource baselines including active SSE work; make no universal speed or glitch-freedom claims.

**Acceptance:** traces explain a complete operation, a cancellation and an authority recovery; enabling traces leaves request counts unchanged; subscriptions/listeners/connections/queues return to expected bounds; current relevant tests pass at the recorded commit; local versus remote evidence and remaining limits are explicit.

**Visible evidence:** readable temporal traces and an adversarial acceptance report. Rich devtools remain deferred.

## M09 — Completion review and documented delivery

**Purpose:** document the proven architecture and Cloudflare delivery workflow without overstating implementation or deployment status.

**Touch:** README, this roadmap, architecture/runtime decision, CHANGELOG, public exports as needed, scripts, build/delivery documentation and CI.

**Tasks**
1. Document the application graph, source temperature, construction/activation/disposal, sharing, effect policies, validation, request/response/authority ownership and live synchronization.
2. Document only the small function-based public surface proven by the app. No speculative plugin system, multi-package workspace or new release version is implied.
3. Complete the Vite/Cloudflare workflow begun in M05a: clean install, environment-specific typechecks, tests, build and preview. Smoke-test a built client asset plus real CRUD/SSE through the public API path. Specify same-origin asset/API precedence and prefix handling; unknown API paths and auth failures must not return the HTML shell.
4. Document project-local Wrangler authentication, generated types, environments, migration declarations, secret handling and a gated deployment procedure. Keep validation CI separate from deployment authorization; documentation/PR creation must not enable an automatic production deployment.
5. Review Node adapter disposition. State whether it is retained as a supported mode or retired with a tested migration note. Preserve its historical evidence; do not require indefinite duplicate infrastructure.
6. Reconcile package/changelog terminology, actual scripts and milestone status. Preserve original release entries, source attribution and repository provenance. Verify canonical links and prepare a matching Project reference copy without claiming it has been uploaded automatically.
7. Review all acceptance evidence at one final commit. Distinguish local runtime verification, deployable-artifact readiness and an actual separately authorized deployment. Record remaining security, operational, persistence and recovery limitations; minimal durable storage is not comprehensive production readiness.
8. Treat `netxpert.ch` as owner-provided deployment context only. No DNS, Worker route, domain binding, secret/account changes, remote resource creation, package publication, release tagging or production deployment is authorized by milestone completion alone. A public demo requires a separately reviewed access policy and release authorization.

**Acceptance:** a fresh checkout builds and runs the complete local Cloudflare-oriented app; typecheck/test/build/preview-smoke evidence is recorded; durable authority and resnapshot semantics are demonstrated; runtime support and deployment status are explicit. A deployment-ready artifact is not evidence that `netxpert.ch` serves it.

**Visible delivery:** a runnable reference app/build and concise operational/acceptance documentation.

## 4. Old roadmap → revised treatment

| Earlier assumption or ambition | r2 treatment |
|---|---|
| Preserve Node HTTP implementation as the permanent server | Preserve behavior/contracts and baseline; adopt Hono/Workers through M05a–M05d and document Node disposition. |
| One app-owned in-memory shared store | Retain for isolated tests/baseline; add minimal Durable Object authority/persistence in M05c. |
| Server-instance epoch | Logical collection history/generation and revision, plus separate connection identity, in M06. |
| Node-only build/start and reverse-proxy arrangement at M09 | Early Vite/Workers build proof in M05a; asset/API contract and documented readiness completed in M09. |
| Component/state/effect/rendering improvements | Retain M01–M04; keep them independent of Hono/Cloudflare types. |
| Authentication expansion | Preserve behavior and authorization correctness; no new auth product. Wrangler login is developer authentication only. |
| Real-time primitives | Complete HTTP/SSE first; WebSocket rewrite remains deferred. |
| Persistence/transactions/ORM | Minimum authority commit/recovery is now required in M05c; ORM and general persistence ecosystem remain deferred. |
| Client router, nested routes, guards and lazy routing | Follow-on work after the core proof; Hono HTTP routing does not implement these browser features. |
| SSR/hydration/islands and server-function extraction | Deferred; the target remains client-rendered with explicit transport boundaries. |
| Jobs/queues/event-bus products | Deferred; bounded local policies are not durable scheduling services. |
| Observability/performance | Lightweight trace/resource evidence in M08, not a devtools platform. |
| CLI/code generation/plugins/ecosystem packages | Custom products deferred; use Wrangler and its type generation as existing infrastructure. |
| Multi-provider portability | Core/platform separation retained; no universal deployment framework required for this Cloudflare-first target. |

## 5. Working agreement

All new implementation branches, commits and PRs belong in `hansschenker/rxjs-flow`. Verify the current base/destination before writes. Leave `rxjs-stack` and `rxjs-fullstack` unchanged. Use a dedicated branch and PR; no automatic merge, publication, release or deployment is authorized by this document.

Use one reviewable change per milestone or independently testable substep. Begin with a regression for behavior being corrected, implement the smallest change, run relevant tests, and record the evidence commit, versions, commands, counts and limitations. Do not treat a passing happy path or new module as milestone acceptance. Do not mark Workers/persistence work complete using Node-only evidence.

Keep documentation, dependency/toolchain changes, platform adapters, storage authority, renderer changes and transport protocol changes independently reviewable. Preserve the application and provenance; do not merge unrelated dependency PRs or the intentionally failing characterization branch as part of this revision.

After a roadmap amendment is merged/accepted, refresh the ChatGPT Project reference copy with this same filename and revision. Until that refresh is confirmed, report it as pending rather than claiming automatic Project synchronization. GitHub branch content is not proof that main or the Project copy has changed.

**Current implementation:** M07, explicitly authorized from the verified M06
merge. M00–M06 and all four M05 substeps remain accepted/merged. Complete and
review M07 before starting M08 with its own authorization; M08–M09 do not start
automatically.
