# M08 — Reading time, causality and cleanup

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: accepted and merged in [PR #15](https://github.com/hansschenker/rxjs-flow/pull/15)
at `5362f0392b73c8cd7b8f8fb53e0857b257e55eb3`. Status closeout recorded 2026-09-23;
the captured records and their digests below remain the M08 evidence.

These are selected **actual records**, not illustrative output. The
[recorded JSON](trace-records.json) preserves their runtime identities, sequence,
clock values, scopes and metadata, together with source command/file digests.
The [acceptance report](acceptance.md) gives the test and resource evidence.

## A complete operation through the local integration

The `server-trace-artifact-final` command runs production client/model/effect, Hono and
functional authority code **inside one local `runInDurableObject` fixture**, using
actual attached SQLite storage and real `Request`/`Response` bodies. Its `client`,
`worker`, `authority-first` and `authority-replacement` labels identify separately
constructed trace contexts with deliberately fixed clocks. They are **not proof
of separate browser, Worker and Durable Object isolates**. A trusted in-process
transport context carries operation correlation; no public trace header or RPC
field is added. Native-browser evidence follows separately below.

The accepted create has operation ID `client:app:1`. Its committed history is
`local-trace / persisted-generation / revision 1`.

| Trace context | Local sequence | Clock value | Recorded boundary | Meaning |
|---|---:|---:|---|---|
| client | 8 | 100 | `source.received` / `CREATE_REQUESTED` | The model receives the create input. |
| client | 10 | 100 | `intent.accepted` | The create is admitted under its existing policy. |
| client | 15 | 100 | `effect.subscribe` | The owner starts that one finite operation. |
| worker | 12 | 20 | `source.received` / `POST` | Hono's request boundary receives the correlated operation. |
| authority-first | 10 | 7 | `authority.start` | The admitted authority operation begins. |
| authority-first | 12 | 7 | `authority.commit`, revision 1 | Persistence has settled before committed state is advertised. |
| authority-first | 13 | 7 | `authority.publish`, revision 1 | The committed snapshot enters owned live delivery. |
| client | 19 | 100 | `state.transition` / `LIVE_SNAPSHOT` | The collection now contains one Todo; its operation is still pending. |
| client | 20 | 100 | `effect.next` | The finite reply arrives. |
| client | 23 | 100 | `state.transition` / `CREATE_SUCCEEDED` | The pending operation settles; collection count remains one. |
| client | 24 | 100 | `effect.complete` | The one-result application operation completes. |

The table follows the established causal boundaries, **not a sort by timestamps**.
Clock 7 does not mean the authority ran before the client's clock 100. Even all
client records have the same time here; their local sequence still distinguishes
receipt, acceptance, execution and result. Mutation replies settle pending state;
the live snapshot supplies the collection, so the Todo is not appended twice.

## Cancellation after commit is not rollback

The same fixture holds the second real HTTP reply after commit. Operation
`client:app:2` is canceled locally while the collection has already advanced.

| Trace context | Local sequence | Clock value | Recorded boundary | Meaning |
|---|---:|---:|---|---|
| authority-first | 19 | 7 | `authority.commit`, revision 2 | The second write is committed. |
| authority-first | 20 | 7 | `authority.publish`, revision 2 | Live delivery publishes the committed collection. |
| client | 38 | 100 | `state.transition` / `LIVE_SNAPSHOT` | The model has two Todos and one pending reply. |
| client | 39 | 100 | `effect.cancel` | Disposal cancels the locally pending finite operation. |
| client | 40 | 100 | `resource.state` / `disposed` | The mutation queue has zero count, active and queued operations. |
| authority-first | 22 | 7 | `resource.state` / `unsubscribe` | The authority has zero subscribers, active and queued work. |
| worker | 29 | 20 | `resource.state` / `release` | Live ownership has zero active work, listeners, pending events and bytes. |

This is distinct from an error or successful completion. The direct resource
assertions accompany the records: a cancel/finalize notification alone would not
prove cleanup. `scope.dispose` records the **start** of cancellation, not a
promise that every child has already finished releasing resources.

## Reconstruct the same authority history

The fixture disposes the first functional authority and constructs a replacement
on the same attached SQLite storage. Its injected clock deliberately reads 2,
which is less than the old clock's 7.

| Trace context | Local sequence | Clock value | Recorded boundary | Meaning |
|---|---:|---:|---|---|
| authority-replacement | 5 | 2 | `authority.recovered`, revision 2 | Stored `persisted-generation` is reconstructed with both committed Todos. |
| authority-replacement | 6 | 2 | `authority.publish` / `initial`, revision 2 | A new live registration receives the current full snapshot. |
| authority-replacement | 8 | 2 | `resource.state` / `settled` | Active, queued, pending and subscriber counts return to zero. |
| authority-replacement | 10 | 2 | `scope.dispose` | The replacement owner is disposed after the check. |

No new commit record appears during reconstruction. Persistent state survives;
running subscriptions do not. The entire traced/control fixture issues the same
three requests and two mutations, reconstructs equal state, and finishes with
zero authority resources. Separate native-browser and process-restart gates test
actual runtime shutdown and reconstruction across processes.

## The real browser reaches targeted rendering

The following records come from `browser-built-final`, using the real built
application, native HTTP/EventSource and a local Wrangler server. The trace
runtime is `traced-A-document-1`; timestamps below are its `performance.now()`
readings rounded to 0.001 ms. Full values remain in the recorded JSON.

The first create's operation ID is
`traced-A-document-1:checkpoint-mount-1:1`. The collection is `local-reference`;
its recorded generation is `cc39ffcd-290f-47e1-a86f-7502539d4fba`.

| Local sequence | Time (ms) | Recorded boundary | Observation |
|---:|---:|---|---|
| 22 | 310.600 | `source.received` / `CREATE_REQUESTED` | A real DOM submit reaches model ingress. |
| 24 | 310.700 | `intent.accepted` | The accepted create receives its correlation ID. |
| 29 | 310.800 | `effect.subscribe` | The owned HTTP operation starts once. |
| 34 | 327.900 | `connection.change` / `snapshot`, revision 9 | Native SSE supplies the new committed collection. |
| 36 | 327.900 | `state.transition` / `LIVE_SNAPSHOT` | One Todo is accepted while its reply remains pending. |
| 38 | 328.800 | `render.commit` | The keyed DOM update has committed. |
| 39 | 332.800 | `effect.next` | The real HTTP reply arrives. |
| 43 | 333.400 | `render.commit` / `CREATE_SUCCEEDED` | Pending feedback and the accepted draft settle. |
| 44 | 333.500 | `effect.complete` | The finite application operation completes. |

For the second create, revision 11 rendered at sequence 72 while its reply was
held. Local disposal recorded `effect.cancel` at sequence 79. Remount then
rendered revision 11 with both Todos at sequence 96, confirming that cancellation
had not removed the committed write. The harness checked the native canceled
request and released listeners in addition to inspecting these records.

The same built page later remained mounted during full server process shutdown
and restart:

| Local sequence | Time (ms) | Connection observation |
|---:|---:|---|
| 204 | 944.600 | The current connection receives revision 14. |
| 210 | 1006.600 | Interruption schedules retry attempt 2 after 1,000 ms. |
| 215 | 2008.500 | Connection 2 starts. |
| 220 | 2010.200 | That attempt fails; attempt 3 is scheduled after 2,000 ms. |
| 225 | 4010.600 | Connection 3 starts. |
| 230 | 4034.600 | The new connection receives the same generation and revision 14. |
| 233 | 4034.900 | The recovered collection renders. |

A later write advances to revision 15. There was no browser navigation in this
built run. These observed retry counts are one schedule, not an invariant: the
server's restart time affects how many attempts occur. The separate deterministic
trace-disabled/enabled scenario compares identical request vectors before this
restart experiment.

## Interpret the limits

| Observation | What it establishes | What it does not establish |
|---|---|---|
| Increasing sequence in one trace runtime | Local observation order. | A total order across runtimes. |
| Equal timestamps | The supplied clock returned the same value. | Simultaneity or notification order. |
| Shared operation correlation | A trusted owner associated boundaries with one accepted operation. | User authorization or exactly-once execution. |
| Collection, generation and revision | The accepted committed history and version. | Worker process identity or persistent subscriptions. |
| Trace-disabled/enabled request parity | Observation did not repeat effects in that scenario. | Zero overhead in every host or arbitrary instrumentation. |
| Bounded recorder and dropped count | The diagnostic retention policy held. | A complete durable event history. |

The passive recorder retained 455 final built records without drops; this
readable selection is smaller. The final development run retained 443 records
and separately reported Vite HMR document replacement. Both ended with zero
current-document API requests and zero uncaught browser errors. See the
[acceptance report](acceptance.md) for listener counts, unchanged request vectors,
lightweight timing samples and the missing terminal events for retired development
documents.

The trace sink is a synchronous host capability. Exceptions are isolated, but a
sink that performs application actions can change the host externally. Recursive
trace emissions are dropped and counted in `reentrantDrops`; no unbounded
recording queue is created. Identifiers are developer metadata and must not
contain private payload values. Rich devtools, remote trace collection and
universal performance claims remain outside M08.

Use the [local guide](local-development.md) to inspect the existing application
or reproduce the actual trace artifact. Source commands, digests, limits and
intermediate failures are retained in the [execution ledger](execution.json).
