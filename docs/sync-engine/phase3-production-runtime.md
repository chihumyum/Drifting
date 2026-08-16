# Phase 3 production runtime composition

Status: implemented for already-activated provider bindings. Initial connection,
restore and provider switching remain separate durable orchestration flows; this
module never manufactures a binding or exposes unfinished UI.

`src/renderer/sync/production-runtime.ts` is the App-scope owner of the running
SyncEngine coordinator. It waits for `db:ready`, reads the single App-wide
provider authority, and mounts one `SqliteSyncGenerationRuntime` per active
SyncGeneration.
`sync:authority-changed` replaces the complete generation; `db:error` tears the
current generation down without making a later database recovery impossible.

## Product wiring

Each Google Drive runtime receives:

- one shared `GoogleDriveObjectLogProvider` backed by the native-only Tauri
  transport;
- the integrity-checking plaintext object codec; there is no Drifting-held
  Project content key, and Google can process the synchronized objects;
- `nativeSyncAssetBlobPort`, so verified source blobs precede owner mutations;
- `productionSyncDomainMaterializationKernel`, never raw remote SQL;
- the native-secure installation writer identity; and
- the local persistence barrier before segment sealing; and
- a lazy per-project `ProviderSnapshotPublisher` checkpoint hook using the same
  provider handle, object codec and native asset capture port.

The checkpoint hook is part of every mounted production project, rather than an
unreferenced library API. It opens its internal provider handle only when the scheduler
asks to evaluate checkpoint policy. The shared policy then refuses capture for
detached/non-active SyncGenerations or any open frontier gap, semantic conflict or
blocked quarantine, and publishes blobs/package/commit marker in that order.

The supervisor validates that all bindings have the same provider mode and
authority generation. A Hosted authority fails closed until its immutable
object provider exists. Local mode returns before loading the native writer
identity, constructing a provider or installing network/lifecycle callbacks.

Native asset attempt reconciliation runs before any project cycle. This finishes
or rolls back crash-interrupted asset activation receipts before a remote
`asset.bind` can be applied.

`ProductSyncRuntimeControl` is the only UI-facing bridge. The active supervisor
attaches the current coordinator and removes it before generation replacement.
Its immutable snapshot contains only registered `syncGenerationIds` and sanitized
phase/outcome/pending diagnostics; it cannot expose provider credentials,
filesystem references, resumable sessions, content or reducer payloads. Manual
sync requests are routed back to registered projects through this bridge.

## Lifecycle and replacement

Runtime reloads are serialized and revision-guarded. A stale async activation
cannot install callbacks after a database error, App provider transition, or
React unmount. Replacement first removes the old coordinator signals and
SyncGeneration registrations, then mounts the new authority generation.
Product UI continues to present Projects rather than transport generations.

The existing coordinator owns commit debounce, foreground polling,
online/offline/resume triggers and best-effort lifecycle flush. Network I/O
never runs inside an authored SQLite transaction and provider failure never
blocks local editing.

## Machine acceptance

```bash
pnpm exec vitest run \
  src/renderer/sync/production-runtime.test.ts \
  src/renderer/sync/product-runtime-control.test.ts \
  src/renderer/sync/app-authority-repository.integration.test.ts \
  src/renderer/sync/checkpoint/provider-publisher.integration.test.ts
pnpm exec eslint \
  src/renderer/sync/production-runtime.ts \
  src/renderer/sync/production-runtime.test.ts \
  src/renderer/sync/product-runtime-control.ts \
  src/renderer/sync/product-runtime-control.test.ts \
  src/renderer/sync/app-authority-repository.ts \
  src/renderer/app/effects/AppEffects.tsx \
  src/renderer/lib/events.ts --max-warnings=0
pnpm typecheck
```

Machine-readable evidence:
[`acceptance/phase3-production-runtime.json`](acceptance/phase3-production-runtime.json).
