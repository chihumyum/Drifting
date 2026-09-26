# Yrs 0.28.0, MIT, three correctness patches and one test-only patch

This is the published crates.io source, including its upstream authors and MIT
license. `UPSTREAM.json` records the original archive checksum and file hashes.
The license is retained from the upstream repository. Production changes are limited
to `src/store.rs`, `src/undo.rs`, `src/transaction.rs` and `src/block_store.rs`
(the last two form one patch). `src/sync/awareness.rs`
also has a test-only clock injection. Regenerate patch hashes
with `node scripts/generate-yrs-provenance.mjs`; all other upstream file hashes
must match. Do not format or modernize the vendored source as incidental work.

## Upstream status and exit plan

This vendored copy is temporary. The native core uses these local patches until
a published Yrs release contains the fixes, then switches back to the official
crate. Submitted on 2026-09-26:

| Local patch | Upstream |
| --- | --- |
| `src/store.rs` redone offset | [issue #669](https://github.com/y-crdt/y-crdt/issues/669), [PR #671](https://github.com/y-crdt/y-crdt/pull/671) |
| `src/block_store.rs` + `src/transaction.rs` sparse replay, `src/sync/awareness.rs` test clock | [issue #670](https://github.com/y-crdt/y-crdt/issues/670), [PR #672](https://github.com/y-crdt/y-crdt/pull/672) |
| `src/undo.rs` deletion filter | Not submitted; the API shape needs upstream discussion first |

The upstream PRs have the same production behavior, rustfmt formatting and added
Yrs-level regression tests. The deletion filter is an app-shaped local API
(`crates/drifting-document/src/undo_policy.rs` uses `DeleteFilterItem`); an
upstream version must also set the new option in `ywasm`, whose `Options`
literal otherwise fails to compile.

When a release contains a fix, check its merged form against the native
regressions below, then upgrade and drop that patch; if other patches remain,
re-vendor the new release and regenerate `UPSTREAM.json`. Once no patch is
needed, point `crates/drifting-document/Cargo.toml` at the crates.io release and
retire `vendor/yrs` with its provenance checks and notices. The deletion filter
must land upstream, or the native undo policy must move to whatever API
upstream accepts, before the vendored copy can be removed entirely.

`Store::follow_redone` originally followed an item's `redone` ID without carrying
the requested position's offset within that item. After undoing a text deletion,
anchors into its interior could resolve at the restored span's start. The patch
adds `ItemSlice.start` to each redone clock, matching Yjs `followRedone`.

The native document suite reproduces this with a split containing an emoji,
then checks the original anchor after undo. Cross-language tests accompany it,
and PR #671 adds a Yrs-level regression. Keep the patch until a released
upstream version passes the same regression; do not remove the failing-anchor
assertion to upgrade.

These patches do **not** enable v2 output. The separate binary-array v2 emission
failure remains guarded by the native v1-only writer.

`TransactionMut::apply_update` originally retried pending dependencies only
when a client's largest clock advanced. Sparse integration can first insert a
later independent item, then fill an earlier hole without increasing that clock.
The pending dependency was left unapplied even after every update arrived
(pending `missing` records the dependency client's clock at stash time).
The second patch adds a `BlockStore::skip_fills` counter, incremented only where
an integrated block replaces a skip, and also retries when it changes. Adding a
new hole does not trigger replay, and no skip set is copied per update. Each
recursive call captures its own counter value, so an unchanged unresolved
dependency does not keep triggering replay. No update is discarded or
acknowledged by this check. The published `PendingUpdate` shape is unchanged.

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
