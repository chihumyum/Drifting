# Tauri database read/write performance

The active Tauri client already uses `drifting_core::database::DatabaseGateway`.
Moving SQLite into Rust is complete; remaining candidates concern statement
preparation, transport and the number of renderer/backend round trips. This
work does not resume the paused Apple client migration.

## Current paths worth measuring

- `database.rs` prepares query statements on every call; its execute path also
  uses an uncached rusqlite preparation. A bounded prepared-statement cache can
  avoid compilation while leaving SQL and transaction boundaries unchanged.
- `platform/database.ts` represents BLOBs as JSON number arrays. Encoding copies
  a `Uint8Array` to an array; decoding validates into an intermediate array and
  then creates a new `Uint8Array`. Snapshot/tail-heavy workloads are candidates
  for a more efficient wire representation or fewer copies. Codec-only timing
  is insufficient: include both ends and actual payload sizes.
- Workspace capture has collection/row-level incremental reuse already. A full
  capture still invokes multiple repository queries in one transaction. Its
  `Promise.all` does not make the single SQLite worker parallel. A bounded
  multi-query command could reduce transport calls without replacing the SQL
  with a large join; it must preserve transaction ownership and snapshot scope.
- Yjs append/CAS writes already use transactions. A native operation could
  combine the existing update/revision/provenance statements, but integration
  must also retain the authored journal, admission and post-commit live delivery
  contracts. The repository-only benchmark below does not accept that change.

WAL and `synchronous=NORMAL` are already enabled. Neither durability weakening
nor a speculative connection pool is part of these candidates.

## Prepared-statement cache experiment

```sh
pnpm exec node --expose-gc --conditions=import --import=tsx scripts/benchmark-database-cache.ts
pnpm exec node --expose-gc --conditions=import --import=tsx scripts/benchmark-database-cache.ts --check
# --quick writes an ignored smoke report, never acceptance evidence.
```

The runner builds two Release hosts from separate scratch copies of the same
shared Rust core. Only the candidate changes `query_sql` and `execute_sql` to
use `prepare_cached`, with a bounded capacity of 128 statements. Production
source is untouched. Both copies receive identical benchmark-only SQL timers
and request counters. The [generated report](acceptance/database-cache-benchmark.json)
records source/binary/lock fingerprints and all samples.

Both lanes call the actual renderer node repository, workspace capture, Yjs
append/CAS repository and metrics reconciler through Drizzle and the database
wire codec. JSON-lines pipes replace Tauri IPC. The SQL timer includes binding,
preparation, stepping and row conversion, but excludes gateway waiting,
transaction begin/commit, JSON and renderer work. End-to-end timings include
the complete requested service/repository operation.

Three warmup pairs precede nine measured pairs, with alternating lane order.
Every lane starts from a fresh identical database copy and connection; repeated
operations warm its statement cache naturally. Repeat reconciliation alone is
primed outside timing. Node GC is outside timing and OS caches are not flushed.
Fixtures use synthetic 5,000-UTF-16-unit bodies, snapshots and eight updates per
document. Workspace fixtures are node-heavy, with empty secondary collections.

Every paired service result and database state must agree. Repository-generated
creation/update timestamps are normalized. Parallel metrics workers may assign
projection-change revisions to entities in a different order, so their revision
multiset and entity coverage are compared separately. Yjs revisions, BLOB bytes,
provenance, replacement revisions and final projection clocks remain exact.
SQLite integrity and foreign-key checks run outside every timed interval.

Before the full run, the performance gate was set to at least two workloads
with a median improvement of 10% and at least 75% of pairs faster, with no
workload regressing more than 5% in median time. Passing would only justify
further correctness work, including cache lifecycle/schema changes; it would
not by itself accept the implementation. These measurements do not establish
WKWebView, UI, live typing, sync or durability performance.

## Measured decision, 2026-09-30

Keep the production gateway unchanged. Statement reuse reduces SQLite service
time, but whole-operation gains are modest and the predeclared performance gate
does not pass. This is not a finding that caching has no effect: point reads
improve by 9.0%, and first metrics reconciliation improves by 5.7%. Neither is
enough for this batch's substantial-benefit requirement; repeat reconciliation
regresses by 1.4%. Further correctness work and production integration are
therefore deferred.

Apple M3 Pro, Node 24.19.0, Rust 1.96.0; nine-pair medians in milliseconds.
Workspace and append rows time the whole listed batch, not one operation.

| Workload | Baseline total | Cached total | Improvement | Baseline SQL | Cached SQL | Faster pairs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 node point reads | 127.26 | 115.78 | 9.02% | 14.78 | 5.95 | 8/9 |
| 20 full captures, 200 nodes | 105.48 | 100.33 | 4.88% | 12.07 | 7.01 | 8/9 |
| 20 full captures, 1,000 nodes | 376.06 | 359.98 | 4.27% | 27.85 | 20.95 | 7/9 |
| 200 Yjs appends | 150.11 | 146.36 | 2.50% | 7.21 | 4.26 | 8/9 |
| 200 Yjs CAS appends | 150.16 | 149.05 | 0.74% | 7.35 | 4.42 | 6/9 |
| 200-node first metrics reconciliation | 593.59 | 559.88 | 5.68% | 60.15 | 27.26 | 9/9 |
| 200-node repeat metrics reconciliation | 292.36 | 296.50 | -1.42% | 16.55 | 11.42 | 4/9 |

All seven workloads pass result/state parity and database checks. No production
Rust/renderer source, schema, transaction or wire protocol is changed. The
experiment suggests examining data movement and renderer work next, but does
not prove which part of the remaining time dominates real Tauri IPC.

## Yrs boundary

Yrs is a separate CRDT-engine candidate, not a replacement for the SQLite
gateway. The current live `YjsDocumentSession` already emits a snapshot from its
resident `Y.Doc` after 50 local updates and at final close. Rebuilding the same
state in Rust just to produce that snapshot could add work. Closed-document
snapshot/tail processing is a more bounded experiment; if it feeds an editor,
include the final Yjs apply cost as well as native computation and transport.

The existing `drifting-document` owner explicitly uses UTF-16 offsets and v1
output, with checks around pending updates and cross-language binary values.
Reuse that owner and its compatibility boundaries. Do not silently substitute
native projections whose JSON/hash semantics differ, or bypass the live
session's compaction coverage cursor and immutable authored journal.
