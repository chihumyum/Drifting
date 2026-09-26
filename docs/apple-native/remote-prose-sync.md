# Canonical remote prose receive and replay

P4a adds a shared headless receive path for complete pure-prose originals in
existing active projects. It is the first synchronization integration batch;
provider transport, domain metadata application, Swift delivery, accounts and
full remote structural behavior remain open.

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

These are source and file-backed integration results. Existing native binding
and simulator regressions are reported separately. This batch provides no
Swift remote-delivery, physical-device, real-account or signed-distribution
acceptance. Its injected transaction faults and cold reopen are distinct from
the separate SIGKILL durability harness and from power-loss evidence. Known
old-peer alias-deletion and general structural gaps remain uncertified.

Next wire this receive/reconcile path through the shared native queue and
workspace state before adding provider orchestration. Do not filter unsupported
metadata originals to skip ahead in a transport frontier.
