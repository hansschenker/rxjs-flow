# M01 — Browser lifetime acceptance

Date: 2026-09-17. Plan: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: accepted/merged in PR #5 at `188f21ff307ff7d2146d9f90b24e5ee5c7dfd99d`.
The original local evidence below remains tied to its recorded implementation commit.
M00 remains closed. No later milestone is implemented by this change.

## Baseline and evidence identity

- Repository: `hansschenker/rxjs-flow`; branch: `m01/owned-lifetimes`.
- Starting main: `d749f83e79de3b4632a3776539f82d35f0c6676e`, merged r2 plan PR #4.
- Implementation commit: `7cd4b412ab7e536e86609a7d4ec2964bb093e64c`.
- Implementation tree: `d08d7937962f9f77007287f80f67253f5889aa46`.
- Starting production source tree: `6fdf2f7fc951b8fb7be29be2bb9614bf7ca36ad6`,
  matching the imported application. No history replacement or import was needed.
- Node **22.22.1**, npm **11.9.0**, RxJS **7.8.2**, TypeScript **6.0.3**,
  Vite **8.0.12**, Vitest **4.1.6**, jsdom **29.1.1**. Dependencies and lockfile unchanged.

The implementation commit contains the exact code tested below. The following
documentation commit records the results without changing that code. Final PR-head
CI is recorded in the PR description, separately from local evidence.
[Execution records](execution.json) contain command arguments, UTC start/end times,
exit codes and result excerpts. Vitest's displayed clock used the process timezone;
the JSON timestamps use UTC.

The owner asked to recheck the changed milestone order during implementation.
Fetching current main again confirmed the same r2 revision:
**M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07 → M08 → M09**.
M05a explicitly depends on M01. The early platform step moved ahead of M02–M04;
it did not replace M01. Main remained at the starting commit during this check.

## What changed

`createTodoApp(service?)` in `main.tsx` constructs an inert application. Calling
`start(root)` resolves its DOM and activates it once. `dispose()` is terminal and
idempotent; start after disposal is a no-op. To remount, dispose the old app and
construct a fresh one. `mountTodoApp(root, options?)` combines construction/start
for a host and registers optional hot-disposal ownership. Missing mount elements
fail before activating sources.

`browser.ts` is the explicit executable entry selected by `index.html`. Feature
module imports do not activate it. The browser entry registers Vite self-acceptance
and forwards its hot host to `mountTodoApp`. The installed Vite 8 import-analysis
code recognizes the optional-chain `import.meta.hot?.accept()` boundary.

```ts
import { createTodoApp } from './src/client/main';

const app = createTodoApp(); // No DOM lookup, subscription or request.
app.start(document);        // Owns listeners, requests, rows and state binding.
app.dispose();              // Call before the host removes/replaces the view.
app.dispose();              // Safe.
```

`createScope` uses RxJS `Subscription` ownership. It registers the actual subscriber
before source activation, so synchronous emissions can dispose their owner safely.
A closed scope never subscribes a new producer; adding cleanup after disposal runs
it immediately. Disposed child subscriptions detach from their parent through RxJS.

`domEvent$` attaches one listener per subscription to the browser's independently
hot event producer. It captures values synchronously before downstream timing or
concurrency operators. Submit captures a trimmed title and calls `preventDefault`
even while the existing `exhaustMap` is busy. Rows capture checkbox values and IDs.
TodoItem now requires a scope, owns both listeners and removes its row on disposal.
The custom JSX `h` primitive is unchanged; the mounted app no longer uses its
unowned `on*` event props.

The state binding connects before startup requests, preserving synchronous load
results. The existing shared model uses explicit ref-counted replay so the last
mounted owner releases accumulation/replay. This is the minimum M01 cleanup change,
not M02's instance factory, richer model, selectors or ingress-ordering contract.

## Ownership contract

| Resource | Owner and activation | Release |
|---|---|---|
| App and submit listener | One app; attach at start through the source scope | App disposal first closes accepted inputs and removes the listener |
| DOM event listener | One subscription; subscription registers against a hot browser producer | That subscription removes the same listener |
| Create operation | Inner subscription of the app-owned submit pipeline | Completion/error, or app source disposal |
| Initial load, update, delete | Operation subscription in the app's operations scope | Completion/error, or app disposal; incidental row rebuild does not cancel an accepted write |
| HTTP transport | Existing client per operation subscription | Unsubscribe delegates to adapter teardown; fetch-before-headers abort is verified |
| EventSource adapter | One connection per subscription; explicitly subscribe through a scope | Scope unsubscribe closes it once and suppresses late delivery; not yet connected to the Todo app |
| Scheduled RxJS work | Subscription held by its app/component scope | Unsubscribe cancels timer/queued operator work; timer and debounce tests verify this |
| State binding | Mounted app; connected before startup effects and inputs | Released after input, child and operation scopes; last owner resets legacy replay |
| Todo row | Child component scope under the current rendered list scope | Rebuild, explicit row disposal or parent disposal removes listeners and row DOM |

Removing a DOM node alone does not dispose its scope. The host must call the
provided disposal operation; no MutationObserver or component framework is added.
Disposal does not reverse a mutation already accepted by the remote server.

## Acceptance assessment

| M01 criterion | Executed evidence | Result |
|---|---|---|
| Create without start performs no external work | `main.test.ts` spies on DOM lookup/creation, requests and EventSource, and checks no state subscriber; `app.test.ts` checks inert creation | Pass |
| One start attaches one owned set | App test calls start twice; one submit registration and one load; synchronous load renders | Pass |
| Dispose twice is safe | App, scope and row tests verify one cleanup and a disconnected state owner | Pass |
| Mount/unmount/remount leaves one active listener set | Old retained rows are inert; a new mount has fresh legacy state and exactly one create; hot-disposal/remount test also cancels old work | Pass |
| Removing a child does not stop siblings | Direct scope and TodoItem tests dispose one child and exercise its sibling | Pass |
| No event/result updates a disposed app | Tests cover load/create/update/delete late results, retained DOM events, teardown-generated input, scheduled work and EventSource close | Pass |

Additional checks cover synchronous ownership/disposal, capture before debounce,
empty submits, preserved submit exhaustion, recoverable create failures, no writes
caused by rendering, and update ownership across incidental row rebuilds.

## Commands and results

All verification commands used Node 22.22.1. In this workspace its binary directory
was prepended to PATH by the execution recorder; a normal checkout can use `.nvmrc`.

| Command | Result |
|---|---|
| `npm ci` at the starting lockfile | Exit 0; 114 packages installed |
| `npm run typecheck` before edits | Exit 0 |
| `npm test -- $(git ls-files '*test.ts' '*test.tsx')` before implementation | Exit 0; original **180 tests / 19 files** pass |
| `npx vitest run src/client/main.test.ts` against the old eager entry | Expected exit 1; **1 failed**: import invoked the load service |
| `npm test -- src/client/runtime/scope.test.ts src/client/runtime/sources.test.ts` tests first, then implementation | Expected missing-module failure, then **17 tests / 2 files** pass; final suite also includes these tests |
| `npm test -- src/client/components/todo-item.test.ts` before row implementation | Expected exit 1; **5 failed / 6 passed** for typed capture and ownership |
| Same row command after implementation | Exit 0; **11 tests** pass |
| `npx vitest run src/client/main.test.ts src/client/app.test.ts` | Exit 0; **19 tests / 2 files** pass |
| `npm run typecheck` after implementation | Exit 0 |
| `npm test` after implementation | Exit 0; **219 tests / 23 files** pass |
| `npx vite build` | Exit 0; browser HTML and 29.24 kB JS bundle generated |
| `git diff --check` | Exit 0 |
| `git diff --quiet HEAD -- src/server src/shared package.json package-lock.json` before the implementation commit | Exit 0; these areas unchanged |

Repository inspection used `git status --short --branch`, `git fetch origin main`,
`git log`, `git rev-parse`, `git show`, `git diff`, `rg` and source/document reads.
Work started with `git switch -c m01/owned-lifetimes`. Read-only GitHub requests
confirmed current main and open PRs; unrelated dependency PR #3 was left alone.
Publication uses destination-only GitHub tree/commit/branch operations; the remote
tree is checked against `git write-tree`. Fetch followed by an equality-guarded
`git reset --soft origin/m01/owned-lifetimes` synchronizes the local branch without
discarding work. The PR provides the final publication/CI identifiers.

## Limits and remaining work

No M01 execution blocker remains. The automated UI evidence runs in jsdom; the
hot host is simulated and Vite's boundary recognition was inspected. This is not
an interactive browser hot-reload demonstration or a browser-to-server end-to-end
test. The build is the current browser build, not a Worker build or deployment.

- The legacy module-global state remains shared by simultaneously mounted apps;
  this change supports one active Todo app with explicit disposal/remount. M02
  owns isolated instances, model extensions, replay ownership beyond the current
  binding, selectors and reentrant ordering. The synchronous-startup characterization
  is fixed as a consequence of correct M01 activation order; M02 is not complete.
- M03 still owns HTTP status/body validation, cancellation during body consumption,
  error outcomes and extracted concurrency policies. Update/delete still retain
  their inherited silent error behavior. Only cancellation before response headers
  and suppression of late client results are established here.
- Full-list rebuilding remains; M04 owns keyed rows, targeted bindings and focus
  preservation. EventSource retry/schema/live-app integration remains M06.
- M00's intentionally failing characterization branch remains separate and unchanged.
  Its missing-root/disposal and detached-listener observations now have passing
  replacement regressions; no intentionally failing baseline was merged.
- No server, dependency, Cloudflare, account, DNS, credential, release or deployment
  change was made. M05a is the next milestone after M01 acceptance and authorization.
- Existing Vite esbuild/oxc warnings and workspace npm/proxy warnings were observed;
  they did not fail these checks. Toolchain compatibility work remains in M05a.
- Updating the ChatGPT Project's reference copy of the accepted r2 plan remains
  separately unverified; this Git change does not claim that synchronization.
