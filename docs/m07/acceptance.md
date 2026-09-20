# M07 — Complete reference Todo application

Date: 2026-09-20. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.
Final test total: **968 passed** (803 Node/DOM + 165 workerd),
**37 more** than the pristine 931-test baseline.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m07/reference-app`.
- Starting commit: **`36d644f529d5660506d6f2aa90e90af562d01440`**, verified
  `main` and merged [M06 PR #13](https://github.com/hansschenker/rxjs-flow/pull/13).
- Starting tree: **`2a4f0493dd0238c9430a7c34728daed34d676317`**.
- Implementation commit: **`23a8a1814309023c1e0c3112e462e9ad1105f003`**.
- Implementation tree: **`47f7ebd9fbbcefc62e00fa06f963bc4959a81b7e`**.
- [Execution record](execution.json): exact captured commands, UTC timestamps,
  exit codes, test totals, log digests and intermediate failure dispositions.
- [Runnable checkpoint](local-development.md): the existing Todo application,
  including forms, filters, live updates, operation feedback and recovery.

The owner confirmed M06's two-page synchronization and explicitly authorized
M07. Both pristine suites passed before implementation edits: **766 Node/DOM
tests in 46 files and 165 workerd tests in 8 files, 931 total**. The current
destination/history was verified before creating the dedicated branch.

This milestone completes the reference application using its existing RxJS 7
model, effects, custom JSX renderer, Hono HTTP and durable snapshot protocol.
M08 tracing and M09 delivery review remain separate. No dependency upgrade,
package release, merge, deployment, remote resource, account or domain change
is authorized by this work. The M06 command ledger remains historical evidence.

## Canonical tasks

| M07 task | Implementation and required evidence | Result |
|---|---|---|
| 1. Reduce `main.tsx` to application construction, mount and disposal | The entry delegates to the Todo program; existing exports, startup ordering and owned disposal remain compatible. Program and DOM integration tests verify construction is inert and only mount starts work. | Pass |
| 2. Complete CRUD, filtering and status/feedback | Initial complete snapshots load the live collection. Create/toggle/delete use finite effects, while accepted snapshots update the collection. All/Active/Completed filters are local derived state; loading, empty/no-match, operation errors and connection recovery remain visible. | Pass |
| 3. Keep form draft, validation and pending state in the model | A captured draft includes its value and revision. A create acknowledgement clears only that accepted draft, preserving newer typing even when text changes away and back to the same value. Pure state/effect and actual browser tests cover the delay. | Pass |
| 4. Keep pure client validation and authoritative server validation | Required trimmed-title validation lives in a pure function. Native labelled controls expose validation, busy/disabled state and recoverable feedback. Real Hono validation rejects an intentionally invalid mutation without changing the collection. | Pass |
| 5. Demonstrate two browsers, failure, reconstruction and remount | Two independent native browser contexts exercise live writes, interruption, a failed mutation, persisted runtime reconstruction and explicit unmount/remount. Cleanup evidence covers disposed resources and continuing sibling ownership. Node reset-on-restart remains separately labelled. | Pass |
| 6. Verify development and built asset/API arrangements | The same browser scenario runs through Vite/Cloudflare development and built assets with a local Wrangler Worker. It does not use the retained Node development proxy. | Pass |

## Acceptance criteria

| Canonical acceptance clause | Evidence | Result |
|---|---|---|
| Real browser: DOM intent → effect → Hono HTTP → committed authority snapshot → reducer → targeted DOM update | `scripts/m07-browser-checkpoint.mjs` runs the mounted application with native HTTP/EventSource; actual mutation responses and live payloads establish the external boundaries. DOM identity/status assertions verify resulting rendering. | Pass |
| Another client sees the same state | Independent browser contexts converge after each accepted mutation in both runtime modes; filters change only their local projections. | Pass |
| Failures remain recoverable | A true server validation failure returns through operation state without corrupting the saved collection; a corrected intent succeeds. Transport interruption retains last confirmed data and reconnects under M06's bounded policy. | Pass |
| Teardown releases owned resources | Program/DOM tests and browser unmount/remount verify disposed inputs cause no requests, old live work ends, no retry opens later, and remount owns one new connection. | Pass |
| Form/focus tests pass during updates | Captured-draft revision, continued typing, validation, pending state, keyed row identity, input focus and selection are verified under HTTP/live updates. | Pass |
| Local evidence is not a deployed-service claim | Both targets use local workerd and isolated persistence. Checked-in deployable Todo access remains disabled. No Cloudflare account, routing, production access or `netxpert.ch` deployment is asserted. | Documented |

## Dataflow and ownership

An app describes its model, derived streams, view and external operations before
mount. Mount attaches the owned consumers and starts the model before accepting
DOM input or synchronous external feedback. One effect subscription owns finite
operations, and one live subscription owns the app's connection and retries.
Additional state/view consumers observe remembered state without starting work.
Disposal releases sources, view/row scopes, effects and model; remount constructs
a fresh app instance.

The server snapshot remains the authoritative Todo collection. HTTP success
settles the corresponding pending operation and accepted form draft; it does
not independently append, update or delete a second copy of an item. Filters
derive a visible subset from the remembered collection without issuing a new
request or changing saved Todo data. Each app retains its own filter and draft.

The create policy continues to ignore another submit while an accepted create
is busy; accepted mutations use the existing bounded FIFO queue. The input stays
editable while a create is pending. Disabling Add communicates admission state;
it does not freeze draft editing. Row controls retain their existing queue,
busy-state and focus behavior.

## Form consistency and recovery

The submitted draft carries both text and a revision. Text equality alone is
insufficient: a user can submit `Task A`, type `Task B`, then return to `Task A`
before the first reply arrives. That final text is a newer draft and must remain.
The reducer clears only the matching accepted draft revision on success. Failure
retains the draft and returns pending state to an actionable state.

`draftRevision` advances on actual text changes; `draftTouched` controls visible
validation, and `failedOperation` selects the appropriate recovery guidance.
Only a submit matching the coherent model draft captures `submittedDraft`.
An absent capture never authorizes clearing a later draft. Whitespace edits and
changed-away-and-back text are separate input histories even when the trimmed
submitted title is identical.

Client validation trims the required title; it does not invent an unrelated
maximum length. Blur/submission can expose the validation message. Server-side
validation remains authoritative, including malformed external inputs and the
existing authority/transport capacities. Operation feedback explains recovery
without automatically replaying a failed or uncertain write.

The title hint changes from **Give your task a name.** to **Enter a task title.**
when validation is exposed. Add becomes **Adding…** while its create is pending;
the input remains enabled. A filter with no matches says **No active/completed
tasks. Choose All to see the full list.** while full-collection counts remain
visible. Native filter radios are isolated by each app's form. **Dismiss message**
clears operation feedback without replaying the operation or changing Todos.

Known rejection and `not-committed` failures explain that the change was not
saved/rejected. An uncertain outcome instead asks the user to Reconnect and
review the collection before deliberately repeating it. Finite compatibility
mode uses Refresh in that guidance.

A disconnected mutation may have committed before its reply was lost.
Cancellation releases local ownership and is not rollback. Reconnect restores
current state from a full snapshot; it does not establish an exactly-once event
history or make automatic mutation replay safe. M06's logical generation,
revision, connection identity and malformed-snapshot policies remain unchanged.

## Verification

Focused tests are not added to full-suite totals. The final suites passed
803 Node/DOM tests in 47 files and 165 workerd tests in 8 files. These 968 tests
are current implementation evidence, separate from the clean 931-test baseline.

| Gate | Result |
|---|---|
| Pristine `npm test` | Pass — 766 tests / 46 files (`baseline-node-dom`) |
| Pristine `npm run test:worker` | Pass — 165 tests / 8 files (`baseline-workerd`) |
| Final `npm test` | Pass — 803 tests / 47 files (`final-node-dom-2`) |
| Final `npm run test:worker` | Pass — 165 tests / 8 files (`final-workerd`) |
| `npm run typecheck` | Pass — all configured TypeScript projects (`final-typecheck`) |
| `npm run cf:typecheck` | Pass — generated Worker declarations match configuration (`final-generated-types`) |
| `npm run build:worker` | Pass — browser/Worker output and retained browser entry exports (`final-build`) |
| Built preview/API precedence smoke | Pass — `npm run smoke:worker` (`final-smoke-preview`) |
| Development Todo API smoke | Pass — `npm run smoke:worker -- --dev` (`final-smoke-dev`) |
| Browser checkpoint — development | Pass — `node scripts/m07-browser-checkpoint.mjs --dev` (`browser-dev-final`) |
| Browser checkpoint — built local Worker | Pass — `node scripts/m07-browser-checkpoint.mjs` (`browser-built-final`) |
| Durable process restart | Pass — `node scripts/m05c-checkpoint.mjs --preview` (`final-durable-restart`) |
| Legacy live checkpoint — development and built | Pass — `node scripts/m05d-checkpoint.mjs` with/without `--preview` (`final-legacy-live-dev`, `final-legacy-live-built`) |
| Dependencies / Worker configuration | Pass — pinned dependencies and Worker policy/configuration remain unchanged (`final-unchanged-dependencies`) |
| Git diff and documentation review | Pass — whitespace/diff review and all local links in 11 affected documents |
| Review-head GitHub CI | Recorded in the PR after exact-head verification, separately from these local gates |

### Browser evidence

The final runs `browser-dev-final` and `browser-built-final` both passed with
Playwright **1.62.1** and Chromium **153.0.8010.0**. Two independent browser
contexts mounted the actual application and used native HTTP/EventSource.
Each run issued **13 DOM mutation requests**: **12 committed operations** and
one genuine Hono **422** rejection. Browser observers received 11 successful
HTTP replies plus that 422; the last committed reply was intentionally held and
then canceled locally during unmount. The committed item remained after remount,
proving cancellation was not rollback. Both pages ended with eight unique Todos.

The scenarios verified initial loading/known empty state, local filters and
no-match feedback, pure invalid-draft rejection without a request, corrected
submission after real server rejection, targeted row identity, focus/selection,
continued typing and changed-away-and-back draft preservation. They also
verified offline replacement recovery, spontaneous active-stream interruption
on full server stop, retained durable history after restart, extra state/view
consumers without repeated effects and explicit disposal/remount.

| Native browser observation | Development | Built local Worker |
|---|---|---|
| Mutation requests / committed operations / true 422 | 13 / 12 / 1 | 13 / 12 / 1 |
| Successful browser replies / failed replies / canceled committed reply | 11 / 1 / 1 | 11 / 1 / 1 |
| Finite list reads / duplicate rows | 0 / 0 | 0 / 0 |
| Stream requests A / B | 9 / 4 | 8 / 3 |
| Observed snapshots A / B | 15 / 14 | 15 / 14 |
| Document navigations A / B, including initial load | 2 / 2 | 1 / 1 |
| Native DOM listeners removed across four explicit disposals | 36 | 36 |
| Final current-document owned requests | 0 | 0 |
| Replaced-document request IDs without terminal CDP event | One per page, retained in evidence | None |
| Uncaught browser application errors | 0 | 0 |
| Final pages / browser contexts | Closed / closed | Closed / closed |

These request/snapshot counts describe the recorded runs; they are not protocol
limits or a promise about every network schedule. DevTools directly inspected
native listeners before/after disposal. The same DOM controls caused no requests
after disposal, pending finite/live work ended, a disposed retry opened nothing
later, and remount owned one new connection reading current state.

Vite HMR reloaded both documents during development server restart. CDP did not
send a terminal request event for one old-document SSE ID per page. The record
retains those IDs with their loader identities and the disposition **document
replaced; no terminal CDP request event observed**. They are not silently counted
as proven closed or as requests owned by the new document. Built mode restarted
without navigation, had no retired IDs and ended with the entire request census
at zero. Both modes finally closed their pages and browser contexts.

The two final screenshots are byte-identical and were visually inspected for
readable validation/status/filter controls and unclipped layout. Their SHA-256
is `e1744676a40c2f9d88c3bb306b4b2bed98962706e809ae5f5e94e1e95f4979b1`.
Screenshots remain optional checkpoint evidence rather than application assets.

The browser build now preserves the executable entry exports and emits a
manifest. The browser checkpoint uses that manifest to import the cached public
entry for disposal/remount. The smoke helper selects the actual
`/assets/browser-*.js` chunk from the generated HTML. These client artifact
changes leave dependencies, Worker access
policy, bindings and durable protocol unchanged.

The browser harness may hold a real accepted HTTP reply to make a draft race
deterministic; the server commit and SSE delivery still occur normally. A failed
mutation probe can forward deliberately invalid input to the real Hono route;
it does not fabricate an HTTP outcome or replace EventSource/state. A single
reconnect request is deliberately aborted to establish a pending retry before
explicit disposal; complete offline and server-stop scenarios are separate.
These controlled conditions are labelled separately in the execution record.

## Limits and blockers

The inherited reconnect policy waits 1, 2, 4 and 8 seconds, with a 10-second
first-snapshot deadline for each attempt. Valid snapshots reset consecutive
failure count; protocol failures and retry exhaustion require manual Reconnect.
There is no heartbeat or fixed detection time for a silent partition after the
first snapshot. Chromium offline emulation does not necessarily close existing
EventSource sockets; a new offline attempt and actual process shutdown establish
different conditions and must be reported separately.

The durable target persists locally beneath `.wrangler/state`; browser automation
uses a private temporary database. The retained Node server stores its independent
collection in memory; reconstruction/reset establishes a new generation at
revision 0 and loses prior Todos. Node shutdown/port-release coverage remains.

Local dependencies reuse the pinned toolchain unless the command ledger records
a fresh install. Optional browser tooling stays outside repository dependencies.
Expected intentional cancellation/failure diagnostics remain visible and are
separate from application/browser errors. A Git commit does not update the
ChatGPT Project reference copy automatically.

The expected pre-implementation form regressions exposed text-only draft
clearing; the captured revision fixes that race. Intermediate type/DOM harness
issues were corrected without removing behavioral assertions. A native radio
group regression required one filter form per app. An initial build preserved
no browser exports until the entry was made explicit; the manifest now identifies
the cached executable module. Browser harness corrections waited for a real
retry interval before disposal and attributed CDP requests to their actual
document loader after development HMR. Exact labels, failures and resolutions
are retained in the ledger.

No implementation blocker remains. All final local gates passed. The tested
implementation is published at the commit/tree above. The following documentation
commit and PR record review-head CI without a self-referential commit claim.
Acceptance review/merge remains pending; M08 and M09 remain separate milestones.
