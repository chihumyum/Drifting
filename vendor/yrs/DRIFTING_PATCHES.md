# Yrs 0.28.0, MIT, three correctness patches and one test-only patch

This is the published crates.io source, including its upstream authors and MIT
license. `UPSTREAM.json` records the original archive checksum and file hashes.
The license is retained from the upstream repository. Production changes are limited
to `src/store.rs`, `src/undo.rs` and `src/transaction.rs`. `src/sync/awareness.rs`
also has a test-only clock injection. Regenerate patch hashes
with `node scripts/generate-yrs-provenance.mjs`; all other upstream file hashes
must match. Do not format or modernize the vendored source as incidental work.

`Store::follow_redone` originally followed an item's `redone` ID without carrying
the requested position's offset within that item. After undoing a text deletion,
anchors into its interior could resolve at the restored span's start. The patch
adds `ItemSlice.start` to each redone clock, matching Yjs `followRedone`.

The native document suite reproduces this with a split containing an emoji,
then checks the original anchor after undo. Cross-language and upstream Yrs
tests accompany it. Keep the patch until a released upstream version passes
the same regression; do not remove the failing-anchor assertion to upgrade.
No issue, pull request or other message has been sent upstream by this task.

These patches do **not** enable v2 output. The separate binary-array v2 emission
failure remains guarded by the native v1-only writer.

`TransactionMut::apply_update` originally retried pending dependencies only
when a client's largest clock advanced. Sparse integration can first insert a
later independent item, then fill an earlier hole without increasing that clock.
The pending dependency was left unapplied even after every update arrived.
The second patch also retries when the skip set changes. Each recursive call
captures its own skip set, so an unchanged unresolved dependency does not keep
triggering replay. No update is discarded or acknowledged by this check.

Three deterministic native regressions cover all arrival orders, checkpoints,
multiple holes, duplicate/empty updates, pending deletes and subsequent history.
The cross-language suite checks real XML prose with Yjs in both input encodings.
The generated `docs/apple-native/acceptance/yrs-random-array-diagnostic.json`
also preserves an unpatched upstream nested-array failure and requires all 100
patched fixed-seed stress runs to pass. Baseline and patched Cargo artifacts are
isolated. Keep all patches until a released version passes these regressions;
neither the fixed tests nor the stress sample is a full native migration gate.

`UndoManager::try_process` had a commented deletion-filter placeholder. Unlike
Yjs and the old editor's collaboration plugin, it always deleted parent nodes
when undoing their creation, even if remote text remained inside. The third
patch adds an opt-in callback (default behavior unchanged), wired to both
blocking and asynchronous history. It runs children before parents and exposes
read-only content, parent, map key and parent-deletion membership. The native
owner uses this to preserve nonempty XML/text parents and their attributes;
ordinary attribute undo on pre-existing nodes still runs normally. A dedicated
upstream regression exercises both entry points. Native/Yjs tests cover the
actual application policy, stable IDs, formatting, history, selections and
checkpoint/restart. No public update or document encoding is changed.

`awareness_summary` compares full client states, including each peer's local
`last_updated` timestamp. Separate system-clock reads can cross a millisecond
boundary; local removal also keeps its preceding timestamp while receiving that
removal stamps the remote state again. The test-only patch supplies the same fixed
clock through the existing `Awareness::with_clock` API for both peers. All original
assertions remain. Production awareness behavior and wire encoding are unchanged.
