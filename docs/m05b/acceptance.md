# M05b — HTTP compatibility and request ownership

Date: 2026-09-18. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: accepted and merged in [PR #10](https://github.com/hansschenker/rxjs-flow/pull/10)
at **`1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`**. Final-head CI passed at
`db9aeb47fb1e17cdde50bb1583f7f95df562459e` in
[run 35345130819](https://github.com/hansschenker/rxjs-flow/actions/runs/35345130819):
570 Node/DOM tests and 86 workerd tests, typechecks, generated types, builds and
both local HTTP smokes passed. The owner subsequently confirmed the pleasant
layout and input preservation during Refresh. This is a manual browser observation,
not an additional automated browser suite.

This report records the M05b implementation. M05c subsequently replaces the volatile
Worker demo with durable local storage; see its [acceptance record](../m05c/acceptance.md)
and [current development guide](../m05c/local-development.md).

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m05b/http-ownership`.
- Starting commit: **`2b316a477600c91b3105c9e390949c29e90046d3`**, verified current
  `main` and PR #9 merge. M04 is accepted; its final-head CI passed and the owner
  subsequently confirmed that the local page works and looks good.
- Implementation commit: **`407ce32ad041df6c60fbfab043927bebe38e811e`**.
- Implementation tree: `034b8a25cc11be1a1190590cb7fad30e3b7419cb`.
- [Execution record](execution.json): commands, timestamps where captured, exit
  codes, baseline/final counts, intermediate failures, review fixes and limits.
- [Visible checkpoint](local-development.md): the existing Todo page talks to
  Hono in local workerd at `http://localhost:5174`.

The owner explicitly authorized M05b. RxJS remains 7.8.2; browser/domain wire
contracts, the M04 renderer, client effect policies, package versions and lockfile
are unchanged. The only CI addition runs the local development HTTP smoke.
M05c durability, M05d Worker streaming, and M06 live application integration are
not implemented. The separate M00 characterization branch remains unchanged.

## HTTP compatibility matrix

Paths below are canonical. Node exposes them directly; Hono owns exactly one
`/api` prefix. Both adapters consume `createTodoRoutes()` and the existing shared
route contracts; domain Effects receive portable request values/capabilities.

| Contract | Retained behavior and evidence |
|---|---|
| `GET /todos` | 200, validated Todo array; optional `completed=true/false` filtering |
| `POST /todos` | 201, created Todo; nonempty title required; unknown input keys stripped |
| `PUT /todos/:id` | 200, updated Todo; optional title/completed; empty object allowed; missing item 404 |
| `DELETE /todos/:id` | Empty 204 on success; missing item 404, never a false success |
| `GET /health`, `/ready` | Default 200 JSON health/readiness values; opt-out remains available |
| Unknown path / wrong method | JSON 404; `/api/api/todos` is not an alternative mount |
| Body decoding | Empty body becomes `{}`; nonempty body is JSON regardless of content type; at most 1 MiB of bytes; malformed JSON 400; oversized body 413 |
| UTF-8 | Split characters preserved; malformed bytes rejected with 400 in both adapters; a JSON BOM remains rejected |
| Validation | 422 with `{ error, details: { target, issues } }`; shared Zod schemas retained |
| Response conversion | JSON content type by default, custom headers/status preserved; 204/205/304 empty; invalid headers/status, circular or unrepresentable JSON fail inside the request boundary |
| Context | Application capabilities shared deliberately; each request has its own request context, ID and authenticated claims |
| Middleware | App then group/route middleware retains ordering; RxJS `Middleware` remains an `OperatorFunction`, visibly adapted rather than relabeled as Hono middleware |
| Authentication | Opt-in Bearer verifier; missing/invalid token 401; health/ready excluded by default; claims in request context; protected domain failures keep their own error meaning |
| CORS | Optional outer wrapper; OPTIONS 204, configured origins/methods/headers/credentials retained; tests verify auth rejection cannot execute protected work |
| Slash handling | Hono normalizes repeated/trailing slashes to preserve baseline matching; malformed path encoding produces 400 and does not stop subsequent requests |
| SSE descriptor | Retained Node endpoint still serves the legacy bare-array `todos` event; Worker responds 501 without subscribing until M05d |

The reference Todo app remains public **by local configuration**, as the Node
baseline was. Auth compatibility is demonstrated with injected verifier fixtures;
no new application-login product or release access policy is claimed. Wrong
prefixes and alternative mounts do not execute protected operations. Actual local
asset/SPA checks keep `/api`, unknown API paths and duplicate prefixes as JSON
errors even with navigation headers, while non-API navigation serves the shell.

The production configuration has no Todo authority yet and returns 503 for CRUD.
`LOCAL_TODO_DEMO=enabled` is supplied only by Vite development configuration and
creates an explicitly volatile instance-local sample store. Builds retain
`disabled`; their preview proves that missing storage does not silently become
Worker-global deployed authority. Worker imports use the inert store factory;
the legacy singleton compatibility module is excluded from that import path.

## Execution and ownership contract

`createRequestOperation()` describes one operation. Only `start()` activates it.
Its result Observable replays one outcome; extra or late consumers do not repeat
validation, state changes or transport work. Disposal is idempotent.

| Finite operation behavior | Outcome |
|---|---|
| Exactly one response, then complete | Success; response converted before settlement |
| Complete without a response | 500 defined failure |
| A second response | 500 defined failure before any candidate is sent |
| Never settles, including one value without completion | 504 at an absolute deadline, 10 seconds by default |
| Synchronous construction, matching, middleware, decoding or conversion failure | Structured failure; later requests remain usable |
| Already aborted, aborted while active, or explicitly disposed | 499 outcome; owned work canceled, late values ignored |

The owner registers subscribers and abort cleanup before synchronous execution.
Body reading is inside the deadline/cancellation boundary. Deadline time comes
from an injected scheduler or RxJS's async scheduler; emissions do not extend it.
Elapsed-time checks also reject late synchronous settlement, although JavaScript
cannot preempt a synchronously blocked thread. Cleanup releases timers/listeners
and reports teardown faults without preventing the remaining cleanup.

Each HTTP request has its own owner. Request A can be canceled while B continues.
Cancellation does not roll back a completed mutation. The finite descriptor and a
streaming body have different lifetimes; generic operation success does not own
or subscribe a descriptor's SSE body. Node response-close/shutdown cleanup is
preserved separately; bounded live delivery remains M05d.

Cloudflare's `enable_request_signal` compatibility flag is explicit so incoming
client disconnects can reach the request signal. This is required platform
configuration, not proof of remote deployment. See the official
[Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/#properties)
and [compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests).
Hono route mapping follows its [routing API](https://hono.dev/docs/api/routing),
checked alongside pinned package source and actual workerd tests.

## Deliberate API migrations and corrected defects

- `HttpRequest.raw` is removed from the portable contract; `signal: AbortSignal`
  supplies cancellation. Node raw objects remain inside its adapter. The server
  `Effect` remains `Observable<HttpRequest> → Observable<HttpResponse>`.
- Direct `createServer()` consumers now receive an unconsumed body plus
  `RequestEvent.readBody(signal)`. `bootstrap()` performs that read inside the
  request owner. This is a deliberate adapter-specific API change.
- `bootstrap()` returns a Subscription-compatible owner with `ready`, `stopped`
  and `address()`. `app.start()` waits for listening, rejects duplicate/reentrant
  starts, reports bind failures, and requires cleanup after a failed start.
  `app.stop()` awaits port release and all stop hooks, then reports aggregated
  hook failures. Stopping during startup prevents later listener activation.
- Auth verification failures alone become 401. A protected handler's failure is
  no longer mislabeled as failed authentication.
- Request parsing no longer damages a UTF-8 character split between chunks.
  Body limits reject immediately without waiting for an unfinished upload.
- Malformed route parameters and synchronous effect construction no longer close
  the root Node listener. Conversion faults are checked before sending headers.
- Independent review found and corrected startup-hook reentrancy, incomplete
  startup cleanup, skipped later stop hooks, throwing transport finalizers, and
  unread Worker body cleanup on failures before body acquisition.

## Acceptance criteria

| M05b criterion | Evidence | Result |
|---|---|---|
| Valid request succeeds after malformed input or synchronous handler throw | Real Node HTTP lifecycle tests; workerd Hono boundary tests; actual local Worker malformed JSON/parameter smoke followed by GET 200 | Pass |
| Simultaneous request contexts are isolated | Independent request context/ID/claims checks in Node and workerd, with shared injected capabilities | Pass |
| Canceling A leaves B running | Generic owner tests, real Node disconnect tests, workerd Request-signal and client-to-Hono dispatch tests | Pass |
| Body bounds, validation, auth and finite response outcomes | 1 MiB bound, UTF-8, Zod, protected route/CORS, empty/multiple/never/one-without-complete and conversion regressions | Pass |
| Extra consumers do not duplicate execution | Inert construction/observation, one explicit start, late outcome replay, separate HTTP subscription tests | Pass |
| Worker and retained Node compatibility have separate evidence | 86 workerd tests, Node HTTP/lifecycle tests within the 570 Node/DOM tests, distinct dev and built-preview HTTP probes | Pass |

## Executed validation

Baseline: **513 Node/DOM tests + 16 workerd tests = 529**, all passing at the
starting commit. Final: **570 Node/DOM tests / 35 files + 86 workerd tests / 3
files = 656 passing tests**.

Recorded toolchain: Node **22.22.1**, npm **11.9.0**, RxJS **7.8.2**, TypeScript
**6.0.3**, Vite **8.0.12**, Vitest **4.1.6**, Hono **4.13.8**, Wrangler
**4.133.0**, Cloudflare Vite plugin **1.54.11**, workerd **1.20260916.1**.
Existing installed dependencies match the unchanged lockfile; local `npm ci` was
not repeated during concurrent implementation. PR CI performs its clean install.

| Command/check | Result |
|---|---|
| `npm run typecheck` | Pass: generated types and all five TypeScript projects |
| `npm test` | Pass: 570 Node/DOM tests |
| `npm run test:worker` | Pass: 86 workerd tests |
| `npm run cf:typecheck` | Pass: generated Worker types current |
| `npm run build:worker` | Pass: browser and Worker bundles; browser unchanged at 102.70 kB JS / 2.58 kB CSS |
| `npm run smoke:worker -- --dev` | Pass: page/modules plus actual Hono Todo CRUD, 400/422 recovery, empty 204, missing 404 and API fallback behavior |
| `npm run smoke:worker` | Pass: built assets/foundation and JSON API failures, including intentional 503 without authority |
| `git diff --check` / unchanged-boundary comparison | Pass after removing a trailing blank line; client/shared contracts/package/lock unchanged |
| Independent code/targeted lifetime review | Findings fixed and regression-tested; no unresolved blocker reported |

The intentionally failing auth and stop-hook regressions, intermediate typing
issues, and an exploratory review-harness failure are retained in the execution
record with their dispositions. They are not final acceptance failures.

## M00 characterization disposition and limits

| Historical concern | M05b disposition |
|---|---|
| Malformed `%ZZ` parameter stops listener | Fixed; real Node request returns 400 and following request succeeds |
| Synchronous handler construction stops listener | Fixed; bounded 500, subsequent request succeeds |
| Real Node SSE disconnect leaks source | Fixed for the retained adapter; response-close ownership tested with sockets |
| Node app stop leaves SSE and port alive | Fixed; active response cleanup, finalizer faults and port release tested |
| Worker bounded SSE delivery / authority-to-client path | Still M05d; no implementation acceptance claimed |

There is no remaining M05b implementation blocker. Workerd tests use the actual
runtime and Web Request/Response APIs, but client-to-Hono tests dispatch directly;
they are not socket-disconnect measurements. Real local Worker HTTP probes cover
CRUD/assets/error recovery; real disconnect assertions run against Node. No
remote Cloudflare scheduler, deployment, or global-state consistency is tested.

No new real-browser visual assertions ran for M05b. The M04 UI is unchanged and
retains its DOM tests and the owner's prior manual review. The locally runnable
page is supplied for browser review. Durable storage, Worker SSE/backpressure,
live convergence, production authentication/release setup, and remote deployment
remain later work. No secrets, account settings, remote resources, DNS, domains,
package publication, main merge or release were changed by this milestone.
