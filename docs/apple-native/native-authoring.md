# Native command capture and durable originals

The shared document and prose crates now retain actual native command records
through journal persistence. Both NativeLab hosts enter this path through the
same Rust bridge. Published SQLite migrations are unchanged; appended migration
`0004_yjs_materialization_admission` records positive local append facts.

For a supported contiguous plain-text deletion, the public native replacement
command captures its live pre-transaction snapshot, original selected item IDs,
UTF-16 range and exact transaction event. Queued input and composition drafts
rebind surviving selected IDs to the live document. A remote insertion splitting
that selection prevents a single-range declaration; the actual edit remains a
raw event and does not delete the intervening remote text. Insertions,
replacements, structure, formatting and undo do not acquire deletion intent.
The capture type is opaque: callers cannot deserialize an arbitrary declaration
into a trusted native command record.

`DurableDocument` stores complete records until its SQLite transaction commits.
A rejected declaration, receipt failure or failed projection rolls back the
whole batch without consuming writer sequences. Later input does not discard
the failed record, and retry uses the same captured basis. The optional journal
supplement preserves exact event bytes and the default payload golden remains
unchanged. Original verification accepts legal Yjs/Yrs delete-client orderings
while continuing to reject malformed, duplicate and trailing event data.

The owner binds project, synchronization identity, generation, document and
incarnation when opening. Scope verification and document loading share one
SQLite snapshot; persistence, replay and checkpointing recheck that identity.
Changing incarnation before or during a write refuses it while retaining the
record. An unscoped owner cannot bind previously captured deletion evidence to
a new incarnation at save time. NativeLab reads its current synthetic scope
through the same shared-core guard.

The generated [authoring report](acceptance/native-authoring.json) covers 238
Rust tests: 61 core, 132 document, 27 prose and 18 bridge, plus 80 renderer
transaction, journal, reducer and Agent checks. It also checks three actual
journal wire cases and four actual native persistence wire cases with production
TypeScript/Yjs decoding, normal library builds, formatting and strict TypeScript.
The separate [original report](acceptance/original-operation.json) checks the
61 core cases on Rust 1.88; the document/native owner requires Rust 1.96.
The [durability report](acceptance/p2c-durability.json) covers 23 real SIGKILL
boundaries and 46 independent cold restarts, including five actual native
deletion boundaries. Termination before COMMIT correctly leaves no durable
deletion declaration; it does not promise recovery of an uncommitted editor buffer.

```sh
pnpm apple:authoring:acceptance
pnpm apple:authoring:check
pnpm apple:durability:acceptance
pnpm apple:durability:check
```

Both shared-core and renderer journals now record positive materialization in
the actual append transaction. Processing an original without writing prose
does not create this receipt. Each receipt binds its exact original, mutation,
event, raw row and revision, remains after raw compaction, and is excluded from
portable domain checkpoints. Old data is not backfilled with guessed admission.
Renderer append tokens require the innermost active transaction; rolled-back
savepoints cannot lend a reused row ID to another original. Local batches
validate the complete original once, retain per-append checks, and roll back
together if any receipt fails. The remote single-append path remains separate.

These reports certify command capture and durable originals, not receiver
authorization or semantic relocation. The authority owner remains an isolated
prototype. It now also supports explicit cold recovery of an already-applied
original with one exact uncovered tail row; generic tail recovery and hot-session
publication remain open. Its positive-admission replacement now refuses the
actual suppressed-command/equal-byte counterexample without database writes;
three real renderer positive databases still recover and pass independent Yjs
comparison. The semantic receiver remains isolated. See the
[receiver investigation](relocation-design.md).
General incoming recovery, multiple relocation graphs, capability rollout and the
six bare-packet deletion failures remain open. No physical IME, device, account,
power-loss or signed-distribution acceptance follows from these reports; P2
remains in progress.
