# Phase 1 remote Yjs live merge

Status: implemented and file-backed machine-checked.

## Commit and delivery boundary

A remote `yjs.update` has two distinct responsibilities:

1. the production reducer validates the bytes in a temporary `Y.Doc`, appends
   the update row and remote revision provenance, refreshes the scalar
   projection, records the apply receipt, and advances the writer frontier in
   one SQLite transaction;
2. only after that transaction commits, the runtime asks the already-open
   `YjsDocumentSession` to replay the exact persisted SQLite tail into its live
   `Y.Doc`.

The live document is never mutated from inside the reducer transaction. The
post-commit replay uses a persistence-owned origin, so the session does not
append an authored update or create a local SyncEngine change-set. After the
live merge completes, production emits `sync:project-changed` with an exact
projection impact. A batch whose materialized effects are all `yjs.update` is
`prose-only`: the open editor remains interactive and derived prose metrics are
reconciled after a quiet window without replacing the structural workspace
store. Metric publication patches only its owned word-count basis fields, so it
cannot replace a simultaneous optimistic title, order, or status edit. Any
field, tuple, set, order, lifecycle, asset, purge, mixed, or empty
impact remains `workspace` and crosses the existing atomic refresh barrier.
Store consumers therefore cannot run ahead of an open prose editor, while
ordinary remote writing no longer produces a full-screen interruption.

## Replayable coverage barrier

The session coverage watermark advances row-by-row only after Yjs accepts the
exact bytes returned by `yjs_updates.listUpdates(docId, coveredId)`. It never
jumps directly to a later persisted Agent/local update ID. This closes the race
where remote N+1 commits while local N+2 is already being merged into the open
editor.

The callback is an optimization, not the only recovery path:

- every SyncEngine apply cycle first reconciles all open sessions in the
  project, including a cycle that skips an already-receipted change-set;
- only a proven, non-empty set of materialized Yjs effects may take the
  non-blocking prose seam; mixed or ambiguous commits fail closed to the
  structural workspace barrier;
- explicit/lifecycle flush, periodic snapshot and final close all reconcile the
  persisted tail inside the session's serial write queue before capturing the
  full state;
- a callback failure or process crash leaves the unrepresented update row
  uncompacted, so the next cycle, lifecycle barrier, or ordinary reopen can
  replay it;
- compaction receives only the highest row ID that this exact live `Y.Doc`
  proved it absorbed.

Closed documents need no in-memory delivery. Their normal load replays the
snapshot and remaining update rows from SQLite.

## Machine acceptance

The focused acceptance uses real file-backed SQLite for the complete remote
N+1, local N+2, periodic compaction, close and reopen path. It also verifies
that a failed post-commit callback is retried by the next cycle-wide tail
barrier even though the remote apply receipt/frontier already committed, and
that the project reload callback follows exact Yjs reconciliation.

```text
pnpm exec vitest run \
  src/renderer/services/yjs-document-session.test.ts \
  src/renderer/services/yjs-remote-live-merge.integration.test.ts \
  src/renderer/sync/engine/durable-runtime.integration.test.ts \
  src/renderer/sync/engine/architecture.test.ts \
  src/renderer/sync/production-runtime.test.ts
```

Machine-readable evidence:
[`acceptance/phase1-remote-yjs-live-merge.json`](acceptance/phase1-remote-yjs-live-merge.json).

This acceptance is local/file-backed. It does not claim a real Google Drive
account or physical desktop/iOS/Android convergence run.
