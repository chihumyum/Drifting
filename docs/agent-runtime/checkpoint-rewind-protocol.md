# Agent user checkpoint, rewind, and fork protocol

Updated: 2026-08-02

This document is the normative Milestone G contract. A user checkpoint is an
author-visible restore point. It is not the rolling
`agent_runtime_checkpoint` used by context compaction: runtime checkpoints may
be reduced to a verified digest, while user checkpoints retain the complete
payload required to preview, fork, and restore.

## Authority and capture boundary

- SQLite tables `agent_user_checkpoint` and
  `agent_user_checkpoint_entity` are the durable checkpoint authority.
- Live Yjs is the prose source of truth. An open editor's persistence queue is
  flushed before capture; a closed document is rehydrated from its SQLite
  snapshot and updates; a never-opened document is deterministically seeded
  from `contentJson`.
- An automatic checkpoint is captured before a requested Agent turn can start
  model or tool execution. The checkpoint therefore means “the project state
  before this request”, not an asynchronous approximation after it.
- A manual checkpoint is pinned by default. It uses the same capture path and
  cannot silently fall back to localStorage or a stale projection.
- A complete checkpoint binds the project and conversation to:
  canonical provider-neutral history, the through-turn ordinal and context
  hash, long-task plan/manifest state, accepted write-effect ids, visible chat
  messages, and every captured prose entity's Yjs revision, state vector,
  full state, semantic content hash, and restorable metadata.

The current manuscript scope is `node`, `element`, `storyline`, and `category`
bodies plus the metadata already covered by the entity time machine (names,
titles, summaries, writing status, aliases, groups, and KV fields). Destructive
structural deletion/recreation remains governed by its own Agent review and
domain-CRUD receipts; a checkpoint restore fails closed if one of its entities
no longer exists.

## Conversation rewind is a fork

Conversation rewind never truncates or reuses the source conversation's
runtime session. It creates a new `agent_conversation` row with:

- `parent_conversation_id` pointing to the preserved source conversation;
- `fork_checkpoint_id` pointing to the durable checkpoint;
- the checkpoint's visible transcript as the initial display history; and
- no runtime session id.

The new route starts a new provider-neutral runtime session. Its system prompt
receives a bounded, explicit checkpoint-context section built from the stored
canonical history, long-task state, and accepted-write witness. This avoids a
route-owner mismatch and never pretends historical tools were re-executed.

## Restore is preview then compare-and-set

There is no direct “restore this id” mutation API.

1. `preview` observes every checkpoint entity and durably writes an
   `agent_user_checkpoint_action` plus ordered entity rows.
2. The response returns a one-use deterministic preview token; only its
   SHA-256 digest is stored. The receipt expires after 15 minutes.
3. If any semantic content or metadata differs from the checkpoint, execution
   requires an explicit overwrite confirmation from the preview UI.
4. Immediately before execution, and again before each entity write, current
   state hash and metadata hash must match the preview witness. Any intervening
   author edit produces `CHECKPOINT_PREVIEW_STALE` before that entity is
   touched.
5. COVER restore authors a forward Yjs edit. Success is verified with canonical
   ProseMirror content hash plus metadata hash, not Yjs binary identity: two
   CRDT states can render identical prose while retaining different operation
   histories.
6. A final all-entity verification runs before success is published. Restore
   and fork then creates the new conversation in the same durable action
   completion transaction.

The source conversation and the pre-restore entity history remain available.
The UI never presents a destructive restore as an ordinary chat approval.

## Multi-entity intent and crash recovery

SQLite cannot make independent live Yjs documents one physical transaction.
Drifting therefore implements one durable saga:

- before each entity mutation, the action row receives its exact pre-action
  revision, state vector, state blob, semantic content hash, and metadata;
- after each verified mutation, its ordered step becomes `applied`;
- a later failure changes the action to `compensating` and restores applied
  steps in reverse order;
- renderer restart scans `applying` and `compensating` actions before hydrating
  Agent chat and continues compensation;
- a crash between mutation and receipt update is recognized when current
  semantic content equals the checkpoint target;
- compensation only overwrites an entity that still equals either the
  checkpoint result or the recorded pre-action state. A later author edit wins,
  the step becomes `failed`, and recovery reports
  `CHECKPOINT_RECOVERY_DIVERGED` instead of silently replacing it.

This provides atomic user intent under ordinary failures and deterministic
partial-failure cleanup. If an author deliberately edits the same entity during
the short restore interval, the author edit is preserved and the action fails
closed rather than claiming a false atomic success.

## Idempotency and retention

- Every preview/action has a unique idempotency key. Replaying a completed fork
  or restore returns its existing receipt and target conversation.
- Automatic `(conversation, source turn, kind)` capture is idempotent.
- Manual checkpoints are pinned by default. The product currently exposes
  explicit pin/unpin and soft delete; automatic-retention pruning is not yet
  enabled, so no checkpoint is silently discarded in Milestone G.

## Headless acceptance

Run:

```bash
pnpm --dir client eval:agent:checkpoint
```

The gate uses a real file-backed SQLite database with WAL/FULL durability and
real Yjs documents. It covers complete capture, semantic COVER restore,
conversation-only fork, idempotent replay, missing confirmation, stale preview,
multi-entity failure compensation, real database close/reopen recovery, system
prompt fork-context injection, typecheck, scoped lint, and generated capability
drift.

Native interaction and lifecycle behavior remains part of Milestone J. The
headless gate does not claim desktop/iOS/Android visual acceptance.
