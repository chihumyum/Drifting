# Milestone E exit report: durable long-task execution

Status: **Completed**
Date: 2026-08-02

## Outcome

The General Agent can now carry an arbitrarily long, progressing writing task
across provider iterations, verified context compaction, multiple execution
slices, safe author stops, steering, and renderer/database restart without
silently skipping chapters or manufacturing completion. A plan persists across
restart; paid or mutating automatic execution does not. The author explicitly
reauthorizes it.

The normative state machine and invariants are in
[`../long-task-execution-protocol.md`](../long-task-execution-protocol.md). The
machine evidence is
[`milestone-e-long-task.json`](milestone-e-long-task.json).

## Shipped

- Whole-book creation transactionally verifies that the product-owned chapter
  snapshot still matches current SQLite before freezing it.
- Every plan read/continuation decision can distinguish added, missing, renamed,
  and reordered chapters by renderer-owned stable identity without leaking ids
  to the provider.
- `reconcile_manifest` performs one CAS/receipt transaction: it adds pending
  steps, updates names/order, retires removed unfinished steps as audit history,
  retains removed completed evidence, and reopens a restored retired identity.
- Migration `0073_agent_runtime_task_step_retired` adds the checked terminal
  `retired` state while preserving all existing rows and indexes.
- Whole-book completion fails with `TASK_MANIFEST_DRIFT` until reconciliation;
  then every current step still requires accepted exact-target write evidence.
- A pending legacy review blocks only its own step. Other runnable chapters
  continue. A blocked step becomes runnable only after its durable review state
  actually settles.
- Runtime task budgets remain unlimited by default. Two automatic slices with
  an unchanged durable work fingerprint pause a confused loop; task revision is
  excluded so metadata churn cannot fake progress.
- Stop revokes continuation and waits for the current tool boundary before
  preventing all later writes. Steer is journaled and applied exactly once at
  the next model iteration.
- Completed, failed, aborted, and budget-ended turns with an active same-session
  plan all expose manual Continue. Renderer restart reloads the plan but resets
  unattended continuation authorization.
- Product-generated continuation prompts are tagged in the canonical journal:
  the model retains them, while live and recovered author transcripts omit
  them.
- The generated capability inventory now records the executable long-task
  contract and checks it against actual unlimited runtime defaults/watchdog.

## Automated acceptance

Run:

```bash
pnpm --dir client eval:agent:long-task
```

Result:

- 10 required test files discovered;
- 110/110 milestone tests passed;
- all 13 named invariant assertions matched exactly once;
- every checked-in product migration through 0077 ran against real file-backed
  SQLite and reopened idempotently;
- injected command-receipt failure rolled back the complete manifest/step
  reconciliation;
- add/remove/rename/reorder/restore reconciled and survived database close/open;
- product composition covered live Yjs coordination plus pinned multi-turn plan
  context;
- safe Stop, exactly-once Steer, mixed review/runnable work, unlimited progressing
  slices, stagnation pause, terminal manual resume, and hidden continuation
  transcript recovery passed deterministically;
- TypeScript, targeted ESLint, and generated capability drift checks passed.

Full Core regression after the implementation:

```bash
pnpm --dir client test
```

Result: **121 files, 807/807 tests passed**. Workspace TypeScript passed for
both `client` and `private service`; full Core ESLint reported **0
errors** and 41 pre-existing warnings.

## Explicitly unverified here

- Literary compaction/retrieval quality on an entire real novel remains
  Milestone F; this milestone proves continuity and evidence preservation.
- User-facing manuscript checkpoints, rewind, and fork remain Milestone G.
- Live multi-provider behavior and concrete MCP transports remain Milestone I.
- Native desktop/iOS/Android lifecycle and 4h/12h endurance remain Milestone J.
- Headless product storage/control evidence does not replace native animation,
  gesture, or physical-device acceptance.

Milestone F, context engineering, is now active.
