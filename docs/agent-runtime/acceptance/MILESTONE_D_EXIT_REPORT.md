# Milestone D exit report: domain CRUD closure

Status: **Completed**
Date: 2026-08-02

## Outcome

The General Agent can now create, read, update, delete, and exactly revert the
complete first-class writing domain through six natural workspace verbs. The
model works with chapters, drifts, elements, categories, storylines, comments,
TODOs, relations, storyline membership, project facts, and writing memory as
named project resources; SQLite ids, Yjs snapshots, receipts, and sync outbox
mechanics remain inside the renderer runtime.

The normative transaction, authority, trust, and approval protocol is in
[`../domain-crud-transaction-protocol.md`](../domain-crud-transaction-protocol.md).
The machine evidence is
[`milestone-d-domain-crud.json`](milestone-d-domain-crud.json).

## Shipped

- The workspace facade now resolves 25 hidden domain operations behind
  `list_files`, `read_file`, `grep`, `edit_file`, `write_file`, and
  `delete_file`.
- A generated nine-domain lifecycle matrix records every create/read/update/
  delete/revert path and proves every hidden mutation has a strategy in the
  final product composition.
- Migration `0072_agent_runtime_domain_crud` extends the immutable typed receipt
  ledger and provenance trigger for storyline-membership and memory commands.
- Storyline membership is a complete-graph replacement transaction. It
  enforces one primary storyline per chapter, writes all changed sync rows and
  one typed receipt atomically, refreshes renderer mappings only after commit,
  and restores the exact graph on inverse.
- Agent memory is exposed as natural JSON resources. Create is deterministic
  and pending, active guidance is read-only, evolution uses a pending
  `supersedesId` proposal, deletion is soft and confirm-before, and every step
  is sync-outboxed and exactly invertible while lineage is current.
- Structural nodes, elements, storylines, and categories have complete
  directory-resource create/update/delete/revert paths. Deleting a field file
  can no longer accidentally delete the complete entity.
- Comments/TODOs and entity relations have natural JSON CRUD, name-based target
  resolution, transactional ownership checks, typed receipts, and guarded
  inverses.
- Relation and membership changes are confirm-before. Ordinary metadata,
  comments/TODOs, and pending memory proposals remain automatic. Prose keeps
  the Milestone C write-first inline review path.
- Read freshness now covers the complete membership graph and complete memory
  set. Stale citations fail closed before mutation.
- A committed inner transaction whose outer acknowledgement is lost is
  reconstructed from its immutable receipt exactly once after retry and after a
  file reopen.

## Automated acceptance

Run:

```bash
pnpm --dir client eval:agent:crud
```

Result:

- 9 required test files discovered;
- 50/50 milestone tests passed;
- all 17 named invariant assertions matched exactly once;
- all product migrations, including 0072, ran against real file-backed SQLite;
- real product Yjs coordination covered prose-owning workspace resources;
- injected transaction failure left no graph, receipt, or outbox partial state;
- injected lost outer acknowledgement recovered without duplicate memory,
  receipt, effect, or sync mutation;
- database close/reopen retained the exact committed state;
- TypeScript, targeted ESLint, and generated capability drift checks passed.

Full Core regression after the implementation:

```bash
pnpm --dir client test
```

Result: **121 files, 801/801 tests passed**.

## Explicitly unverified here

- Exact per-command inverse is an internal safety primitive, not yet a
  user-facing checkpoint, manuscript rewind, or fork surface. That remains
  Milestone G.
- File/process restart and deterministic transaction faults are covered;
  desktop/iOS/Android lifecycle and physical-device storage behavior remain
  Milestone J.
- The local sync outbox and server memory schema/routes are present, but a real
  two-device network convergence run remains part of native/endurance
  acceptance.
- Provider network behavior is not needed to prove domain transactions.
  Multi-provider live conformance remains Milestone I.
- Native inline animation appearance remains a visual/device acceptance item;
  deterministic review direction and state were closed in Milestone C.

Milestone E, long-task execution, is now active.
