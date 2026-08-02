# Entity snapshot history

Updated: 2026-08-02

Drifting's manuscript recovery surface is the entity history system, not an
Agent conversation checkpoint. It works for author and Agent edits alike and
remains independent of how many Agent sessions exist.

## Authority and coverage

- Local SQLite table `entity_snapshot_history` is the history UI authority.
- Live Yjs is still the current prose source of truth. A history row stores a
  complete Yjs state, a rendered `contentJson` preview and restorable metadata.
- Covered prose entities are nodes (chapters and drifts), elements, storylines
  and categories.
- Restorable metadata includes the fields applicable to that entity: title or
  name, summary, writing status, aliases, group, project KV and category
  template KV.
- Sync-enabled paid projects may copy rows to the server's `entity_snapshot`
  table, but cloud failure never invalidates the local history row.

This is separate from `yjs_snapshots`, which compact current CRDT state for
sync/recovery, and from internal `agent_runtime_checkpoint` rows, which recover
model context. Neither internal table is an author-visible branch mechanism.

## Capture and retention

Existing Yjs persistence moments feed the history service: periodic/unload
snapshots, sync pulls and Agent writes to closed documents. Byte-identical
states are skipped.

- Periodic capture is limited to about one changed state per entity per 15
  minutes.
- Close and restore safety captures bypass the interval but still deduplicate
  unchanged state.
- Rows newer than 24 hours are thinned to the newest row per hour.
- Older rows are thinned to the newest row per day.
- Local history expires after 30 days.

There is no whole-project pre-turn capture and no dependency on an Agent
conversation id, so one session cannot seed or constrain another session.

## Restore

The History snapshots action is available from the entity statistics panel.
Restoring a row:

1. captures the current state as a new safety row;
2. applies the selected prose as a forward Yjs COVER edit;
3. writes metadata through the same renderer use cases as manual edits;
4. persists and syncs the result like an ordinary author edit; and
5. clears editor review markers that referenced the replaced content.

Restore does not recreate deleted structural graph identities and is not a
conversation rewind. Destructive entity/relationship operations remain under
their ordinary permission and durable receipt rules.
