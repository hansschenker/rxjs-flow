# Dataflow architecture contract

Design revision: 2026-09-17. Target revision: **rxjs-flow migration r2 — Cloudflare/Hono**.

Applies to the ChatGPT Project **`rxjs-flow`** and development repository **`hansschenker/rxjs-flow`**. Read with the [canonical roadmap](roadmap-gpt-6-astra-2026-09-15.md) and [Cloudflare/Hono runtime decision](runtime-cloudflare-hono.md). The historical source `rxjs-stack` and separate `rxjs-fullstack` repositories are not development targets.

**Status:** target behavior, with implementation evidence recorded per milestone. M00 is accepted/closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e`; M01 is accepted/merged in PR #5. M05a is accepted/merged in PR #6. M02 is [accepted/merged in PR #7](m02/acceptance.md) at `7374557b6d264a9bfa572526a4f71233fc3aa24e`. M03 is [implemented and locally verified, with acceptance review/merge pending](m03/acceptance.md). M04 and M05b–M09 remain pending; M04 requires M03 acceptance and authorization. A local Worker probe exists; Todo migration, durable authority, live integration and deployment remain unimplemented. The [r1 contract](archive/dataflow-architecture-r1-2026-09-15.md) and M00 evidence are preserved.

r2 retains the reactive core, rendering and transport-correctness requirements while replacing the permanent Node-server assumption with an explicit Hono/Workers boundary and a minimal durable shared-state authority. Platform facts and primary references are separated from these project requirements in the runtime decision.

## 1. One model, explicit runtime boundaries

```text
Browser sources
DOM events / startup / transport events
                 |
                 v
          typed input messages
                 |
                 v
       serialized state transitions <--------------------+
                 |                                      |
          shared current state                          |
                 |                                      |
         +-------+----------------+                     |
         |                        |                     |
  coherent viewModel       accepted intents /           |
         |                 transition snapshots         |
         v                        |                     |
  owned DOM bindings        effect policies             |
         |                        |                     |
         v                        v                     |
        DOM               HTTP / other adapters         |
                                  |                     |
                            result messages ------------+

Server boundaries:
Request -> Hono matching/middleware -> validated input + capabilities
                                                |
                                  owned RxJS operation
                                                |
                                  logical Todo authority
                                                |
                            pure transition + persisted commit
                                                |
                                      committed snapshot
                                                |
                             owned, bounded SSE response
                                                |
Browser: bytes -> decoder -> current-connection snapshot message
```

Rendering is already an effect on the DOM. It is a separate sink from network/storage effects, not a prerequisite for them. Re-rendering never repeats a write. An effect result can change state and therefore the view without the view initiating the effect.

RxJS 7 supplies the Observable protocol inside each execution environment. Across browser, Worker and authority boundaries, use an explicit data protocol with validation, ordering, recovery and lifetime rules. Do not transport Observable objects, running subscriptions or closures. Cancellation does not automatically send a remote cancel command or reverse a committed mutation.

Hono owns HTTP integration; the existing JSX/binding layer owns browser rendering; Vite and Wrangler supply build/platform tooling. They do not replace the RxJS application model. The platform adapter may be Cloudflare-specific without making reducers and browser modules Cloudflare-specific.

## 2. Vocabulary and module responsibilities

| Term | Meaning | Responsibility |
|---|---|---|
| Event | Something happened: submit, response, snapshot, disconnect. | Capture at a source boundary. |
| Intent | Domain meaning of a requested action. | Named pure interpretation functions. |
| Message / existing `Action` | Typed value accepted by the app state machine. | Discriminated union; transport shape is not assumed identical. |
| Browser state | Current remembered UI facts and accepted collection snapshot. | One pure-reducer accumulation per mounted app. |
| Authoritative state | Committed collection state and ordering metadata. | Logical collection authority, not Worker-global memory. |
| Derived value | Projection from a state snapshot. | Named selector without external effects. |
| Effect description/policy | Which operation is relevant and how competing work is treated. | Explicit stream composition. |
| Effect execution | Actual HTTP, storage, timer or DOM interaction. | Owned adapter/subscription boundary. |
| Server `Effect` | Existing stream-to-stream request/response function type. | Preserve its meaning; migrate Node-specific parameters deliberately. |
| Scope | Owner of an app, component, request, response or authority activation. | Controls activation and disposal within the host lifecycle. |
| Capability | Narrow operation needed by application code. | Inject at the platform boundary; do not pass an entire Hono context to a reducer. |

Do not force a new `Command` vocabulary. Preserve `Action` compatibility where appropriate and distinguish intent from completed fact. Pure domain functions may return ordinary values; they do not all need to become Observables. Hono middleware is not automatically an RxJS `Middleware`/`OperatorFunction`.

The core and browser code must not import Node raw request types, Hono context, Worker bindings or Durable Object stubs. Restrict these to their adapter modules. Preserve one shared route contract and test its HTTP mapping; do not create independently maintained route trees.

The M03 checkpoint extracts pure Todo intent interpretation and one app-owned effect graph. Reads use latest-read cancellation; accepted create/update/delete operations share a FIFO with a default capacity of 32 active plus waiting writes. Create exhaustion lasts through queued and active work. Expected failures return correlated facts, and unexpected graph/render faults reach the host's cleanup/reporting boundary. HTTP work is cold, uses response contracts and shared Zod schemas, preserves structured failures and aborts body consumption on disposal. The generic SSE adapter now requires a decoder from `unknown`; it is not connected to the Todo app. Keyed DOM ownership remains M04, and the versioned live protocol, reconnect policy and app connection remain M06.

## 3. Construction, activation, and disposal

Creating a program describes its graph and dependencies. Starting/mounting it subscribes or connects that graph. Importing feature modules must not subscribe, touch the DOM, issue a request, open a connection or mutate application state. Inert route registration and platform entry exports are permitted: defining a route is not executing its operation.

M01 implements inert `createTodoApp` plus `start`/`dispose` and the host helper `mountTodoApp`. M02 adds the instance-owned program/model, FIFO ingress and coherent derived streams; its checkpoint records the precise implemented contract. RxJS `Subscription` may implement ownership internally. Do not create a parallel subscription system or application class hierarchy. A platform-required Durable Object entry class may delegate to the functional core; library implementation classes need not be rewritten.

The mounted browser runtime owns state accumulation, effects, bindings, source listeners, scheduled work and feedback. Internal adapter subscriptions are allowed only with named owners and teardown paths. “Exactly one subscribe call in the entire codebase” is not the constraint.

Startup is contractual: connect state ownership and downstream consumers before enabling startup work and external sources. Synchronous sources must work; network latency must not accidentally be the initialization barrier.

Browser shutdown first prevents new accepted inputs, then releases children and queued/scheduled work, and finally releases state ownership. Disposal is idempotent; a new app starts with its own UI state. That does not reset the remote authoritative collection.

For the server, distinguish:

| Lifetime | Owns | Must not imply |
|---|---|---|
| HTTP request operation | Input decoding, validation and finite-operation execution. | A new empty collection per request or cancellation of other requests. |
| Live response | One client's source subscription, writes and bounded pending data. | Ownership of the whole collection or another client's connection. |
| Authority activation | In-memory reconstruction, active operation/connection resources. | Permanent residency or persistence of subscriptions. |
| Logical collection | Persisted state/history and consistency contract. | Identity equal to a Worker process or connection. |
| Local runtime / retained Node app | Development/test server startup, shutdown and ports. | A Worker exposing the same listen/stop API. |

Correctness must not depend on a guaranteed shutdown callback during abrupt host termination. Persist committed data, recover on a new activation, and reconnect live consumers. While the Node adapter remains supported, its explicit app stop must still release responses and the listening port.

## 4. State, sharing, and ordering

The browser model remains a pure reducer with `scan`. State is not a publicly mutable Subject. A Subject may bridge external input at the boundary; consumers receive read-only Observable access.

Use explicit replay and connection policies. A mounted root holds the state connection for its lifetime, including periods with no view subscribers. Additional consumers must not repeat reductions or requests. Disposal releases graph ownership and replayed references.

RxJS 7.8.2's `shareReplay` defaults `refCount` to false and does not reset on completion. These are operator semantics, not the application's desired lifetime. Test late subscription, child removal, app disposal and remount. Reference: [RxJS 7.8.2 shareReplay](https://github.com/ReactiveX/rxjs/blob/7.8.2/src/internal/operators/shareReplay.ts).

Select an explicit serialized ingress policy for reentrant feedback. A synchronous result must not overtake the triggering input halfway through propagation. A queue-based scheduler can implement ingress ordering, but its location/effects need tests; scheduling is not a transaction system.

Where an effect depends on state, use a coherent transition snapshot associated with its input. Avoid incidental subscriber-order dependencies. Derive coupled view fields from one state emission. Do not claim arbitrary RxJS graphs are glitch-free.

Shared execution within one app is not distributed consistency. Client mutation queues do not serialize all clients. The authority must establish a tested read/validate/transition/commit boundary. Do not publish a proposed reduction as committed until state and ordering metadata have committed consistently. Persisted state is the recovery source; a Worker-global `shareReplay` or Subject is not a shared database.

## 5. Error, completion, and cancellation are different

Expected operation failures become typed result values while the intent-processing graph stays alive. A source's terminal `error` still ends that subscription; recovery is an explicit policy at the correct boundary.

Cancellation releases owned work and blocks obsolete results. It is not `complete`, not a successful result and not proof of remote rollback. Finalization runs for completion, error and unsubscription; traces need separate cause information to identify cancellation.

A client request adapter checks HTTP status, handles contract-appropriate empty bodies, validates decoded values and preserves structured failures. Unsubscription must reach abortable underlying work where supported, including body consumption. Do not automatically retry a mutation that may already have committed.

Guard the full HTTP boundary: matching, middleware, decoding and synchronous effect construction can fail before an operator's `catchError`. Finite-response cardinality, empty/never-settling handlers and settlement deadlines must be explicit and tested. The adapter translates the owned execution into the platform response interface without forcing Promise or Hono context semantics into the domain core.

A streaming descriptor and its body have different lifetimes. Returning a `Response` does not dispose an active SSE subscription. Conversely, ending a Hono streaming callback must not unintentionally close a still-needed stream. Post-header failures cannot be handled by replacing an already-started response with a fresh JSON error; follow the documented stream termination/protocol policy.

Unexpected faults must be reported with scope context and cleanup. Do not convert every fault to `EMPTY` and hide it. A failed persistence commit must leave the previous committed state authoritative. A successful commit followed by response loss is an uncertain client outcome, not a safely retryable failure.

## 6. Temporal and concurrency policies

| Boundary | Initial policy |
|---|---|
| Read refresh/search | Latest relevant read replaces its predecessor. |
| Create submission | Ignore duplicate submissions while an accepted create is pending. |
| Browser accepted mutations | Ordered queue with explicit finite admission/capacity behavior. |
| Authority mutations | Serialized validated commit boundary, tested across concurrent callers. |
| Independent work | Explicit overlap limit and separate admission/queue bound. |
| Rendering | Synchronous targeted commits initially; any frame policy is named and injected. |
| Reconnect | One owner, explicit limits/delays where controllable, canceled with scope. |
| Slow SSE consumers | Bounded transport writes/pending data; full snapshots may coalesce, domain events may not silently disappear. |

Source clocks and schedulers supply time. Operators implement delay, selection, ordering and concurrency policies. Tests inject time where appropriate instead of waiting for arbitrary sleeps. Browser EventSource-owned reconnection is browser-controlled; choosing it must not be described as a fully scheduler-controlled RxJS retry loop.

A concurrency limit does not bound queued inputs. An async observer callback does not automatically serialize or await transport writes. The transport owner must implement a tested bounded policy and handle write rejection/cancellation.

Server work must fit a supported host lifetime. An open subscription is not a platform keep-alive guarantee, and `waitUntil()` is not a durable infinite job. Do not add detached timers/subscriptions for perpetual background services. Durable scheduling products remain outside this proof.

## 7. Rendering contract

Keep the existing `h()` node-construction primitive. Build a stable shell, bind coherent derived values, and reconcile Todo rows by key. Each row owns its bindings and event adapters; removing it disposes them without disturbing siblings.

DOM handlers capture input and perform required immediate event handling, then emit an intent. They do not initiate nested HTTP subscriptions or directly mutate shared state. Named pure functions interpret domain intent.

Update only required DOM state; preserve focus, selection, drafts and native input behavior. Repeating a render must not trigger writes. Rendering may expose commit-notification streams when useful, but pure view construction need not be artificially wrapped in streams for uniform syntax.

Hono is selected for HTTP, not as a replacement renderer. Hono JSX, SSR, hydration, islands and automatic dependency tracking remain out of scope. These client requirements are unchanged by the Worker target.

## 8. Server contract

### Hono/Workers boundary and Node transition

Preserve the existing application's domain and HTTP behavior while moving platform integration to Hono on Workers through M05a–M05d. This supersedes r1's instruction to retain Node HTTP as the permanent architecture, not its characterization and cleanup requirements.

Use Hono for matching, middleware integration and response construction. Extract validated input plus narrow capabilities before entering RxJS operation/domain code. Keep platform raw objects at the boundary and migrate shared types explicitly. Preserve route inference, validation, body bounds, headers, status/error behavior and authentication through a compatibility matrix. A Hono context is not the service API of the core.

Each request owns its operation; each live response owns its subscription. Canceling one request or disconnecting one client must not stop other work. Retain Node startup/listen failure and shutdown/port-release requirements while that adapter remains supported. Its eventual retention or retirement needs an explicit tested decision, not an accidental deletion.

### Logical collection authority

The target shared authority is one Durable Object per logical Todo collection, with minimal attached persistence. Request operations receive the authority capability rather than constructing a new database each time. Enforce collection access policy before authority selection; knowing a key is not authorization.

Persist collection state, schema version, generation and revision. Commit state and ordering metadata consistently before publication/acknowledgment of committed success. Test serialization around asynchronous work and simultaneous requests. A pure transition determines the next value; the adapter supplies IDs/time and performs persistence.

Authority reconstruction restores the same committed history. Its resident graph and connections may be recreated; subscriptions are not persisted. Uncommitted in-memory state must not be published after failed storage work. Successful commit with lost response requires explicit uncertainty handling; no automatic exactly-once/retry guarantee is claimed.

Two independent in-memory test factories must remain isolated. Two request adapters intentionally addressing the same authorized collection must observe the same authority. Worker instance identity and JavaScript module globals must not define the collection's identity or consistency.

### Live-response resource policy

A live connection owns delivery resources, not collection state. Subscribe through the authority-to-Worker path, with a race-free initial snapshot/live-registration handoff. A mutation during setup cannot fall between an initial read and later subscription. Bound active clients, pending snapshots and writes according to the documented policy.

Register cleanup before synchronous sources can complete/fail. Check already-aborted requests and release subscriptions on response cancellation, write failure, source termination and local-runtime shutdown. Serialize writes; never accumulate unbounded pending write promises. Full-state snapshots may use bounded latest-snapshot coalescing. Do not silently drop events that represent distinct domain facts.

Persistent storage does not make live responses durable and does not imply SSE hibernation. Record active-stream limits/resource behavior and reconnect after interruption. Do not add a WebSocket rewrite to satisfy this milestone.

## 9. Live-state consistency decision

Use HTTP/SSE for the first complete loop. Committed server snapshots are the authoritative Todo collection. Mutation responses settle operation success/failure but do not separately append items already represented by snapshots. Connect to a complete current snapshot rather than racing an unversioned GET against pushes.

The target envelope identifies `collectionId`, `stateGeneration` and `revision`; exact wire fields are versioned in M06. Revision increases within a collection history. Generation survives routine Worker handling and authority reconstruction; an explicit reset/replacement creates new history. Do not derive generation from a Worker instance or restart a durable revision counter on every activation.

Connection/session identity is separate. Ignore notifications from superseded connections. A current connection establishes history through the documented resynchronization policy; arbitrary delayed different-generation messages must not reset the model. Compare revisions only within the same collection/generation.

Keep the old bare-array SSE route or change it through explicit coordinated version migration. Decode external values from `unknown`. Schema errors must be visible and recoverable according to the protocol, not allowed to corrupt state.

One connection is shared per mounted browser app. Choose one reconnect owner and cancel it on disposal. Show loading before the first accepted snapshot and stale/reconnecting state during a gap. Initial snapshot plus subsequent registration must have a tested no-lost-commit handoff.

Reconnection repairs current collection state, not an exactly-once event log. It does not establish whether a disconnected mutation committed. Do not add optimistic writes until the authoritative model is proven. A retained Node in-memory demonstration has a separate explicit reset-generation policy and is not evidence of durable recovery.

## 10. Scope boundary and acceptance

The goal is an RxJS-first application/metaframework foundation, not a replacement for Angular, Next or Nest in this phase. RxJS 7, TypeScript, existing custom JSX and HTTP/SSE remain the baseline choices.

The bounded additions are Hono/Workers integration, Vite/Cloudflare build support, Wrangler workflow and a minimal durable collection authority. No general ORM, auth product, browser routing framework, Hono JSX, SSR/hydration, islands, server-function compiler, custom scaffolder, plugin ecosystem, job system, multi-provider portability framework, distributed backpressure protocol or rich devtools is included.

Correctness, validation, authorization boundaries, bounded resources and cleanup are core requirements, not optional production extras. Type inference does not replace runtime validation. The toolchain must keep browser, Worker and Node-tooling environments explicit. Secrets and remote credentials never belong in client bundles, source control or generic public configuration.

**Completion means:** the Todo app demonstrates the whole loop, tests prove its relevant temporal/lifetime and durable-state contracts, and a fresh checkout builds/runs the documented local Cloudflare-oriented arrangement. M05a establishes runtime testing early; M08 adds cross-boundary evidence. Current source status, plan status, local verification, deployment readiness and actual deployed verification are reported separately.

No plan amendment or milestone closeout by itself authorizes publication, deployment, remote migrations or resource creation, account/secret changes, or changes to `netxpert.ch`. Preserve historical repositories and attribution. Review and merge through the working agreement in the roadmap; refresh the Project reference copy only with an honest record of what was actually updated.
