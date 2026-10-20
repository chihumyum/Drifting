# Phase 7 — sync log compaction

Status: client implemented and covered by file-backed SQLite integration tests.
Hosted pruning stays off (`SYNC_LOG_PRUNING_ENABLED = false` in
`src/renderer/sync/production-runtime.ts`) until the Hosted service ships the
removal feed and prune endpoint below and is deployed. Evidence:
[`acceptance/log-compaction.json`](acceptance/log-compaction.json)
(`pnpm sync:compaction:evidence`, checked by `pnpm sync:compaction:check`).

## Problem

Every SyncGeneration is an append-only object log: per-writer hash-chained
segments, periodic full-state checkpoints (genesis/checkpoint package plus a
snapshot-commit marker) and blobs. Nothing was ever removed, so the Hosted
store grew with every edit and every weekly checkpoint, and a fresh device
downloaded all history.

## Relation to Raft snapshots

| Raft | Drifting |
| --- | --- |
| State-machine snapshot | Checkpoint package: authored rows, compacted reducer state, Yjs full state per document |
| `lastIncludedIndex` | Per-lane applied frontier plus that lane's segment-head hash |
| Log truncation | Hosted prune of covered segments and superseded snapshots |
| `InstallSnapshot` | Lagging-replica fast-forward onto a snapshot |

The difference is the follower. A Raft follower has no writes of its own and
can be overwritten. Every Drifting replica is a writer, and device-local data
(Agent conversations, Working Memory) cascades from the project row. A lagging
replica therefore **rebases** onto the snapshot instead of reinstalling.

## Truncation

- **Retention.** The newest two snapshots are kept. Order is a deterministic
  linear extension of frontier dominance (`compaction/frontier.ts`), not commit
  time, so a lagging device's late checkpoint never outranks a fuller one.
- **Covered history.** A segment may go when its whole range is at or below
  the per-lane minimum of the retained frontiers. Each retained snapshot covers
  everything removed, so either one plus the remaining segments reconstructs
  the full history. The older one stays a complete fallback.
- **Retained format.** Both retained snapshots must be payload v2, the only
  format catch-up installs.
- **Provider guards.** The provider cannot decode objects; coverage is the
  pruning client's proof. The provider enforces the rest: at least two
  retained markers, packages only together with a marker, no blobs, segments
  inside the 30-day grace window are deferred, and nothing above `basisCursor`
  is removed. A snapshot that arrived after the basis rejects the request, so
  concurrent pruners always share one retained set.
- **No regressing snapshots.** A replica publishes a checkpoint only when its
  applied frontier dominates the newest snapshot (`allowsCheckpoint`).
  Otherwise a device that missed truncated history could publish a "newest"
  snapshot that drops it.
- **Old clients.** New clients send `X-Drifting-Sync-Capabilities: removals-v1`.
  Once a stream was pruned, Hosted rejects clients without it (HTTP 426), so an
  old client stops syncing with its local data intact instead of silently
  missing history.

## Removal handling

On a provider with `pruneObjects`, a removed segment or snapshot object is
expected truncation: it is recorded (`removed_at`) and never blocks the
binding. Downloaded segment bytes stay authoritative after removal, and a
download that can no longer complete is cancelled. A failed download (HTTP 404)
alone is not proof of pruning. The object stays in the inbox and the backlog
retries it until the provider's removal change settles it. On these providers
the backlog also downloads snapshot objects, so a restored replica can read
every committed snapshot. A removed blob is still corruption, as is any removal
on providers that never prune. Restore discovery drops objects pruned while it
lists them.

## Catch-up (InstallSnapshot as rebase)

`compaction/catch-up.ts` runs before segments are applied. It triggers when the
newest snapshot covers a lane that no local segment chain can reach. That
includes quiet lanes and retired writer epochs, which never open a frontier
gap. In one SQLite transaction it:

1. imports the snapshot's journal rows that this replica lacks;
2. joins the frontier per lane and adopts the snapshot's segment head. A
   received successor that does not extend that head is quarantined instead;
3. replaces the reducer base and deletes derived reducer snapshots, which would
   otherwise be preferred over the new base;
4. rebuilds base plus every applied change-set the base does not cover, so this
   replica's unsent edits survive, then converges domain rows to the full
   projection. Registers are total-order LWW, tag-keyed sets and
   incarnation-keyed lifecycles, so replay is order-independent;
5. advances the local HLC past the snapshot so later edits order after it;
6. appends each document's Yjs difference from the local state vector as an
   ordinary update row (open editors reconcile from the tail) and refreshes the
   cached prose projection.

It runs only when the snapshot covers the replica's existing reducer base, and
never with open conflicts or quarantine. Writer identity, device-local tables
and unsent change-sets are untouched; nothing needs to be uploaded first. Prose
whose owner this replica purged is not merged back. Assets the snapshot
introduced are recorded as missing blob state in the same transaction, and
ordinary blob ingest installs them on later cycles. If a snapshot cannot be
installed (newer format, corrupt package, rejected replay), the replica keeps
waiting on its gap and keeps uploading its own edits. It retries only once the
snapshot set or its frontier changes.

## Local truncation

Once a pruned segment is applied, its local `sync_segment`, transfer and
local-object rows are deleted. The startup orphan sweep removes the file. The
newest segment of every lane stays, because sealing chains a writer's next
segment to it. Journal rows (change-sets, mutations, receipts) stay, because
reducer metadata references them through restrict foreign keys. Truncating
them is separate future work.

## Boundaries

- Only payload v2 snapshots are installed; v1 packages wait for a v2 checkpoint.
- Assets introduced in pruned history are fetched by the ordinary blob path
  from the snapshot's asset list; blobs themselves are never pruned.
- Real Hosted deployment, multi-day grace behavior and physical devices are
  outside this evidence.
