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
| Log truncation | Hosted prune of covered segments and superseded snapshots; local journal rows below the reducer base |
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

**Segment objects.** Once a pruned segment is applied, its local
`sync_segment`, transfer and local-object rows are deleted. The startup orphan
sweep removes the file. The newest segment of every lane stays, because sealing
chains a writer's next segment to it.

**Journal rows** (`compaction/journal-truncation.ts`, migration
`0008_sync_journal_truncation`). This is the replica's own log truncation, with
the Raft rule that a node drops only the log its snapshot covers. It runs after
apply on a pruning provider (`SYNC_JOURNAL_TRUNCATION_ENABLED`), independent of
Hosted pruning, and re-checks only when the snapshot set, the frontier or the
published segments move.

1. **Base.** The base is the newest published snapshot (payload v2, this
   project, same reducer profile) that meets four conditions:
   - the newest snapshot dominates it, so concurrent or older-build snapshots
     outside a dominance chain are never chosen;
   - this replica's applied frontier dominates it;
   - it covers more than the current base and dominates it;
   - every one of its explicit receipts is applied here.

   Own published checkpoints qualify like any other. Later snapshots cover the
   newest one, so they keep covering the base, and catch-up, which refuses a
   snapshot below the base, stays possible.
2. **Install, in one transaction.** The base is installed and derived reducer
   snapshots are deleted. The reducer state rebuilt on the new base must equal
   the current state byte for byte in canonical page form. Otherwise the
   transaction rolls back and that snapshot is not tried again this session.
   Domain rows and reducer metadata are not rewritten. The same transaction
   raises the per-lane floor in `sync_journal_truncation` to the base coverage
   and deletes the first batch.
3. **Delete.** Change-set, mutation and apply-receipt rows at or below the
   floor are deleted together, 250 change-sets per transaction so editing is
   never held up for long (about 0.3 ms per change-set on a 140,000-row
   journal). Kept:
   - rows the current state names as register sources;
   - rows reducer metadata references through its restrict foreign keys, which
     stay in place as the fail-closed net;
   - the base's explicit receipts;
   - own change-sets above the lane's `published_seq` or inside an open
     published gap (a segment still waiting on its blobs).

   The protected set is read once per run. Every restrict foreign key's child
   columns are indexed, so each delete checks them by index instead of scanning
   reducer metadata. When a run deletes anything, derived reducer snapshots
   are dropped at its end, so the next one is written on the smaller journal.
4. **Database guards.** The baseline no-delete triggers now admit only an
   applied row at or below its lane's floor, while a reducer base exists, and,
   for `origin='local'`, once published: at or below `published_seq` and
   outside any open published gap. The floor needs a base and never decreases
   or disappears.
5. **Yjs materialization receipts** stay. Their mutation key is a watermark,
   no longer a foreign key, like `yjs_prose_command_receipt.update_id`; the
   insert guard still requires the mutation.
6. **Redelivery.** A change-set below the floor whose row is gone is already
   applied:
   - TypeScript staging (`isJournalTruncationCoveredInTransaction`) treats it
     that way;
   - so does the native receiver (`remote_workspace.rs`), which used to
     de-duplicate by row existence alone.
7. **Monotonic checkpoint policy.** The due check compares the applied journal
   position (sum of the applied frontier, `appliedJournalPosition`) with the
   latest checkpoint's `change_set_count`. It never compares row counts.
   - Captures and restores record that position.
   - An installed reducer base counts as a checkpoint already held.

Deleted rows free pages for reuse; the database file shrinks only after a
`VACUUM`, which truncation does not run.

After truncation, a reducer rebuild starts from the base and replays only rows
above the floor. Restart, remote apply, checkpoint capture and snapshot
catch-up work unchanged on top of it. The tests in
`compaction.integration.test.ts` and
`schema/sync-journal-truncation-migration.integration.test.ts` cover these
paths against file-backed SQLite.

## Boundaries

- Only payload v2 snapshots are installed; v1 packages wait for a v2 checkpoint.
- Journal truncation runs only on pruning providers.
- Below the floor a redelivered envelope is accepted as already applied
  without comparing bytes, because the stored row is gone. A different
  envelope reusing a covered writer sequence (for example a writer epoch
  reused after a device-backup restore) is therefore ignored, not reported as
  a collision.
- Truncated history is gone locally. Native materialization-admission
  verification of a truncated original fails closed, and journal diagnostics
  count only the remaining rows.
- Assets introduced in pruned history are fetched by the ordinary blob path
  from the snapshot's asset list; blobs themselves are never pruned.
- Real Hosted deployment, multi-day grace behavior and physical devices are
  outside this evidence.
