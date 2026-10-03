# Phase 2 — provider-neutral checkpoint / restore core

Status: implemented and covered by file-backed SQLite integration tests. This
milestone is the provider-neutral core. Provider transport and trust policy are
outside the Phase 2 acceptance claim.
The normalized-authority prerequisites are closed in
[`phase1-normalized-authority.md`](phase1-normalized-authority.md). Capture still
fails closed if a required normalized row/register is absent; it never falls
back to a JSON or numeric projection.

## Shipped boundary

- `captureSnapshot` opens one SQLite transaction and captures the current
  manifest-classified authored rows, compacted reducer state, applied frontier,
  and every project-owned prose document. A later authored transaction cannot
  enter the captured frontier and remains in the ordinary journal. It writes
  payload v2 only; see [Payload versions](#payload-versions).
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
- Reducer state is the compacted canonical reducer state plus the journal rows
  it still names (see below). Restore materializes every register row it
  implies and invalidates the in-process reducer cache only after the
  activation transaction commits.
- Reducer-state materialization round-trips the SyncGeneration purge register and its
  source mutation. Replaying that state keeps all later non-purge effects
  non-materializing. A complete product snapshot that already contains the
  terminal register is rejected instead of activating a purged SyncGeneration as a live
  project; restore therefore cannot overwrite the absorbing state.
- Every captured writer frontier carries the hash of its highest contiguous,
  fully applied segment. A non-empty applied frontier without that chain head
  is not a valid checkpoint. Restore keeps the anchor even though it does
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
- Every materialized mutation row must match its verified encoded change-set:
  index, action, target family/kind/ID/incarnation, payload version, payload hash,
  and exact canonical payload bytes. Missing, extra or inconsistent rows are
  rejected even when the enclosing package and commit marker have valid hashes.
  Register references therefore cannot acquire a different meaning through a
  separately supplied mutation row. This also preserves a trustworthy source
  for future native operation-provenance validation; it does not infer author
  intent from an unclassified Yjs update.
- Asset preparation/verification is isolated under one restore attempt. The
  project, reducer metadata, full Yjs states, blob receipts, SyncGeneration activation,
  and activation receipt commit in one SQLite transaction. A failed validation
  or transaction leaves the target project absent and the staged SyncGeneration
  unbound. Native orphan cleanup owns residue if a process dies after a native
  rename and before the SQLite commit.
- Unknown protocol/payload/schema versions fail closed. Payload v1 remains
  restorable because it is part of the frozen public baseline; nothing
  upconverts one version into the other.
- Capture detects any missing KV/alias/Plot Grid/order authority and rejects
  the package. This is a corruption/data-loss guard, not a legacy
  compatibility path.

## Payload versions

Payload v1 stored the authored state and the whole receipt-backed journal as
one canonical CBOR value each. A real history of 42,091 change-sets exceeded
the 100,000-node canonical limit and bound every change-set ID in one SQL
statement, so capture failed. Payload v2 removes both bounds:

- Authored state and reducer state are sequences of canonical pages, each with
  its own hash and at most half the node limit. An authored table spans
  consecutive pages and always has at least one.
- Reducer pages hold, in fixed order: a header (identity, data-only reducer
  profile, maximum carried HLC, purge register), coverage, explicit receipts,
  every register family, conflicts, the carried journal rows and the frontier.
- Coverage is the applied frontier. Covered change-sets are applied
  contiguously and anchored by the frontier's segment heads, so they are not
  carried. Applied change-sets beyond the frontier keep explicit receipts.
- Only change-sets named by a register source or an explicit receipt are
  carried, with all their mutations and receipts. The rest of history stays in
  published segments.
- Validation accepts the reducer section only if coverage equals the package
  frontier, every receipt is a carried change-set beyond it with a matching
  signature, every carried change-set is covered or receipted, every register
  source is a carried mutation, the profile equals the local one, and the state
  has no purge or open conflict. Carried rows pass the same mutation-row
  checks as v1.
- Restore inserts the carried rows as `origin='remote'`, writes the implied
  metadata rows and installs the verified pages unchanged as the
  SyncGeneration's `sync_reducer_base`. Later rebuilds start from that base
  and replay only change-sets above its coverage. The reducer base is
  authoritative, not a cache; see the
  [materializer rules](phase1-sqlite-reducer-materializer.md#persistence-rules).
- A base-restored SyncGeneration lacks the covered history, so Drive-to-Hosted
  adoption, which rebases the complete journal, rejects it.

`changeSetCount` of a checkpoint counts the journal rows present locally: all
of them for v1, the carried ones after a v2 restore.

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
pnpm exec vitest run src/renderer/sync/checkpoint src/renderer/sync/reducer/state-pages.test.ts
```

The integration test uses the product baseline in real file-backed SQLite and
covers:

- snapshot-only, update-only, combined, and seed-only Yjs capture/restore;
- v2 compaction carrying only register sources and receipts beyond the
  frontier, restore as reducer base, a canonical state equal to the source, and
  a local write reduced on top of the base;
- payload v1 restore with its complete journal and no base;
- re-sealed compacted states with wrong coverage, a missing receipt, a missing
  register source, another profile or another identity;
- typed authored rows plus reducer ancestry/clock materialization;
- applied segment-head round-trip, fresh restore writer sequence/HLC anchoring,
  and source-history non-publication semantics;
- blob/package/`snapshot-commit` visibility ordering;
- missing and corrupt blobs, wrong ProjectSync identity, unknown version, and invalid Yjs;
- failure isolation: no project row and no staged sync-generation activation on failure.
- terminal project-purge reducer-state round-trip and post-restore non-resurrection.
- re-sealed packages with inconsistent mutation rows fail before activation,
  while valid source mutation rows round-trip exactly.

The machine-readable result is
[`acceptance/phase2-checkpoint-restore.json`](acceptance/phase2-checkpoint-restore.json).
That file is the historical Phase 2 record. The later mutation-row integrity
fix has separate [source-matched generated evidence](../apple-native/acceptance/checkpoint-mutation-integrity.json).
Its runner, `node scripts/apple-checkpoint-provenance-acceptance.mjs`, executes
the checkpoint, protocol and restore suites; `--check` verifies the recorded
source and required cases. The 13 re-sealed tamper cases and valid round-trip
cover mutation-row consistency, not complete validation of every reducer
register's target or clock semantics. That evidence predates payload v2 and
belongs to the paused Apple-native migration, so it is stale until that
migration resumes and refreshes it.
