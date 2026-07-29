# P3 Exit Report — Crash-safe writes and reversible Yjs commands

## Identity

- phase: `P3`
- status: `accepted`
- runtimeSchemaVersion: `1`
- promptVersion: `1`
- promptSourceSha256: `6c41ebfdd703ad9ac8045e9d591b5e181c991c3807b7249dee920b234dee6b6e`
- toolCatalogSourceSha256: `eadd47df8b317a1aa8c7d7accae82c2885ae06d9d86fa62c54a6a9cfda713ad6`
- suiteSha256: `3dee12bc27d9e3706f2a90df8fc9347891001026a0643ed55e6c7fd2fa13259a`
- embeddedMigrationCount: `63`
- provider: `not applicable`
- model: `not applicable`

P3 was delivered in independently reviewable batches:

- `589e545ec19883430bdc92a334540d9ecf21cb7b` — preserve approval and memory provenance
- `77e80ecb6cabb9570f2b346316f5e2bd835570f7` — await live Yjs write durability
- `35309d29bcd53a6a020030d868380c7e9695ba80` — classify the canonical tool catalog
- `db9e78504f10fa604c3f6c8f092e654243321d0c` — prepare reversible Yjs prose commands
- `72fc72a34f1e8c5e72b24830818d01e722065339` — persist write effects and reviews
- `099ff0dee2c637ff9367b8ac070e607bd5857673` — certify reversible field writes
- `0e05b7251eda8ff4a5f0764aea22e6068ca23c49` — enforce the write-risk policy matrix
- `302e1179be0458c5395532cbfc9eee46390de4e5` — reconcile reviews after write commit
- `09402726b9cc81137bb2745946e622e74b6581dc` — reconcile committed write inverses
- `a07b420df4c5a936669c0ddb07f3e4700a190bda` — persist Yjs prose commands atomically
- `45a068c8c53841d9b638409fb9d9aa62205486f6` — certify P3 crash-safe writes

The hashes above identify the checked-in prompt, tool catalog, and aggregate P3
acceptance sources. No provider call is needed to prove the write boundary.

## Product result

The first provider-neutral write path now crosses the real renderer use-case
boundary and records enough canonical evidence to recover without guessing:

```text
ReaderWriterAgentRuntimeScheduler
  -> DriftingWriteToolRuntime
  -> canonical write-effect receipt
  -> runAgentTool
  -> renderer use case
  -> projection and durable outbox
  -> result_committed
  -> canonical soft review
```

`rename_node` and `set_node_summary` are the two provider-visible,
write-certified tools. Their delivery is idempotent, mutation entry is tracked,
and a duplicate delivery replays the canonical result without a second use-case
dispatch or outbox record.

Review creation is deliberately reconciled after the committed result receipt.
This ordering satisfies the real SQLite foreign key and makes a crash between
result and review recoverable. Accept/reject decisions become durable next-turn
feedback. Exact inverse rejection runs through the same renderer use case and
never overwrites a newer conflicting value.

## Catalog and policy gate

- general read tools: `18`
- general write tools: `34`
- Shadow-internal tools: `4`
- runtime-virtual tools: `1`
- write-certified product tools: `2`
- unavailable general writes: `32`

Unavailable, internal-only, or denied tools fail closed. Exact-inverse,
compensating, irreversible, and unavailable mutations have explicit policy
classes. Irreversible operations such as `delete_comment` and `delete_element`
require confirmation before execution and are never automatically retried.

## Deterministic write acceptance

- product write-path tests: `5 / 5`
- deterministic seeds: `100`
- operations per seed: `50`
- total mixed operations: `5,000`
- unique writes: `1,000`
- duplicate write deliveries: `1,000`
- reads: `3,000`
- renderer use-case dispatches: exactly `1,000`
- canonical effects: exactly `1,000`
- canonical reviews: exactly `1,000`
- durable outbox rows: exactly `1,000`
- duplicate effects or outbox rows: `0`
- project crossover: `0`

The suite injects failures before mutation preparation, between Yjs/projection/
outbox stages, after outbox but before the result receipt, and after an inverse
commit but before its review receipt.

## Yjs atomicity and reversal

Migration `0062_yjs_document_revision.sql` adds a monotonic document revision
that is independent of compacted update row IDs and a provider-neutral prose
command receipt.

`YjsProsePersistenceCoordinator` now supports live, closed, and seed documents.
It validates revision, state vector, and semantic hash before mutation, then
persists the Yjs update or snapshot, projection, outbox, and command receipt in
one SQLite transaction. On a live document, the committed origin is merged
without appending the update a second time.

Forward and exact-inverse commands are idempotent. Recovery recognizes an
already committed inverse from canonical state instead of replaying it; a
different newer value fails the guard. The real SQLite and `Y.Doc` integration
gate passed `3 files / 20 tests`.

## Real process-death gate

- crash markers: `4`
- seeds per marker: `20`
- cases: `80 / 80`
- real child-process `SIGKILL`: `80`
- recovery passes: `160`
- wrong recovery phase: `0`
- blind retries: `0`
- Yjs durability mismatches: `0`
- projection mismatches: `0`
- outbox mismatches: `0`
- partial Yjs updates: `0`
- foreign-key violations: `0`
- SQLite integrity failures: `0`
- non-idempotent recoveries: `0`
- recovery end-to-end p95: `44.83 ms`
- recovery end-to-end max: `45.32 ms`

The four acknowledged boundaries are before the transaction, after the
in-memory Yjs mutation but before projection, after projection but before
outbox while the transaction is open, and after the atomic commit but before
the runtime result receipt. Every case uses file-backed SQLite WAL with
`synchronous=FULL`, a real `Y.Doc`, a real `SIGKILL`, and two independent
recovery passes.

Sanitized result:
`docs/agent-runtime/acceptance/p3-write-summary.json`.

## Regression gates

- Core full test on the closing checkout: `68 files / 361 tests passed`
- Core TypeScript check: passed
- Core lint: `0 errors`; `42` pre-existing unrelated warnings remain
- embedded Rust migration compatibility/idempotency test: passed
- `git diff --check`: passed

The full-test count includes the already isolated P4 selector tests present in
the working tree during the closing run. They are not part of the P3 commits or
P3 acceptance claim.

## Manual signoff and open risks

- manualSignoff: `pending user smoke`
- Only `rename_node` and `set_node_summary` are product end-to-end
  write-certified in P3.
- The Yjs coordinator proves the atomic persistence primitive, but prose tools
  remain unavailable until their actual renderer handler/use-case path is wired
  and certified. The crash worker models that future transaction and does not
  claim provider-visible prose support.
- Review/revert actions are exposed programmatically and pass acceptance, but
  visible UI controls are not part of this phase.
- P4 owns durable read observations and expected-revision races, checkpoint
  compaction, and per-iteration tool-search integration.
