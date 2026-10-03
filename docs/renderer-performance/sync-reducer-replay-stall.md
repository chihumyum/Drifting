# Sync reducer replay stall

## Symptom and evidence

In October 2026 the desktop editor froze for 36 s to several minutes. It still
scrolled already-painted content, but nothing else responded. The
[dev stall watchdog](dev-stall-watchdog.md) logged one freeze per launch, on the
first authored write. Its native sample showed one JavaScript microtask for
the whole stall: about 86% in `Array.prototype.sort`, which constructed a
`TextEncoder` per comparison, plus `Map` copies. The WebView peaked at 2 GB.

## Cause

The SQLite reducer keeps canonical state only in memory. On a cache miss it
replayed the SyncGeneration's receipt-backed journal, and every
`reduceSyncChangeSet` step cloned the whole state, including every receipt.
It also recomputed and sorted all effects. Replay was therefore quadratic in
history. Every Yjs edit is its own change-set, and the affected development
database had 42,091 of them. Every write also re-upserted every reducer
metadata row, and the domain validator looked up entities with a linear scan.

## Fix

- `compareUtf8Bytewise` compares code points in place. It is equal to
  encoded UTF-8 byte order and allocates nothing.
- `replaySyncChangeSets` rebuilds in linear time and is equivalent to the
  step-by-step fold. Single reductions share receipts and unchanged containers
  with their predecessor.
- `sync_reducer_snapshot` (migration `0006_sync_reducer_state`) compacts
  canonical state, so a restart replays only the uncovered tail. Metadata writes are incremental, and
  validation indexes effects per entity. Details are in the
  [materializer rules](../sync-engine/phase1-sqlite-reducer-materializer.md).

## Measurements

These were measured in Node on a private local copy of the affected database
(not committed). The original reducer's full replay took about 175 s; bulk replay now
takes about 80 ms, after about 3 s of async change-set decoding.

| Operation | Time |
| --- | --- |
| First write after the upgrade (full replay, snapshot written) | 3.5 s |
| First write after a restart (27 KB snapshot, receipts compacted) | 0.13 s |
| Warm reduction | about 1 ms |
| Warm remote apply transaction (incremental materialization) | about 10 ms |
| Checkpoint v2 capture (6.3 MB, 130 of 42,101 change-sets carried) | 0.24 s |
| Checkpoint v2 restore into an empty database | 0.33 s |

The capture probe placed the applied frontier at the newest change-sets, as
published segments would; the database itself had never published one.

The original, the step-by-step fold, the snapshot round trip and
snapshot-plus-tail produced identical canonical snapshots. After the
checkpoint round trip, the restored reducer state, authored rows and prose
matched the source.

## Follow-up: checkpoints and remote apply

Checkpoint capture failed for the same history. Its reducer payload exceeded
the canonical CBOR 100,000-node limit, and it bound every change-set ID in one
statement. Checkpoint payload v2 pages every section, compacts covered history
to the change-sets registers still name, and installs the restored state as a
`sync_reducer_base`; see [checkpoint restore](../sync-engine/phase2-checkpoint-restore.md#payload-versions).
Remote apply re-materialized every entity per change-set; it now re-applies
only entities whose effects changed, as the
[materializer rules](../sync-engine/phase1-sqlite-reducer-materializer.md#persistence-rules)
describe.
