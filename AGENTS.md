# RxJS-Flow working agreement

Read these files before implementation:

- `docs/roadmap-gpt-6-astra-2026-09-15.md` (revision `rxjs-flow migration r1`)
- `docs/dataflow-architecture.md`
- `docs/repository-audit-2026-09-15.md`
- `docs/baseline-rxjs-flow-m00.md`

The development repository is `hansschenker/rxjs-flow`. Preserve the original
history and attribution. Do not modify `rxjs-stack` or `rxjs-fullstack`.

Recovery PR #1 is merged at `27f8f2cbcc7ba68ff6bc1062ebf25cc46f363769`;
both original histories are verified in main ancestry. M00 execution evidence
is recorded on `m00/baseline-evidence`; the user approved closeout PR #2 for
merge. Verify its merged state when resuming. Do not advance automatically to M01.

Use a dedicated branch and pull request. No merge, release, package publication
or deployment without explicit authorization. Preserve the imported ancestry.
The separate `m00/characterize-baseline` branch contains deliberately failing
probes; do not merge it into main. The baseline report maps each fix to its
milestone and records remaining development dependency findings.

Preserve RxJS 7, TypeScript, custom JSX and Node HTTP. Prefer named pure domain
functions and function-based factories. Events, state, derived values, rendering
and effects should have explicit Observable dataflow. Effect results return to
state; rendering must not initiate network writes. Make time, cancellation,
sharing, startup and disposal explicit.

Record exact commits, commands, versions, test counts and limitations. A prior
CI success or historical audit is not current acceptance evidence. Use Node
22.22.1 for the recovery checks and the documented Node 22 baseline.
