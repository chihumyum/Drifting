# Phase 2/3 native asset pipeline

Status: production native capture/restore ports and the durable SyncEngine blob
lane are implemented. This closes the former `requiredBlobIds` deadlock: a
remote segment can now move from received to applied only after every referenced
source is downloaded, verified, atomically installed and recorded as locally
verified.

## Byte and path boundary

- Renderer SyncEngine code never reads image/PDF bytes and never receives an
  absolute source or staging path. Every native/provider handoff uses a
  root-validated `syncobj:` reference.
- `sync_asset_capture_source` resolves the canonical app-owned source from
  `(projectId, assetId, MIME)` natively, streams its SHA-256 and size, validates
  its file signature, and copies it to an opaque staging object with an atomic
  rename and durability barrier.
- The native blob adapter stages captured sources as immutable SyncEngine blob
  objects. Provider identity is derived from canonical protocol metadata; the
  source SHA-256, byte size, and MIME remain available for verification.
- Drifting applies no project-content encryption before Google Drive upload.
  Native-only paths and credentials remain protected boundaries, but Google is
  trusted with the stored blob bytes.
- Image display/thumbnail variants are deliberately absent from the protocol.
  They are rebuildable projections. PDF and image source bytes are exact.

## Journal-to-provider ordering

`SqliteSyncGenerationRuntime` derives typed blob declarations only from validated
`asset.bind` mutations:

1. capture and verify the local canonical source;
2. stage it natively as an immutable `blob` object;
3. atomically record `sync_local_object` plus
   `sync_blob_state.local_state='verified'`;
4. publish missing blobs;
5. publish a segment only after every `requiredBlobId` has
   `remote_state='available'`.

On receive, provider bytes first become a durable inbox object. The native blob
port checks content SHA/size and MIME against segment declarations, installs
every referenced asset source, and returns a commit / rollback receipt. SQLite
records the local object and blob as verified in one transaction. Only after
that transaction commits does the runtime finalize native staging. If SQLite
fails, native activation is abandoned and no owner mutation can materialize.

The production domain kernel independently checks `sync_blob_state` during
`asset.bind`, so bypassing the engine gate still fails closed.

## Restart and crash semantics

Each restore/install attempt has one durable native JSON receipt per source.
Activation is idempotent: an already installed source is accepted only when its
hash, size and MIME signature still match. The boundaries are:

- `prepare`: verified source copied to native staging and receipt fsynced;
- `activate`: each canonical source atomically promoted, then receipt marked
  activated;
- `finalize`: called only after SQLite commits; removes staging/receipts and
  preserves canonical sources;
- `abandon`: before SQLite commit, removes staged sources and any matching
  canonical files promoted by the attempt;
- startup reconciliation: completed checkpoint/blob receipts are finalized,
  interrupted checkpoint attempts are abandoned and marked failed, and stale
  unknown attempts are collected.

The Rust child-process test sends a real POSIX `SIGKILL` after one source
promotion, then replays activation and proves both complete hashes are valid and
no `.part` file remains. TypeScript integration additionally injects an inbound
install failure and proves there is no apply receipt, verified blob row or owner
materialization.

## Production factories

The ready-to-compose adapters are exported from
`src/renderer/sync/assets`:

- `nativeSnapshotAssetCapturePort`;
- `nativeSnapshotAssetRestorePort`;
- `nativeSyncAssetBlobPort`;
- `reconcileNativeSyncAssetAttempts`.

Runtime composition passes `nativeSyncAssetBlobPort` as
`SqliteSyncGenerationRuntimeOptions.blobPort`. Checkpoint capture/restore passes the
two snapshot ports. Startup must run reconciliation before scheduling project
sync cycles.

## Machine acceptance

```bash
cargo test sync_asset_store::tests --lib --manifest-path src-tauri/Cargo.toml -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
pnpm exec vitest run \
  src/renderer/sync/assets/native-asset-pipeline.test.ts \
  src/renderer/platform/tauri.test.ts \
  src/renderer/sync/engine/durable-runtime.integration.test.ts \
  src/renderer/sync/checkpoint/checkpoint.integration.test.ts
pnpm typecheck
```

Machine-readable evidence:
[`acceptance/phase2-native-asset-pipeline.json`](acceptance/phase2-native-asset-pipeline.json).
