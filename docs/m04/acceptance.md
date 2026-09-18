# M04 — Owned, targeted DOM rendering

Date: 2026-09-17. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: accepted and merged in [PR #9](https://github.com/hansschenker/rxjs-flow/pull/9)
at `2b316a477600c91b3105c9e390949c29e90046d3` on 2026-09-17. Final-head
[CI run 35203513000](https://github.com/hansschenker/rxjs-flow/actions/runs/35203513000)
passed. The owner subsequently confirmed the local page works and looks good.
The assistant's automated real-browser run remained blocked as recorded below;
the owner's manual review does not replace the recorded DOM-test evidence.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m04/owned-dom`.
- Starting commit: `c64fda113b599ff9b0b21ae3e20aeff0c473a358`, verified merge of
  PR #8. M00, M01, M05a, M02 and M03 remain accepted. Original history is preserved.
- Implementation commit: `2446d33aee49025ed72eb33afd0f0da1435b62c5`.
- Implementation tree: `577b19b2443f10b5e896520c69f0dfea90b6e607`.
- [Execution records](execution.json) preserve commands, UTC timestamps, exit codes,
  selected output, the corrected review finding and the browser limitation. The
  following commit changes documentation only; final PR-head CI is recorded in
  the PR.

The owner explicitly authorized M04 and requested a minimal code sample when it
was finished. [Run the minimal Todo page and read its binding sample](minimal-sample.md).
The canonical order remains M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d →
M06 → M07 → M08 → M09. No M05b or later implementation is included.

This checkpoint changes client rendering, the page shell/style, one derived
pending-ID field, and DOM tests. The custom JSX construction function is retained.
The M03 HTTP adapter, effect policies, intents, reducer and runtime ownership core
are unchanged, as are shared contracts, Node/Worker handlers, package/lock files
and CI. No deployment, account, domain, secret or remote runtime resource changed.

## Implemented contract

`todo.view.tsx` locates the stable HTML shell once and connects DOM sinks to the
model. `main.tsx` owns the model, view, effects and external input sources; it no
longer reconstructs the list. The model's state accumulation is still shared and
owned by the app. Pure view selectors execute per consumer; this is not a claim
that every projection executes once. Additional view consumers cannot execute
another state accumulator or HTTP request.

Named view functions turn coherent model values into title text, summary text,
attributes, checked state and visibility. `map` projects those values; the owned
binding subscribes and commits them. Rendering is synchronous. No scheduler,
animation frame, global delay, dependency tracker, virtual-DOM engine or second
UI framework was added. Each sink compares the incoming value with actual DOM
state before writing. Comparing the DOM rather than only the previous emission
also repairs a native property changed independently by the user.

| Binding | Ownership and outcome |
|---|---|
| `bindText` | Writes differing `textContent`; retains existing child text nodes when content already matches |
| `bindProperty` | Typed property assignment only when the actual value differs; matching input value preserves selection |
| `bindAttribute` | Writes one differing attribute; `null` removes it |
| `bindClass` | Toggles one class without replacing unrelated classes |
| `bindIf` | Owns one child scope while visible; repeated true retains it; false disposes it and removes owned nodes, including fragments |
| `bindKeyedList` | Owns the list container and one child scope per key; updates retained rows, moves existing nodes, and disposes deleted rows |

Scalar source completion leaves the last committed DOM value. Conditional and
keyed bindings return explicit view-lifetime subscriptions: source completion
retains the current content until that lifetime or its parent is disposed.
Source/commit errors clean composite views and reach the supplied reporter.
Scalar commit errors reach their reporter through `tap`; the app's reporter closes
the entire app graph. Owners register subscriptions before synchronous sources
activate. A closed owner performs no late source activation or insertion.

Keyed reconciliation validates the whole key set before changing existing rows.
Duplicate keys or shared elements are render failures. A row factory and its
update function must leave the supplied child scope open; an independently closed
row cannot be updated/reinserted. Parent disposal is ordinary cancellation. A
directly closed child encountered during rendering produces a reported render
failure and full list cleanup. Reentrant collection emissions queue until the
current synchronous commit finishes, using `concatMap` around the finite commit.
There is no asynchronous render queue or coalescing policy.

Existing keys keep both their DOM node and their child scope. Already-positioned
nodes are not moved. Connected row movement uses native `moveBefore` when available;
the fallback preserves a moved control's focus and text selection, including a
list inside a ShadowRoot, without taking focus back from a deliberately focused
external control. These paths have DOM tests; native-browser behavior was not
executed here.

The derived `pendingTodoIds` field identifies accepted updates/deletes without
changing state or execution policies. A row keeps the user's native checkbox
choice while its writes are pending, then reconciles checked state with confirmed
model data when they settle. Failure restores the same checkbox node. The row's
`aria-busy` changes independently of its identity. A pending create keeps M03's
disabled `Adding…` submission display and newer-draft preservation.

## Visible checkpoint

The existing page now has a small stable shell with a labelled task input, Add,
Refresh, counts, Todo rows, loading/empty content, pending status and recoverable
errors. Row controls use native inputs/buttons and accessible labels. The stylesheet
adds a compact responsive layout without animations or external assets.

The sample's summary binding is small: a named `remainingText(view)` function,
`viewModel$.pipe(map(remainingText))`, and one `bindText(scope, summary, …, onError)`
call. The scope owns activation and cancellation; the model owns memory; the
function supplies wording. The [sample guide](minimal-sample.md) links the actual
source, gives the two existing startup commands and explains what to observe.

Real local HTTP checks started the existing Node server and Vite page, fetched
the HTML/client entry/view/CSS, then executed GET **200**, POST **201**, PUT **200**,
GET **200**, DELETE **204**, and a final GET confirming the original seed remained.
Both servers were stopped after the check. This proves served assets and the
current development proxy/CRUD path, not browser rendering or live synchronization.

## Acceptance criteria

| M04 criterion | Executed evidence | Result |
|---|---|---|
| Unrelated error/pending changes do not rebuild the Todo list | Create pending/failure and draft tests assert unchanged row nodes, no list replacement/moves, and no unrelated DOM mutations | Pass (DOM) |
| Unchanged rows retain identity | Refresh, insert/delete, equivalent snapshots and reorder assertions preserve exact element references | Pass (DOM) |
| Update touches the intended row | Target row updates in place; sibling MutationObserver records and property setter calls remain empty | Pass (DOM) |
| Delete tears down its scope | Deleted-row listeners release exactly once; detached events are inert and the retained sibling remains interactive | Pass (DOM) |
| Focus and draft survive server updates | Controlled service refreshes preserve focused controls, unsent draft and backward selection; reorder fallback also covered in a ShadowRoot | Pass (DOM) |
| Removing the view releases all bindings | Scalar/composite unsubscribe, conditional child removal, app disposal, late source values and independently closed-row regressions | Pass (DOM) |
| Rendering never invokes an effect | Initial render, equivalent refresh and extra public consumers leave create/update/delete counts unchanged | Pass (DOM) |

Final totals: **513 tests / 33 Node/DOM files + 16 tests / 1 workerd file = 529 tests**.
The 62 additional cases include 24 scalar/conditional binding tests, 26 keyed-list
tests, 10 integrated DOM cases and two selector cases. Existing M01–M03 tests remain.
Two earlier app assertions that expected sibling/checkbox replacement now assert
retention and deletion cleanup; the render-fault test throws at `insertBefore`
instead of the removed full-list replacement path. Their original lifetime/effect
guarantees are retained. The separate M00 characterization branch is untouched.

## Commands and results

Local Node **22.22.1**, npm **11.9.0**, RxJS **7.8.2**, TypeScript **6.0.3**,
Vite **8.0.12**, Vitest **4.1.6**. Dependency versions are unchanged.

| Command/check | Result |
|---|---|
| Baseline `npm test` | Pass: 451 Node/DOM tests / 30 files at PR #8 merge |
| Focused binding/keyed/app runs | Pass; final full suite includes all fixes |
| Independent review probes | Found row self-disposal could resurrect orphan DOM; fixed in three permanent regression cases and independently rechecked |
| `npm ci` | Pass: clean lockfile install, 153 packages |
| `npm run typecheck` | Pass: generated types and all five TypeScript projects |
| `npm test` | Pass: 513 Node/DOM tests / 33 files |
| `npm run test:worker` | Pass: 16 workerd tests |
| `npm run cf:typecheck` | Pass: generated types current |
| `npm run build:worker` | Pass: client 102.70 kB JS + 2.58 kB CSS; Worker 103.38 kB JS |
| `npm run smoke:worker` | Pass: built preview serves assets, foundation API and expected routing precedence |
| Temporary Node/Vite HTTP page probe | Pass: actual served page/modules/CSS and CRUD through the development proxy |
| Chromium installation / browser probe | Blocked: executable absent; environment-only download hit a 60-second timeout; no browser assertions or screenshots executed |
| `git diff --check` and unchanged-boundary comparison | Pass |

GitHub reads verified PR #8 merged and `main` still at the starting commit before
publication. Git fetch/switch/fast-forward established the dedicated branch.
Repository/source/log reads used Git, `rg`, `sed`, `cat` and Python. The staged
implementation tree was compared with `git write-tree` before destination-only
GitHub tree/commit/branch publication. Fetch and a tree-equality-guarded soft reset
synchronize the local branch without discarding edits. Final head, preview merge
and CI are recorded in the PR; no automatic merge is performed.

## Blockers and limits

No implementation defect remains from M04 review; all required local test/build
gates pass. **Real-browser visual verification remains unavailable here.** The
installed Playwright package had no Chromium executable; a bounded download timed
out. The prepared browser probe stopped before starting its browser checks. DOM
focus/selection evidence is from Linux/jsdom, and real transport evidence is from
HTTP/workerd. No screenshot, desktop/mobile browser pass or Windows execution is
claimed. Open the runnable page to review its appearance and native interactions.

The Todo backend still uses Node HTTP and in-memory storage. Worker `/api/todos`
still deliberately returns 404 until M05b. Persistence/authority, owned server SSE
and application live recovery remain M05c/M05d/M06. A normal user's click may move
focus; preserving focus during a DOM update does not suppress native navigation.
Reactive bindings require explicit owner disposal; there is no automatic observer
that detects arbitrary external DOM removal. The stable host shell remains after
app disposal, while owned rows/content/listeners/subscriptions are released.
This is a runnable local reference checkpoint, not a deployment or release.
