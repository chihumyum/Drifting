# Milestone G retirement report: Agent checkpoint and fork

Status: **Removed**
Date: 2026-08-02

## Decision

The author-visible Agent checkpoint, manuscript rewind and conversation-fork
feature was removed after product review. Drifting already has entity snapshot
history independent of Agent sessions. The second checkpoint system added a
blocking whole-workspace capture before every turn and persisted conversation
parent/fork state that works against future multi-session isolation.

## Removed

- toolbar checkpoint/fork UI and all related locale copy;
- automatic and manual Agent checkpoint capture;
- conversation-only fork and restore-and-fork flows;
- checkpoint context injection into new model sessions;
- checkpoint preview, compare-and-set restore and compensation services;
- four `agent_user_checkpoint*` SQLite tables;
- `fork_checkpoint_id` and `parent_conversation_id` chat columns;
- the unused localStorage legacy whole-turn checkpoint/revert path;
- Milestone G acceptance command, tests and generated capability contract.

Migration history is append-only: `0074_agent_user_checkpoint.sql` remains as
historical evidence, while `0077_remove_agent_user_checkpoint.sql` removes the
feature's persisted schema. The renderer also clears the retired
`agent-turn-checkpoints` localStorage payload when Agent chat loads.

## Retained

- entity snapshot history and restore for chapters, drifts, elements,
  storylines and categories;
- current-state Yjs snapshots/updates used by sync and persistence;
- internal Agent runtime commit/context checkpoints used for crash recovery and
  compaction;
- durable write review with block-level accept/reject and guarded inverse;
- ordinary destructive-operation approval and domain write receipts.

The current snapshot contract is
[`../entity-snapshot-history.md`](../entity-snapshot-history.md). The retired
protocol tombstone is
[`../checkpoint-rewind-protocol.md`](../checkpoint-rewind-protocol.md).

## Verification

- the complete 78-migration product chain through
  `0077_remove_agent_user_checkpoint` passes on a fresh database and reopen;
- the migration assertion proves all four Agent checkpoint tables and both
  conversation branch columns are absent while `entity_snapshot_history`
  remains;
- capability generation, targeted Agent/store/snapshot tests, domain CRUD,
  long-task, writing-policy and P5 acceptance all pass;
- Core typecheck and ESLint complete without errors; and
- the controlled full Core run passes 133 test files and 855 tests.
