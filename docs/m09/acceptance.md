# M09 — Completion review and documented delivery

Date: 2026-09-23. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.
Final local result: **1,018 tests passed** (847 Node/DOM + 171 workerd),
plus clean-checkout build/preview, public API/live/restart and a built native-browser
checkpoint. No deployment or package release is claimed.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m09/completion-delivery`.
- Starting commit: **`5362f0392b73c8cd7b8f8fb53e0857b257e55eb3`**, verified current
  `main` and merged [M08 PR #15](https://github.com/hansschenker/rxjs-flow/pull/15).
- Starting tree: **`b2efaf3d9888126ee3dd29ae230575b4e86cbdbe`**.
- Implementation commit: **`cafebda2cc52b4b47a4889af08e69499d75a59bd`**.
- Implementation tree: **`682099aababc56becab12160efe84233909c0cd6`**.
- [Execution ledger](execution.json): exact command arguments, UTC timestamps,
  exits, result lines, raw-log digests and intermediate failure dispositions.
- [Application and API](application-and-api.md), [delivery guide](delivery.md)
  and [prepared Project reference](project-reference/README.md).

The owner explicitly authorized M09 after the accepted M08 checkpoint. A new
checkout and clean dependency installation establish this milestone's baseline;
its suites passed **847 Node/DOM + 171 workerd tests, 1,018 total**.
The existing M08 ledger remains unchanged historical evidence. M08's earlier
CI and browser runs are not substituted for current M09 verification.

M09 consolidates the proven architecture and operational workflow, adds a built
public-path delivery checkpoint and reconciles package metadata. It preserves
RxJS 7, custom JSX, the existing domain/effect implementation and dependency
versions. It introduces no plugin system, package workspace, deployment pipeline,
new release version or production access policy.

## Canonical tasks

| M09 task | Delivered change / evidence | Result |
|---|---|---|
| 1. Document the application graph and temporal ownership | Application/API guide plus architecture contract: sources, activation, sharing, state, effects, rendering, request/response/authority ownership and live recovery. | Pass |
| 2. Document the proven function-based surface | Existing factories, owned handles, typed HTTP/live adapters and trace helpers; no speculative exports or npm entry. | Pass |
| 3. Verify clean Vite/Cloudflare workflow and public asset/API contract | Fresh install, typechecks, separate suites, build/preview; new delivery checkpoint uses built assets and actual `/api` CRUD/versioned SSE. | Pass — final fresh-checkout gates |
| 4. Document Cloudflare operations without enabling deployment | Project-local Wrangler, generated types, environment/secret/migration boundaries and gated delivery procedure; CI remains validation-only. | Pass |
| 5. State Node disposition | Retain tested local in-memory compatibility mode; Workers is primary; preserve lifecycle/HTTP/SSE tests and historical evidence. | Pass — decision and current tests |
| 6. Reconcile terminology and reference documents | README, package metadata, changelog, guidance and canonical status; original releases retained; exact-byte Project copy prepared with matching filename/revision. | Pass |
| 7. Review all evidence at one final commit | Implementation identity, fresh checkout and final review-head CI are recorded separately; limitations below remain explicit. | Local gates pass; exact review-head CI follows publication |
| 8. Preserve separate deployment authorization | No remote resources, account/domain changes, release tags, npm publication or public deployment. | Within scope |

## Acceptance criteria

| Canonical acceptance clause | Required evidence | Result |
|---|---|---|
| Fresh checkout builds and runs the complete local Cloudflare-oriented application | Clean checkout/install, environment-specific typechecks, suites, build and real local runtime checks. | Pass — recorded final fresh-checkout gates |
| Typecheck/test/build/preview-smoke evidence recorded | Execution ledger identifies commands, exact source, counts and exits; PR records exact review-head CI. | Pass — recorded final fresh-checkout gates |
| Durable authority and resnapshot semantics demonstrated | Public versioned snapshots match committed state, survive process restart and progress after reconnect; retained authority tests cover failure/uncertainty. | Pass — recorded final fresh-checkout gates |
| Runtime support explicit | Workers primary; Node retained/tested local compatibility with separate in-memory state. | Documented |
| Deployment status explicit | Local verification and artifact readiness do not establish a deployed service or `netxpert.ch` binding. | Documented |

## Verification

A separate detached checkout of implementation commit `cafebda2cc52b4b47a4889af08e69499d75a59bd`
started with no `node_modules`, `dist` or `.wrangler` directory. Its clean install
added 153 packages. The final suites passed **847 Node/DOM tests in 51 files and
171 workerd tests in 9 files: 1,018 total**. Counts are unchanged from M08 because
M09 adds an executable delivery gate, not duplicated unit tests.

| Gate | Current recorded result |
|---|---|
| Fresh checkout identity and `npm ci` | Pass (`fresh-checkout-identity`, `final-fresh-install`) |
| `npm run typecheck` | Pass — all configured projects (`final-typecheck`) |
| `npm test` | Pass — 847 tests / 51 files (`final-node-dom`) |
| `npm run test:worker` | Pass — 171 tests / 9 files (`final-workerd`) |
| `npm run cf:typecheck` | Pass (`final-generated-types`) |
| `npm run build:worker` | Pass — browser/Worker build (`final-build`) |
| Disabled-policy built preview | Pass — assets served; Todo access returns JSON 503 (`final-smoke-preview`) |
| Development Todo HTTP | Pass (`final-smoke-dev`) |
| Durable process restart | Pass (`final-durable-restart`) |
| Owned legacy streams, development/built | Pass (`final-legacy-dev`, `final-legacy-built`) |
| Built public asset/API/versioned resnapshot | Pass (`final-delivery`) |
| Wrangler local packaging dry run | Pass — no upload (`final-package-dry-run`) |
| Native built-browser checkpoint | Pass (`final-browser-built-restored`); initial host-tool failure retained |
| Documentation/provenance checks | Local links, paired fences, exact-byte reference copy and ledger reviewed; `provenance-check` passed |
| Exact review-head CI | Recorded separately in the PR after publication; historical CI is not substituted |

Node 22.22.1 and npm 11.9.0 are the local toolchain; the pinned lockfile resolves
RxJS 7.8.2. The implementation changes only package metadata, the delivery script,
its shared local checkpoint helper and validation CI. It leaves application
source, dependency versions, Worker access configuration and generated Worker
declarations unchanged. Documentation follows in a separate commit; exact
review-head CI checks the final combined tree.

The local Wrangler command packages the built configuration with `--dry-run`
and exits before upload. Its reported **300.65 KiB / 66.10 KiB gzip** describes
Worker packaging, not deployed transfer or speed. The configured Todo policy
remains disabled and no account resources or migrations were created.

The built delivery checkpoint fetches the actual root page and its emitted assets,
then exercises the public same-origin API. It verifies that the single `/api`
prefix is handled correctly, paths outside that boundary use the configured SPA
fallback, and unknown API paths,
invalid input and denied collection access yield API responses rather than the
HTML shell. It opens real versioned SSE readers, performs CRUD, reconstructs the
collection after a process restart, and verifies resnapshot identity and later
commits. Every local process and reader belongs to the checkpoint.

The final delivery run served **four manifest-linked JavaScript/CSS assets**
from the same origin, including the **65,227-byte** application script. Twelve
cross-site/foreign-origin/collection-selector requests were rejected with JSON
403 responses. Two independent HTTP live consumers observed the same committed
collection. The disconnected consumer stopped; reconnect included an intervening
commit. Restart recovered the same collection, generation, revision **6** and
Todos; subsequent deletions advanced the revision to **8**. Each consumer kept
at most one decoded snapshot; the observed frame high-water mark was **442 bytes**
against a 131,072-byte limit. All checkpoint read loops ended at zero. These are
local HTTP/process observations, not a simulated test of remote routing.

Retained checks cover finite HTTP, owned legacy streaming, SQLite atomicity,
mutation uncertainty, request cancellation and server lifecycle. Native-browser
checks are distinct from HTTP scripts: they observe actual controls, DOM/listener
ownership, live transport, cancellation, remount and runtime restart. Optional
browser tooling remains outside application dependencies and normal CI.

### Native browser and host-tool correction

The current built-browser run used Playwright 1.62.1 and Chromium 153.0.8010.0
against the same fresh implementation checkout. Equivalent traced and untraced
scenarios each issued **13 API requests** in two independent browser contexts.
Steady state had one live connection per mounted app, two total. The trace run
captured **455 records**, released **160 native listeners** across explicit
disposals, and ended with **zero current-document API requests and zero uncaught
browser errors**. Additional public state/view consumers repeated no effects.
A committed write survived cancellation of its local reply owner; remount
recovered it. Full server restart recovered live state **without navigation**.
No retired-document request IDs were left without terminal observations.

The first optional browser attempt failed before a page started because a cached
extracted Chromium executable was truncated (191,553,536 bytes). Restoring the
same 153.0.8010.0 executable from the existing archive produced 209,022,176 bytes;
its version check and the complete browser checkpoint then passed. No application,
dependency or test assertion was changed to repair that host tool. The failed
`final-browser-built` record remains in the ledger with its successful
`final-browser-built-restored` disposition. This milestone records a new built
browser run; M08's development-browser runs remain historical evidence.

The native result supplements the HTTP checkpoint: resource counts come from
actual listeners, requests and readers, not merely trace finalization records.
Screenshot inspection and the unchanged application script identify the same
reference layout; M09 adds documentation and delivery verification rather than
new page controls.

## Runtime and delivery decision

Hono/Workers is the primary reference application and build. Local development
persists the configured collection in attached SQLite beneath `.wrangler/state`;
automated checkpoints use isolated temporary persistence. Node HTTP is retained
as a supported **local compatibility mode**, with independent in-memory state and
current lifecycle/HTTP/SSE tests. Restarting Node resets that collection. This
milestone does not maintain a second production infrastructure.

The application keeps package version `1.0.0`, declares npm publication private
and removes the nonexistent `index.js` library entry. These are application
metadata corrections; existing release entries and attribution remain unchanged.
A successful build yields local executable assets; it does not establish a
published package or deployed service.

The checked-in Worker leaves Todo access disabled outside explicit local
development/test configuration. The delivery guide describes the operations
that a separately authorized deployment must review. No credentials, remote
resources, remote migration execution, domain binding, production route, release tag
or publication is part of this milestone. CI validates without a deploy step.

## Limitations and remaining decisions

- The local tests use workerd, attached SQLite and real local HTTP/SSE. They do
  not force remote Cloudflare routing or verify a deployed service.
- The configured development collection and denied default are not a production
  identity/authorization product. Public or multi-user delivery needs a reviewed
  access policy, tenant mapping, secret handling and abuse/capacity controls.
- Minimal attached persistence is not an export, backup, restore, disaster
  recovery, retention or schema-upgrade strategy. Those must be tested before
  production use; the declaration of a Durable Object migration is not proof
  of its execution on an account.
- Reconnect returns the current committed snapshot, not a complete event history.
  There is no automatic replay of a mutation whose outcome is uncertain.
- Retry delays are bounded (1, 2, 4 and 8 seconds) and the first snapshot has a
  10-second deadline. There is no heartbeat or bounded detection of an idle
  partition after that snapshot; manual recovery is explicit after exhaustion.
- Application queues and snapshot/byte limits exclude platform/socket/browser
  internal buffers. Local resource measurements do not prove production capacity.
- Traces are opt-in bounded diagnostic metadata. Runtime-local sequences and
  sampled clocks do not form a global timeline; cancellation records do not
  prove remote rollback. Direct resource checks supplement lifecycle traces.
- A prepared matching roadmap copy does not update the ChatGPT Project. Upload
  remains a separate, unverified action; canonical repository links preserve
  the correct relative-link context.

No implementation or local-verification blocker remains. The one intermediate
browser-tool failure is resolved and preserved in the execution ledger. All
final local gates refer to the recorded implementation commit; documentation
follows in a separate commit. The PR records that final review head and its CI
before merge. Acceptance review/merge remains pending; public delivery and
Project upload remain separate actions.
