# Canonical remote prose receive and replay

P4a adds a shared headless receive path for complete pure-prose originals in
existing active projects. It is the first synchronization integration batch;
Both native hosts now use the shared Swift delivery queue. Provider transport,
domain metadata application, accounts and full remote structural behavior remain
open.

## Ownership and transaction

`RemoteProseJournal` in `drifting-core` verifies the complete canonical envelope,
expected project/generation identity, every mutation, and the current owner
incarnation. Unsupported metadata or mixed envelopes are rejected whole. No
transport cursor or writer frontier advances in this slice. Authentication and
writer authorization remain the caller's responsibility; a valid hash is not
permission to write.

`drifting-prose::remote_sync::receive_remote_prose` supplies the mandatory Yrs
projector inside the same SQLite transaction. Each mutation loads the actual
snapshot and ordered tail, including earlier mutations in that transaction.
It checks a complete V1 frame while preserving the original bytes, and refuses
unresolved dependencies, required derived repairs and unrenderable projections.
It does not replace or publish into an open editor.

An accepted transaction stores the immutable original and all mutation rows,
remote revision/provenance, exact Yjs update, positive materialization receipt,
semantic cache, local HLC observation and apply receipt together. Remote receipt
does not consume the local writer sequence. Existing transaction owners use a
savepoint; only the caller's final COMMIT permits live notification. No schema
or published migration changes are introduced.

An already-processed original is verified against its stored envelope, all
mutation rows and apply receipt, then performs no semantic writes. Deduplication
survives covered-tail pruning and cold reopen. This status is not a promise that
the editor has replayed the bytes, nor a grant of semantic deletion authority;
it does not synthesize missing positive materialization evidence.

## Workspace replay

The bridge exposes `workspaceReceiveProse` (canonical original reference and
base64 envelope) and `workspaceReconcileProse` (project ID). After COMMIT, both
new and duplicate delivery reconcile **every open chapter in the project** via
its existing persist/replay/checkpoint owner. A duplicate for chapter A must
also repair an earlier missed notification for chapter B. The explicit reconcile
entry point supports a later synchronization pass without another packet.

Owners remain in place with their draft branches and local undo history.
Per-owner save or replay errors remain visible through `saveError`/`remoteBlock`
and retain the durable tail for retry. A successfully received original remains
committed even when subsequent live reconciliation fails. Closed chapters read
the durable snapshot/tail on their next open. The older `documentApplyRemote`
raw-update entry point remains a fixture seam, not a production receipt path.

## Bounded acceptance

Run `pnpm apple:remote-prose:acceptance`; verify the generated report with
`pnpm apple:remote-prose:check`. The source-matched
[report](acceptance/p4a-remote-prose.json) records four agreed groups:

1. Independent synthetic file-backed replicas exchange locally authored originals,
   converge in two open chapters, and keep remote edits through local undo.
2. Original identity deduplicates after checkpoint/prune and cold reopen, without
   additional revisions, mutation rows or receipts.
3. Committed-but-unnotified updates replay across all open owners, including
   remote N+1 followed by local N+2 and a missed update in another chapter.
4. Wrong scope or injected receipt failure rolls back the complete envelope and
   preserves the live owner, local history and active draft for retry.

The adapter additionally covers cumulative same-document mutations and complete
rollback when the second mutation has trailing bytes, unresolved dependencies or
an unsupported embedded value. The core verifies receipt faults and caller-owned
savepoints. These remain a bounded transaction and replay batch.

The TypeScript oracle runs the existing production decoder and
stage/reducer/complete transaction on a copy of the actual before database. It
compares ten tables, independent full Yjs state and semantic cache against the
Rust after database; duplicate delivery must perform zero SQL writes. Three
append wall-clock columns are validated as ISO timestamps but excluded from
exact equality, because the renderer stamps those writes from its own clock.
Raw synthetic databases and logs remain ignored; the report records their hashes.

## Native queue and owner delivery

`LabWorkspaceCore.receiveProse` and `reconcileProse` now route verified bridge
results to existing Swift owners by project/chapter scope and exact Rust handle.
A chapter without a store is loaded normally when next shown; delivery never
creates a new editor or revives a closed handle. Duplicate delivery routes every
returned owner, including inactive tabs and chapters other than the packet's
original target.

Workspace-owned `LabCore` instances share their workspace's serial ABI queue.
Requests and main-thread replies retain this order across chapters and remote
receipts. Immutable original fields and envelope bytes are captured before
queueing. An in-flight delivery prevents close/reopen owner transitions; it does
not suspend ordinary typing or marked-text composition. Failed receipt validation
returns an error without poisoning the input queue.

`DocumentStore` records the returned save/replay state and requests its normal
refresh. Existing queued jobs still use their original CRDT input branches.
Only a later authoritative `inputFork` can update the default displayed basis,
and bindings with marked or failed drafts retain their text, input key and
selection. Other bindings can display the accepted remote text immediately.
Save failure after an accepted original remains an existing owner retry state;
receipt completion must not be interpreted as every view having finished input
or saved its latest draft.

The [binding report](acceptance/p2b-binding.json) contains four AppKit groups;
the [native report](acceptance/p2b-native.json) records four hosted UIKit tests
on each selected simulator, alongside existing regressions. Their shared test
support reads real native-authored canonical originals from a separate synthetic
replica made from a closed database baseline. No test-only receive flag or raw
Yjs replacement stands in for the new receipt path.

The four native groups cover queued Unicode input and local-only undo; marked
commit/cancellation and retained failed input; all-owner duplicate/explicit
reconciliation; and wrong scope, receipt rollback, post-COMMIT checkpoint failure,
retry and cold reopen. The UIKit failed-input state is explicitly injected after
real UITextInput creates the draft; this tests retention rather than certifying
a new way to generate an input failure. To create a stale Swift view cache,
the hidden-owner case uses an existing lower-level native edit that commits
without notifying `DocumentStore`. The earlier Rust group independently proves
remote COMMIT with a missing live notification; these are separate layer-specific
checks, not interchangeable claims.

These are source, file-backed integration and programmatic native input results.
There is no physical-device, real-account or signed-distribution acceptance.
Injected transaction faults and cold reopen remain distinct from the separate
SIGKILL durability harness and from power-loss evidence. Known old-peer
alias-deletion and general structural gaps remain uncertified.

The [complete chapter receiver](remote-workspace-sync.md) now owns the first
metadata subset through the same canonical transaction. Google Drive provider
orchestration and snapshot bootstrap are deferred by the author's 2026-09-26
scope update; continue local writing and Agent workflows. Do not
filter unsupported metadata originals to skip ahead in a transport frontier.
