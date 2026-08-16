# Phase 2 — provider-neutral checkpoint / restore core

Status: implemented and covered by file-backed SQLite integration tests. This
milestone is the provider-neutral core. Provider transport and trust policy are
outside the Phase 2 acceptance claim.
The normalized-authority prerequisites are closed in
[`phase1-normalized-authority.md`](phase1-normalized-authority.md). Capture still
fails closed if a required normalized row/register is absent; it never falls
back to a JSON or numeric projection.

## Shipped boundary

- `captureSnapshotV1` opens one SQLite transaction and captures the current
  manifest-classified authored rows, reducer metadata, applied frontier, and
  every project-owned prose document. A later authored transaction cannot enter
  the captured frontier and remains in the ordinary journal.
- Prose enumeration is the exact union of persisted `yjs_snapshots`, persisted
  `yjs_updates`, and the four prose-capable seed families:
  `node-content:*`, `storyline:*`, `element:*`, and `category:*`.
- Snapshot-only, update-only, and combined documents become one verified Yjs
  full-state update. A document with no persisted CRDT bytes remains an explicit
  `seed-only` record; it is not silently promoted to an empty `Y.Doc`.
- `project_asset` metadata is captured only after an injected native-facing
  port verifies the canonical source hash, size, and MIME. The renderer core
  sees only `LocalObjectRef`, never an absolute path.
  The production implementation and restart-safe restore receipts are recorded
  in [`phase2-native-asset-pipeline.md`](phase2-native-asset-pipeline.md).
- Reducer state carries the applied change-set/receipt ancestry required by the
  baseline foreign keys together with field clocks, OR-set tags, order
  registers, lifecycle registers, the terminal `sync_generation_purge` register,
  and frontier. Restore invalidates the
  in-process reducer cache only after the activation transaction commits.
- Reducer-state materialization round-trips the SyncGeneration purge register and its
  source mutation. Replaying that state keeps all later non-purge effects
  non-materializing. A complete product snapshot that already contains the
  terminal register is rejected instead of activating a purged SyncGeneration as a live
  project; restore therefore cannot overwrite the absorbing state.
- Every captured writer frontier carries the hash of its highest contiguous,
  fully applied segment. A non-empty applied frontier without that chain head
  is not a valid v1 checkpoint. Restore keeps the anchor even though it does
  not recreate historical `sync_segment` rows.
- Source change-set rows are restored as `origin='remote'`. They remain exact
  reducer ancestry for receipts and clock/register foreign keys, but can never
  become the restoring installation's outbound segment lane.
- Restore creates a fresh writer identity owned by the current native
  installation, leaves its first sequence at `1`, and anchors its persisted HLC
  to the maximum HLC in all checkpoint-covered change-sets. A first local write
  therefore wins after source `+24h` / restoring device `-24h` skew without
  reusing a source writer identity.
- The verified package is recorded as the restore attempt's exact
  `source_checkpoint_id`; cloud input retains the stored-object hash, size and
  local reference rather than manufacturing a Drive receipt.
- A snapshot is publishable only in the order `required blobs → package →
  snapshot-commit`. Failure before the last call never publishes the commit
  marker, so a package body without its marker is an invisible orphan.
- Restore decodes current deterministic CBOR only, binds marker/package hashes
  and identities, validates the current manifest, cross-table references,
  asset manifest, reducer identity/frontier, and every Yjs state before creating
  a domain row.
- Asset preparation/verification is isolated under one restore attempt. The
  project, reducer metadata, full Yjs states, blob receipts, SyncGeneration activation,
  and activation receipt commit in one SQLite transaction. A failed validation
  or transaction leaves the target project absent and the staged SyncGeneration
  unbound. Native orphan cleanup owns residue if a process dies after a native
  rename and before the SQLite commit.
- Unknown protocol/payload/schema versions fail closed. There is no historical
  upconverter or compatibility branch.
- Capture detects any missing KV/alias/Plot Grid/order authority and rejects
  the package. This is a corruption/data-loss guard, not a legacy
  compatibility path.

## Deliberate exclusions

- This module does not upload to Google Drive, choose scheduler thresholds,
  resolve OAuth, set provider trust policy, or expose filesystem paths.
- It does not reuse the product's `snapshot_history` restore service. Sync
  checkpoint restore is a separate sync-generation activation path.
- A conflicting existing project is never merged or overwritten. Higher-level
  connect orchestration must resolve project identity before invoking this core.

## Machine acceptance

```bash
pnpm typecheck
pnpm exec eslint src/renderer/sync/checkpoint --max-warnings=0
pnpm exec vitest run src/renderer/sync/checkpoint/checkpoint.integration.test.ts
```

The integration test uses the product baseline in real file-backed SQLite and
covers:

- snapshot-only, update-only, combined, and seed-only Yjs capture/restore;
- typed authored rows plus reducer ancestry/clock materialization;
- applied segment-head round-trip, fresh restore writer sequence/HLC anchoring,
  and source-history non-publication semantics;
- blob/package/`snapshot-commit` visibility ordering;
- missing and corrupt blobs, wrong ProjectSync identity, unknown version, and invalid Yjs;
- failure isolation: no project row and no staged sync-generation activation on failure.
- terminal project-purge reducer-state round-trip and post-restore non-resurrection.

The machine-readable result is
[`acceptance/phase2-checkpoint-restore.json`](acceptance/phase2-checkpoint-restore.json).
