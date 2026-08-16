# Phase 1 local runtime boundary

Status: implemented and machine-checked for the workspace bootstrap and app
lifecycle reachability boundary.

## Frozen behavior

- `ProjectRuntimeProvider` opens the per-device database and hydrates all
  project stores from local SQLite repositories/use cases. It never calls the
  retired hosted `/graph` pull-and-overwrite path.
- The lifecycle barrier drains the active editor, open Yjs documents, snapshot
  history, native asset mutations, authored SQLite transactions, the SQLite
  checkpoint, and local token persistence. These operations do not wait for
  network I/O.
- `flushRemoteApplicationPersistence()` invokes only the optional global hook
  registered through `installSyncEngineLifecycleHook`. Before SyncEngine is
  installed, the remote lane is an intentional no-op. It cannot reach the old
  entity, Yjs, or account-preference transports.
- Native asset write/copy/delete operations register synchronously with a
  process-local durability barrier. The native commands already complete only
  after their atomic filesystem operation and parent-directory barrier.
- Entity snapshot history remains device-local. A closed-document history
  restore records its Yjs update, local revision/provenance, snapshot and one
  provider-neutral change-set atomically before compaction; the retired direct
  `/api/snapshots` copy no longer exists.

## Scope

This slice also deletes the retired `entity-sync.service.ts` implementation,
its destructive graph-hydration tests, its coalescing/entitlement helpers, and
the account-preference HTTP mirror. It also removes the hosted sync feature
flag, observer, HUD, activity panel, and debug-toast settings. Until the real
SyncEngine status store is wired, the status bar reports only the truthful
on-device state. Settings remain in the local persisted settings store until a
future explicitly versioned preference domain is added to SyncEngine. This
local-runtime milestone is not evidence of a real-account Google Drive cycle.

Machine checks:

```text
src/renderer/app/providers/project-runtime-local-bootstrap.acceptance.test.ts
src/renderer/lib/persistence-lifecycle.test.ts
src/renderer/services/asset-store-durability.test.ts
src/renderer/services/snapshot-restore-sync-boundary.acceptance.test.ts
```
