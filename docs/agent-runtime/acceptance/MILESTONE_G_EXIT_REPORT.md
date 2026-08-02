# Milestone G exit report: user checkpoint, rewind, and fork

Status: **Completed**
Date: 2026-08-02

## Outcome

The General Agent now exposes an author-visible, provider-neutral checkpoint
system rather than relying on provider session history or local UI state.
Every requested turn begins behind a complete SQLite/Yjs capture barrier;
authors can create pinned restore points, preview manuscript changes, fork only
the conversation, or explicitly restore and continue in a new conversation.
Later author edits are never silently replaced.

The normative contract is
[`../checkpoint-rewind-protocol.md`](../checkpoint-rewind-protocol.md). The
machine evidence is
[`milestone-g-checkpoint.json`](milestone-g-checkpoint.json).

## Shipped

- Migration `0074_agent_user_checkpoint.sql` adds first-class checkpoint,
  captured-entity, action and ordered action-entity tables, plus durable
  conversation parent/fork identities.
- Automatic capture runs before provider/tool execution. Manual capture is
  pinned by default. Both enumerate product entities from SQLite, flush open
  live documents, hydrate closed documents, and deterministically seed prose
  that has never opened.
- Each checkpoint binds canonical provider-neutral history, through-turn and
  context hash, long-task plan/manifest, accepted write witnesses, visible
  transcript, entity metadata, Yjs revision/state vector/full state and
  canonical semantic content hash.
- Conversation rewind is non-destructive. It creates a new conversation with a
  source-parent and checkpoint identity, no borrowed runtime session, and a
  bounded checkpoint-context section in the next system prompt.
- Manuscript restore requires a persisted preview receipt, one-use token and
  explicit overwrite confirmation. All entities are compare-and-set checked
  before execution, before their individual writes, and once more before
  success is published.
- Whole-book/multi-entity restore is a durable saga. Exact pre-action Yjs and
  metadata snapshots are recorded before each mutation; later failure
  compensates in reverse order, and restart resumes interrupted compensation.
- Concurrent author edits win. A stale preview fails before writes; a mid-saga
  edit is preserved and surfaces `CHECKPOINT_RECOVERY_DIVERGED` rather than a
  false atomic-success claim.
- The Agent toolbar provides checkpoint count, manual save, pin/unpin, soft
  delete, conversation-only fork, semantic restore preview, and explicit
  restore-and-fork confirmation. Controls are disabled while an Agent turn is
  active.
- Capability schema v5 publishes the checkpoint contract and removes the old
  deferred checkpoint/rewind claim.

## Automated acceptance

Run:

```bash
pnpm --dir client eval:agent:checkpoint
```

Result:

- 6/6 required files discovered;
- 43/43 milestone tests passed;
- all seven named invariant assertions matched exactly once;
- TypeScript, scoped ESLint and generated capability drift checks passed;
- the complete product migration set opened in a real file-backed SQLite
  database with WAL/FULL durability;
- real Yjs state vectors/revisions covered complete capture and semantic COVER
  restore;
- conversation-only fork and restore-plus-fork replayed idempotently without
  modifying their source conversation;
- missing confirmation and post-preview author edits produced zero manuscript
  writes;
- injected failure on a later entity compensated all earlier entities;
- database close/reopen recovered an interrupted saga without overwriting the
  author's concurrent edit;
- fork context remained available outside the standing-memory 2k clamp.

The report's source-set hash is
`sha256:b255f6c7f0e41ab628c06501064518b3f4119159d4b6470e5ce46b6d70f3d045`.

Full Core regression after the implementation:

```bash
pnpm --dir client test
pnpm --dir client lint
```

Result: **127 files, 831/831 tests passed**. Full Core ESLint reported **0
errors** and 41 existing warnings; the new checkpoint surface adds no warning.

## Explicitly unverified here

- The checkpoint covers prose-bearing node, element, storyline and category
  identities plus restorable metadata. It deliberately does not infer deletion
  or recreation of structural graph identities; a missing captured identity
  fails closed.
- Native desktop/iOS/Android visual interaction and lifecycle acceptance remain
  Milestone J.
- Checkpoint safety and evidence continuity do not measure writing quality.
  Ambiguity, edit scope, voice, canon impact, semantic summary and whole-book QA
  are Milestone H.
- Live multi-provider conformance and concrete MCP transports/configuration are
  Milestone I.

Milestone H, writing intelligence, is now active.
