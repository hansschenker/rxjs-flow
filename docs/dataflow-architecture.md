# Dataflow architecture contract

Design revision: 2026-09-17; implementation checkpoint updated 2026-09-20. Target revision: **rxjs-flow migration r2 — Cloudflare/Hono**.

Applies to the ChatGPT Project **`rxjs-flow`** and development repository **`hansschenker/rxjs-flow`**. Read with the [canonical roadmap](roadmap-gpt-6-astra-2026-09-15.md) and [Cloudflare/Hono runtime decision](runtime-cloudflare-hono.md). The historical source `rxjs-stack` and separate `rxjs-fullstack` repositories are not development targets.

**Status:** target behavior, with implementation evidence recorded per milestone. M00 is accepted/closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e`; M01 is accepted/merged in PR #5. M05a is accepted/merged in PR #6. M02 is [accepted/merged in PR #7](m02/acceptance.md) at `7374557b6d264a9bfa572526a4f71233fc3aa24e`. M03 is [accepted/merged in PR #8](m03/acceptance.md) at `c64fda113b599ff9b0b21ae3e20aeff0c473a358`. M04 is [accepted/merged in PR #9](m04/acceptance.md) at `2b316a477600c91b3105c9e390949c29e90046d3`. M05b is [accepted/merged in PR #10](m05b/acceptance.md) at `1cfbaec`. M05c is [accepted/merged in PR #11](m05c/acceptance.md) at `d5500da`. M05d is [accepted/merged in PR #12](m05d/acceptance.md) at `540faec`; parent M05 is complete. M06 is [accepted/merged in PR #13](m06/acceptance.md) at `36d644f`. M07 reference-app completion is [accepted/merged in PR #14](m07/acceptance.md) at `92f2568`. M05b adapts the same finite server Effect and route definitions to Hono, with owned request execution and separately tested retained Node compatibility. M05c adds a configured collection authority with attached SQLite storage, atomic state/metadata commit and reconstruction. M05d adds race-free authority registration and response-owned bounded delivery. M06 adds the versioned public live protocol, authoritative Todo application snapshots and one bounded reconnect owner. M07 completes reference-app/form behavior. The owner explicitly authorized M08 from its verified merge; [temporal tracing](m08/acceptance.md) is implemented and locally verified; acceptance review/merge is pending. M09 and deployment remain pending. The [r1 contract](archive/dataflow-architecture-r1-2026-09-15.md) and M00 evidence are preserved.

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

The M03 checkpoint extracts pure Todo intent interpretation and one app-owned effect graph. Reads use latest-read cancellation; accepted create/update/delete operations share a FIFO with a default capacity of 32 active plus waiting writes. Create exhaustion lasts through queued and active work. Expected failures return correlated facts, and unexpected graph/render faults reach the host's cleanup/reporting boundary. HTTP work is cold, uses response contracts and shared Zod schemas, preserves structured failures and aborts body consumption on disposal. The generic SSE adapter requires a decoder from `unknown`. M06 connects the app to a distinct versioned live route with one owned connection, explicit retry policy and accepted snapshots as the collection authority. The pure model can still explicitly select the finite HTTP mode used by retained fixtures; the actual mounted host selects live mode.

The M04 checkpoint moves rendering into `todo.view.tsx`; the app root connects its already-shared view-model stream to the view. A stable shell holds scope-owned scalar bindings and keyed rows, each with a child scope. Commits are synchronous and targeted, retained rows preserve node identity, focus and selection, and removal disposes their listeners/bindings. Rendering does not initiate network work. See [acceptance evidence](m04/acceptance.md) and the [minimal binding sample](m04/minimal-sample.md).

M07 keeps that application and separates its feature program from the thin host
entry. `todo.program.ts` owns model/view/effect/input assembly; `main.tsx` handles
construction, mount and disposal, retaining the compatible `createTodoApp`
export. `browser.ts` is the executable entry. Its module exports expose the
existing application handle and mount function for owned embedding/lifecycle
checks in development and built output; no global test controller is introduced.
See [M07 acceptance](m07/acceptance.md) for current verification status.

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

M07 keeps draft value, draft revision, validation visibility, local filter and
pending/failed operation facts in the same model. A submitted draft is captured
with its revision; success clears only that exact accepted capture. Typing away
and back to identical text creates a newer draft and must survive the earlier
reply. A missing capture cannot clear a draft by comparing text alone. The pure
`validateTodoDraft` function trims and requires a nonblank title; server
validation remains authoritative.

All/Active/Completed filtering derives visible rows from the full remembered
collection. Summary counts continue to describe the full collection, and a
filter with no matches is distinct from a known empty collection. Each mounted
app owns its filter and unsent draft. Filtering starts no network request and
does not alter the authoritative snapshot.

The [M05c checkpoint](m05c/acceptance.md) uses `TodoRepository` as the finite
request capability. Named pure Todo transitions serve both the retained memory
adapter and `createTodoAuthority`. A thin `TodoCollection` Durable Object entry
owns the platform boundary. Its one persisted snapshot envelope contains schema
version, collection identity, generation, revision and Todos. SQLite's synchronous
transaction protects read/validate/transition/write; `storage.sync()` settles
before any successful result is emitted. Authority admission is bounded to 32
active-plus-waiting application operations. M05d adds `watch$()` registration
through that owner, making the initial committed snapshot/live handoff race-free.

An admitted authority operation remains owned even if its HTTP observer disappears.
A known transaction rollback reports `not-committed`; a failed flush or lost reply
reports `unknown`. No mutation is automatically retried. Failed flush also blocks
further results from that activation until reconstruction. These outcome values
belong to internal operation error details; M06 publishes a separate versioned
application live schema. Local configuration selects and authorizes the reference collection;
a request-supplied collection key cannot grant access.

## 5. Error, completion, and cancellation are different

Expected operation failures become typed result values while the intent-processing graph stays alive. A source's terminal `error` still ends that subscription; recovery is an explicit policy at the correct boundary.

Cancellation releases owned work and blocks obsolete results. It is not `complete`, not a successful result and not proof of remote rollback. Finalization runs for completion, error and unsubscription; traces need separate cause information to identify cancellation.

A client request adapter checks HTTP status, handles contract-appropriate empty bodies, validates decoded values and preserves structured failures. Unsubscription must reach abortable underlying work where supported, including body consumption. Do not automatically retry a mutation that may already have committed.

M07's operation feedback distinguishes a server rejection or known
`not-committed` result from an uncertain outcome. A corrected intent can execute
after failure; uncertain mutations require reviewing the resynchronized list
before deliberate repetition. Dismissing a message changes UI feedback only.

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

The reference form uses a labelled required input, model-derived validation and
explicit `aria-invalid`/description. Its deliberate `novalidate` keeps validation
feedback in the same model. Add is disabled for invalid input or an accepted
pending create; the text input stays editable. Filter radios belong to each
app's own form so two mounted roots cannot share a native radio group. Busy
rows keep their existing bounded mutation/focus policy; removal or filtering
out a row releases its child scope.

Hono is selected for HTTP, not as a replacement renderer. Hono JSX, SSR, hydration, islands and automatic dependency tracking remain out of scope. These client requirements are unchanged by the Worker target.

## 8. Server contract

### Hono/Workers boundary and Node transition

Preserve the existing application's domain and HTTP behavior while moving platform integration to Hono on Workers through M05a–M05d. This supersedes r1's instruction to retain Node HTTP as the permanent architecture, not its characterization and cleanup requirements.

Use Hono for matching, middleware integration and response construction. Extract validated input plus narrow capabilities before entering RxJS operation/domain code. Keep platform raw objects at the boundary and migrate shared types explicitly. Preserve route inference, validation, body bounds, headers, status/error behavior and authentication through a compatibility matrix. A Hono context is not the service API of the core.

Each request owns its operation; each live response owns its subscription. Canceling one request or disconnecting one client must not stop other work. Retain Node startup/listen failure and shutdown/port-release requirements while that adapter remains supported. Its eventual retention or retirement needs an explicit tested decision, not an accidental deletion.

The M05b checkpoint removes Node raw objects from `HttpRequest`, adds a request
AbortSignal, and gives both HTTP adapters one explicit finite-operation owner.
Exactly one response value plus completion is required; empty/multiple results
fail with 500 and a default absolute 10-second settlement deadline fails with 504.
Observing replayed outcomes never starts another execution. Input bytes are
bounded to 1 MiB, and cancellation releases the request's work. The Hono adapter
uses `/api` once and consumes canonical route definitions; the retained Node
adapter keeps its unprefixed paths. See [M05b compatibility](m05b/acceptance.md).
M05c replaces the volatile Worker demo with a configured Durable Object authority.
The development runtime persists locally; checked-in and built configuration
leave Todo access disabled. See the [M05c checkpoint](m05c/local-development.md)
for the explicitly enabled local workflow.

### Logical collection authority

The target shared authority is one Durable Object per logical Todo collection, with minimal attached persistence. Request operations receive the authority capability rather than constructing a new database each time. Enforce collection access policy before authority selection; knowing a key is not authorization.

Persist collection state, schema version, generation and revision. Commit state and ordering metadata consistently before publication/acknowledgment of committed success. Test serialization around asynchronous work and simultaneous requests. A pure transition determines the next value; the adapter supplies IDs/time and performs persistence.

Authority reconstruction restores the same committed history. Its resident graph and connections may be recreated; subscriptions are not persisted. Uncommitted in-memory state must not be published after failed storage work. Successful commit with lost response requires explicit uncertainty handling; no automatic exactly-once/retry guarantee is claimed.

Two independent in-memory test factories must remain isolated. Two request adapters intentionally addressing the same authorized collection must observe the same authority. Worker instance identity and JavaScript module globals must not define the collection's identity or consistency.

### Live-response resource policy

A live connection owns delivery resources, not collection state. Subscribe through the authority-to-Worker path, with a race-free initial snapshot/live-registration handoff. A mutation during setup cannot fall between an initial read and later subscription. Bound active clients, pending snapshots and writes according to the documented policy.

Register cleanup before synchronous sources can complete/fail. Check already-aborted requests and release subscriptions on response cancellation, write failure, source termination and local-runtime shutdown. Serialize writes; never accumulate unbounded pending write promises. Full-state snapshots may use bounded latest-snapshot coalescing. Do not silently drop events that represent distinct domain facts.

The M05d implementation registers `watch$()` through the same bounded serialized
owner as authority operations. The initial committed read and attachment happen
in one queue turn; later successful commits publish to registered consumers only
after storage settlement. Cancelled queued registrations retain their queue slot
until drained, preventing repeated connect/cancel from hiding unbounded work.
One collection admits at most 32 live registrations, including pending setup.
The retained Node listener separately admits at most 32 active SSE responses.

The Durable Object sends validated internal snapshot envelopes over a private
Fetch NDJSON body. Each Worker response owns a cold reader and explicitly
cancels that upstream body. The public `/api/todos/stream` endpoint keeps the
legacy `todos` event with a bare Todo array. M06 adds `/api/todos/live`, emitting
the versioned `todo-snapshot` envelope through the same owned delivery path.
Only the new route feeds the Todo application's live model; the legacy wire is
not reinterpreted.

The Worker body owner uses a zero-high-water-mark ReadableStream and a bounded
pending queue. Generic events retain FIFO order with a 16-frame/256-KiB pending
budget and a 128-KiB maximum frame; overflow terminates visibly. Only complete
snapshot streams opt into replacement of one pending snapshot by the latest.
The authority's NDJSON side allows one pending frame of at most 120 KiB plus its
newline. Limits cover application queues, not platform or network buffers.
Synchronous completion drains accepted bytes; error/cancel discards pending bytes
and releases the source/listener. After headers, failure terminates the stream.
See [M05d acceptance](m05d/acceptance.md) for retained Node backpressure, transport
checks and measured cleanup.

Persistent storage does not make live responses durable and does not imply SSE hibernation. Record active-stream limits/resource behavior and reconnect after interruption. Do not add a WebSocket rewrite to satisfy this milestone.

## 9. Live-state consistency decision

Use HTTP/SSE for the first complete loop. Committed server snapshots are the authoritative Todo collection. Mutation responses settle operation success/failure but do not separately append items already represented by snapshots. Connect to a complete current snapshot rather than racing an unversioned GET against pushes.

M06 publishes `event: todo-snapshot` on `/api/todos/live` (Worker) and
`/todos/live` (Node). Its runtime-decoded envelope is `{ schemaVersion: 1,
collectionId, stateGeneration, revision, todos }`. `/todos/stream` remains the
legacy `todos` bare-array route. Finite client construction excludes live routes;
a live contract is not consumed through `res.json()`.

Revision increases within a collection history. Generation survives routine
Worker handling and authority reconstruction; explicit reset/replacement creates
new history. Generation is not derived from a Worker instance. The first accepted
snapshot pins the app's collection. Compare revisions only within that collection
and generation; duplicates/older revisions never replace collection content.

Connection identity is separate and changes per attempt. Superseded notifications
are ignored. Only the first validated snapshot of a new current connection may
establish a changed generation for the pinned collection. A changed generation
later in that connection requires manual resynchronization; a different collection
is rejected. An equal first revision confirms the remembered snapshot without
replacing it; an older first revision requires recovery rather than accepting a
regression. These choices are a resnapshot policy, not an ordering of generation
UUIDs.

One live effect is owned by the mounted browser app. State and view consumers
share its remembered output without opening extra connections. Before the first
snapshot the UI shows loading; during a gap it retains accepted Todos with a
stale/reconnecting status. Mutation replies settle their pending operation but
never independently modify the live collection. Drafts, pending operations and
mutation errors remain distinct from connection status/error.

The RxJS connection owner closes EventSource on an interruption and is the only
reconnect mechanism. It schedules at most four retries after 1, 2, 4 and 8 seconds,
with an injected scheduler and a 10-second first-snapshot deadline per attempt.
A valid snapshot resets consecutive failures. Protocol failure and exhaustion
require manual Reconnect; disposal cancels the transport, retry and deadline.
Native EventSource reconnect does not compete with this policy. The deadline
only protects the first snapshot; there is no heartbeat or fixed detection time
for a silent partition after synchronization. Runtime decoding begins from
`unknown` and rejects malformed data before state replacement.

Reconnection repairs current collection state, not an exactly-once event log.
A disconnected mutation may already have committed; local cancellation is not
rollback, and no mutation is automatically replayed. Retained Node factories and
explicit resets start fresh in-memory generations and revisions. That separate
reset policy is not evidence of durable recovery. See [M06 acceptance](m06/acceptance.md)
and the [two-tab checkpoint](m06/local-development.md) for executable evidence.

## 10. Observational temporal traces

M08 adds optional constructor-injected observations at the existing source,
model, effect, render, authority, transport and disposal boundaries. Construction
is inert. The existing owner still subscribes once; adding a trace reader does
not execute another effect or open another live connection. Named pure reducers
and selectors do not receive logging or platform capabilities.

Each trace runtime supplies an explicit identity, monotonically increasing local
sequence and injected clock. Records include owned scope/source identities and
operation, connection or committed collection/generation/revision identities
where available. Equal timestamps do not define notification order. Independent
browser, Worker and authority clocks do not establish a global total order.

The metadata vocabulary excludes payloads, credentials, headers, URLs and full
errors. A bounded recorder retains recent immutable records and reports dropped
history. Sink/clock errors are diagnostic failures, not stream errors. Tracing
is a synchronous host capability: deliberately mutating application state or
blocking inside a supplied sink is outside its observational contract.

Complete local integration can join owners through an explicitly trusted
in-process diagnostic context. That test seam does not introduce a production
HTTP header, public RPC tracing protocol or remote-instance identity. Native
browser HTTP/SSE observations are recorded separately. Resource release is
verified directly, not inferred from a cancel/finalize record alone. See
[M08 acceptance](m08/acceptance.md) and [readable traces](m08/temporal-traces.md).

## 11. Scope boundary and acceptance

The goal is an RxJS-first application/metaframework foundation, not a replacement for Angular, Next or Nest in this phase. RxJS 7, TypeScript, existing custom JSX and HTTP/SSE remain the baseline choices.

The bounded additions are Hono/Workers integration, Vite/Cloudflare build support, Wrangler workflow and a minimal durable collection authority. No general ORM, auth product, browser routing framework, Hono JSX, SSR/hydration, islands, server-function compiler, custom scaffolder, plugin ecosystem, job system, multi-provider portability framework, distributed backpressure protocol or rich devtools is included.

Correctness, validation, authorization boundaries, bounded resources and cleanup are core requirements, not optional production extras. Type inference does not replace runtime validation. The toolchain must keep browser, Worker and Node-tooling environments explicit. Secrets and remote credentials never belong in client bundles, source control or generic public configuration.

**Completion means:** the Todo app demonstrates the whole loop, tests prove its relevant temporal/lifetime and durable-state contracts, and a fresh checkout builds/runs the documented local Cloudflare-oriented arrangement. M05a establishes runtime testing early; M08 adds cross-boundary evidence. Current source status, plan status, local verification, deployment readiness and actual deployed verification are reported separately.

No plan amendment or milestone closeout by itself authorizes publication, deployment, remote migrations or resource creation, account/secret changes, or changes to `netxpert.ch`. Preserve historical repositories and attribution. Review and merge through the working agreement in the roadmap; refresh the Project reference copy only with an honest record of what was actually updated.
