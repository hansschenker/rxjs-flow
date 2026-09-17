# M02 — Instance-owned state and coherent derived streams

Date: 2026-09-17. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m02/instance-state`.
- Starting commit: `eeb8d2989884372fa42f4e321295aa7f3e8faa75`, verified merge of
  PR #6. M00, M01 and M05a remain accepted. Original history is preserved.
- Implementation commit: `52c930c99ffa6edb5f28db5889ba25981b901951`.
- Implementation tree: `42fd0335532862eda2609b726fb515b70312d65d`.
- [Execution records](execution.json) preserve commands, UTC timestamps, exit
  codes and selected output. Subsequent changes record evidence/status only;
  the final PR-head CI result is recorded in the PR.

The user authorized M02 after accepting PR #6. The canonical sequence is still
M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07 → M08 → M09.
This checkpoint changes the browser state program and its integration only.
No package/lockfile, Node server, Worker, shared route, HTTP adapter, SSE adapter,
CI workflow, deployment, remote resource or account/domain configuration changed.

## Implemented contract

`createTodoModel()` replaces module-global actions, state and dispatch. It exposes
read-only `state$`, `viewModel$` and `transitions$`, plus instance-scoped
`start`, `dispatch` and `dispose`. Construction and pre-start subscriptions are
inert. Dispatch before start or after disposal returns false. Start happens once.

The small `createProgram` runtime subscribes to one `scan` under its own Scope;
the mounted app owns that program until disposal. A private ReplaySubject holds
one current state for all readers. Additional consumers never subscribe to the
reducer pipeline. Removing every view leaves the owner/accumulation alive.
Disposal rejects input first, clears queued messages, ends public consumers and
releases the accumulator. It replaces the state replay holder with an empty
completed holder, so retaining the disposed public Observable cannot replay the
old state. A new instance gets a fresh initial object and arrays. Consumers that
explicitly store a received value remain responsible for that reference.

Ingress is a synchronous, per-instance FIFO. Reentrant dispatch appends work;
the current state and transition finish publication before the next reduction.
Startup feedback also waits until `startWith(initial)` has finished and the input
subscription is attached. This uses no microtask or timer. Disposal during startup
or publication stops further delivery and drops queued work. Unexpected initializer
or reducer exceptions terminate the instance and error active consumers; ordinary
operation failures are recoverable typed messages.

Every accepted message yields `{ message, previous, state }` from that reduction.
Transitions do not replay, so attaching a later effect does not rerun an old intent.
The Todo model suppresses unchanged state references; those accepted intents still
appear on `transitions$`. `viewModel$` maps a single state through `selectViewModel`
and uses `equalViewModel` across every exposed field. It does not combine separately
derived branches or claim arbitrary reactive graphs are transactionally coherent.

The readonly model contains collection data, draft, initial-load status, identified
pending operations, recoverable error and connection status. Pure named updates
copy incoming arrays, Todo objects and operation records, preserving unchanged
item identities. The host allocates instance-unique operation IDs; the model trusts
that caller contract. Outcomes settle only matching operations. Unknown/duplicate facts and wrong-target successes are ignored.
A late update cannot resurrect an item already removed from the model. Create
success preserves a newer draft. A confirmed empty collection stays known through
a failed/cancelled refresh. Snapshot facts preserve local draft/pending state.

`createTodoApp` connects views and feedback before starting the model, then attaches
DOM inputs and dispatches the load intent. Row callbacks emit typed intents. The
existing service calls remain wired in this host, now reporting started, success,
failure and cancellation facts. Create retains its existing `exhaustMap` policy.
Empty finite completion is a missing-result failure, not cancellation. Shutdown
rejects teardown feedback and then discards the whole model. Full extracted effect
policies and HTTP decoding remain M03 work.

The existing whole-list renderer runs on collection change or a newly displayed or
changed failure message; draft/pending facts preserve current rows. Such a failure
message restores controls to model values. This prevents new UI state from rebuilding rows on each keystroke. Keyed
rendering, field bindings, focus and overlapping-operation UX remain M04 work.

## Visible examples from the tested model

The synchronous-startup test has two state consumers and one feedback consumer.
The load intent returns started/success facts synchronously. Both state consumers
receive each row before feedback advances to the next row:

| Accepted input | Model state emission | Pending | Transition snapshot |
|---|---|---:|---|
| `start()` | `idle`, empty collection | 0 | No initial transition |
| `LOAD_REQUESTED` | Unchanged; suppressed | 0 | `previous === state`, both idle |
| `OPERATION_STARTED(load)` | `loading`, empty collection | 1 | idle → loading |
| `LOAD_SUCCEEDED` | `ready`, one Todo | 0 | loading → ready |

The coherent-derived-values test replaces the collection with two Todos, marks the
remaining Todo complete, then supplies an empty collection. Every emission satisfies
`remaining + completed === total` and agrees with its own `todos`:

| Snapshot | Loading | Empty | Total | Completed | Remaining |
|---|---|---|---:|---:|---:|
| Initial, no collection received | true | false | 0 | 0 | 0 |
| Two Todos, one complete | false | false | 2 | 1 | 1 |
| Both complete | false | false | 2 | 2 | 0 |
| Confirmed empty | false | true | 0 | 0 | 0 |

See [model tests](../../src/client/todo.model.test.ts),
[runtime tests](../../src/client/runtime/program.test.ts) and
[app tests](../../src/client/app.test.ts). Run the focused checkpoint from the repo:

```bash
npx vitest run src/client/runtime/program.test.ts src/client/todo.state.test.ts src/client/todo.model.test.ts src/client/todo.selectors.test.ts src/client/app.test.ts src/client/main.test.ts
```

## Acceptance criteria

| M02 criterion | Executed evidence | Result |
|---|---|---|
| Reducer determinism and immutability | Frozen state/action traces; input-copy ownership and stable unchanged items | Pass |
| Isolated instances | Independent programs/models and two simultaneously mounted app roots | Pass |
| Initial state before external actions | Inert factory/subscription tests; initial delivery and startup load trace | Pass |
| Current state for late subscribers | Current-only replay; no historical transition replay | Pass |
| Additional consumers do not repeat reductions | Counted reducer invocations with multiple consumers; shared state identity | Pass |
| Synchronous startup results retained | Initial-feedback FIFO tests and synchronous service app load | Pass |
| Coherent derived fields | Snapshot/count invariants, pending/draft/submission eligibility and explicit equality tests | Pass |
| View disconnection does not erase owned memory | Remove all consumers, dispatch more input, reconnect to current state | Pass |
| New scope starts fresh | Disposal/recreation and remount tests; old instance stays closed with empty replay | Pass |

Final totals: **318 tests / 27 Node/DOM files + 16 tests / 1 workerd file = 334 tests**.
The 11 old state/global tests are replaced by 70 state/model/selector cases. All
18 M01 app cases remain, with seven M02 cases; the inert-import test now observes
the per-instance stream. Sixteen new runtime tests include a 10,000-step synchronous
feedback chain. The separate intentionally failing M00 characterization branch is
untouched; startup loss and ownership continue to have tested replacements here.

## Commands and results

Node **22.22.1**, npm **11.9.0**, RxJS **7.8.2**, TypeScript **6.0.3**, Vite
**8.0.12**, Vitest **4.1.6**. M05a's pinned Hono/Cloudflare toolchain is unchanged.

| Command/check | Result |
|---|---|
| Baseline `npm test` | Pass: 236 Node/DOM tests / 24 files |
| Focused runtime and state/model/selector runs | Pass: 16 runtime + 70 model-related tests |
| Early integrated app runs | Two failures, then one: duplicate no-op state emission and an invalid duplicate-ID fixture; resolved by model equality and a separate shadow root |
| `npm ci` | Pass: clean lockfile install, 153 packages |
| `npm run typecheck` | Pass: generated types and all five TS projects |
| `npm test` | Pass: 318 Node/DOM tests / 27 files |
| `npm run test:worker` | Pass: 16 tests in workerd |
| `npm run cf:typecheck` | Pass: generated Worker types current |
| `npm run build:worker` | Pass: client 33.59 kB JS; Worker 103.38 kB JS |
| `npm run smoke:worker` | Pass: real local built-preview HTTP, client asset, foundation API and routing precedence |
| `git diff --check` and unchanged-boundary diff | Pass |

Inspection also used Git fetch/status/log/diff/rev-parse, repository/source reads,
`rg`, `npm ls`, and read-only GitHub PR verification. The implementation tree was
compared with `git write-tree` before publishing through destination-only GitHub
tree/commit/branch operations. Fetch plus a tree-equality-guarded `git reset --soft`
synchronized the local commit without discarding changes. The evidence commit and
PR record the resulting reviewable checkpoint; no merge is automatic.

## Blockers and limits

No local M02 blocker remains. Review corrected empty-completion classification
and prevented pending/draft facts from rebuilding rows. All final checks pass.
Environment proxy/experimental and inherited punycode warnings are informational.

`SERVER_SNAPSHOT` accepts domain Todo data whose caller must validate before
dispatch. M02 activates no external snapshot adapter. The retained HTTP adapter
still uses asserted response types: HTTP decoding remains M03, and live snapshot
decoding/admission remains M06. This checkpoint does not claim validated wire
ingestion, live revision ordering or server authority in the browser.

The FIFO prevents reentrant propagation; it is not an async overload/capacity policy.
Mutation ordering, robust pending/cancellation policies, status/body decoding and
abort during body consumption remain M03 work. Node/DOM tests run on Linux/jsdom;
the Worker smoke fetches the new client bundle without executing its UI. No separate
Windows or real-browser run is claimed. Use the retained Node workflow for Todo CRUD;
the Worker still intentionally returns JSON 404 for `/api/todos`.

M03 is next only after M02 acceptance and authorization. M04, remaining M05 substeps,
live integration and deployment have not advanced. The ChatGPT Project reference
copy remains separately unverified; Git publication does not synchronize it.
