# Durable long-task execution protocol

Status: normative for Milestone E and later
Updated: 2026-10-31

This protocol defines how one Drifting Agent carries a writing task across
model iterations, context compaction, budget slices, author steering, safe
stops, renderer reloads, and changes to the book structure. It governs runtime
orchestration only. Manuscript prose remains authoritative in live Yjs;
project structure remains authoritative in SQLite.

## Product promises

1. A task has no aggregate model-iteration, tool-call, token, cost, duration,
   or automatic-slice quota by default. Provider context windows still require
   finite per-call output limits and verified compaction.
2. Automatic continuation is authorized by an author action for the current
   renderer lifetime only. A renderer/App restart preserves the plan but never
   restarts paid or mutating work unattended.
3. Stop means: do not schedule another tool; let the currently entered tool
   reach its durable boundary, then terminate the turn. Already committed
   effects remain governed by their receipts.
4. A running-turn correction is steering. It is journaled once and appended as
   a user model message exactly once at the next model boundary.
5. Product-generated continuation prompts enter canonical model history but
   never appear as author messages in the composer or recovered transcript.
6. A task can complete only from current structural scope and evidence matching
   its immutable `workKind`. Edit work requires accepted exact-target writes;
   review work requires exact current reads plus fully cited structured review
   results. Old snapshots, prose claims, provider-supplied receipt handles and
   task revision alone are not completion evidence.

The machine-readable form lives in `AGENT_LONG_TASK_EXECUTION_CONTRACT` and is
included in `acceptance/agent-capabilities.json`.

## Durable state

`agent_runtime_task` owns objective, explicit scope kind, immutable `work_kind`,
open/terminal status, and compare-and-set revision. `agent_runtime_task_step`
owns ordered work units, named targets, execution status, result note/reference,
structured review result, product-bound read evidence, and timestamps.
`agent_runtime_task_constraint` owns active author/Agent/runtime constraints.
`agent_runtime_task_chapter_manifest` freezes the canonical active chapter
identity, name, and reading order for a whole-book plan. Every mutation also
writes one `agent_runtime_task_command` exactly-once receipt in the same SQLite
transaction.

Step states are:

- `pending`: current target has not entered execution;
- `in_progress`: the sole actively executed unit;
- `blocked`: waiting for evidence or a real external condition;
- `completed`: the task's work-kind-specific exact-target evidence exists;
- `failed`: the unit ended unsuccessfully;
- `retired`: historical target was removed by explicit manifest
  reconciliation. This is audit history, never a claim that work completed.

At most one step is `in_progress`. Marking the current `in_progress` step
`in_progress` again (typical after a resumed slice) is an accepted restatement
that keeps its `startedAt`, not an `INVALID_STEP_TRANSITION`. `completed`,
`failed`, and `retired` carry a terminal timestamp. The model cannot set
`retired`; only the renderer-owned manifest transaction can.

## Frozen manifest and reconciliation

Whole-book plan creation captures the canonical non-deleted SQLite chapters in
reading order and derives exactly one step per chapter inside the runtime. The
provider supplies neither chapter ids nor its own enumeration. Creation fails
with `TASK_MANIFEST_DRIFT` if the product snapshot changed before the command
transaction began.

Every plan read and terminal continuation decision compares the frozen
manifest with current SQLite state by stable chapter identity:

- new identity: `added`;
- absent frozen identity: `missing`;
- same identity with another title: `renamed`;
- same identity at another ordinal: `reordered`.

Any difference yields `chapterManifestState.status=drifted`. Final completion
then fails closed. The Agent must call `update_task_plan` with
`operation=reconcile_manifest`, the task id, and current expected revision.
The product, not the provider, rereads the canonical manifest.

One immediate SQLite transaction then:

1. moves current chapter steps into current reading order;
2. updates renamed target names without discarding completed evidence;
3. creates `pending` steps for added chapters;
4. changes unfinished removed steps to `retired` while retaining them after the
   current manifest as audit history;
5. retains removed `completed` steps as completed history;
6. reopens a restored `retired` identity as clean `pending` work;
7. replaces the frozen manifest, increments task revision, and commits its
   command receipt.

If any row or receipt write fails, all step/manifest changes roll back. An
empty active book cannot be reconciled into a false whole-book completion.

## Completion and review evidence

For a whole-book task, every current manifest entry must map to one non-retired
chapter step. Historical extra steps may only be `completed` or `retired`.
Every current step must be `completed`, its evidence must match the immutable
task `workKind`, and the current manifest comparison must be `current`. Only
then may task status become `completed`.

For `workKind=edit`, `resultRef` must resolve to accepted or automatically
authorized durable write evidence for that exact target. The provider omits
`resultRef`; Drifting binds the newest write no other step has claimed, and
each write completes at most one step. A write counts for its own object and
for the objects it is anchored to: an element change for the chapter it names
as its source chapter, a relation for both ends. Eligible writes start when the
author request that created the checklist began, so a checklist created in a
later automatic-continuation slice adopts writes an earlier slice of the same
request saved; a new author request starts afresh. When nothing qualifies, the
error names the step's target and the saved changes no step has claimed, asks
for one more change to or anchored to that target, and keeps `append_steps` for
work that belongs to other objects. `append_steps` names every requested step it
merged into an existing step with the same target instead of adding it. Once a
checklist has completed or failed, `read_task_plan` and every update say so with
its final progress and tell the Agent to stop updating it.

For `workKind=review`,
the provider omits `resultRef`, reads the exact target first, and submits a
structured `reviewResult`. The renderer locates the latest target read,
verifies its content hash and pagination receipts, validates every claim and
finding quote against the exact source, and binds its own evidence ref. Wrong
targets, forged quotes, incomplete pages and provider-invented refs fail and
roll the step command back. The verified evidence reconstructs after restart.

A write whose settlement receipt is still unsettled blocks only its own step.
Independent pending or in-progress steps remain runnable. A blocked step
becomes actionable again only when its durable receipt is settled; missing
evidence is not runnable.

## Continuation state machine

The per-slice model-iteration cap (50 by default in product settings) is a
checkpoint boundary, not a tool failure. The final allowed iteration keeps its
normal authorized tools. If work still needs another iteration, the runtime
checkpoints the completed tool results and ends the slice without a tool-free
model summary. The renderer records **Progress saved** in the usage row and
shows **Progress saved. Preparing to continue…** while checking the plan, then
**Progress saved. Continuing…** only once the scheduler has queued continuation.
Paused, stopped and failed states never promise automatic work.
Both desktop and mobile render this host-owned status; it is not a fabricated
assistant message and never becomes provider history. Canonical replay and
portable conversation display retain the saved-progress marker. Actual tool,
provider and durability errors remain errors. Explicit token-budget summaries
still explain the slice boundary without suggesting that tools are unavailable.

The durable plan and renderer-lifetime continuation authorization are separate:

```text
author turn -> armed -> terminal -> evaluate durable plan
                               |-> runnable/reconcile/finalize -> next slice
                               |-> user/permission/no actionable work -> paused
                               |-> two stagnant auto slices -> paused
                               |-> task terminal -> off
```

The progress watchdog fingerprints actual task status, manifest identity/order,
step status, result reference, review outcome, and the number of project writes
the session has committed since the task began (`agent_runtime_write_effect`
rows in `result_committed`, excluding task-plan and Working Memory
bookkeeping). Task `revision` is excluded: renaming an objective or touching
unrelated metadata cannot masquerade as work. Two automatic slices with the same
durable fingerprint pause the sequence. Any real durable progress resets the
counter, including a model that saves chapter after chapter without ticking its
checklist; failed or declined writes never commit and still count as stagnant.
This is a loop-safety rule, not a work quota; a progressing task can run for
arbitrarily many slices.

Mixed state is handled deliberately: if one step waits for its receipt to
settle and another is runnable, continuation schedules the runnable work. It
pauses with `no_actionable_work` only when no independent work, manifest
reconciliation, or finalization remains.

## Author controls and restart

- **补充 / Steer:** journal now, apply exactly once at the next model
  iteration. It does not interrupt or replay the currently executing tool.
- **停止 / Stop:** revoke automatic continuation immediately, wait for the
  current tool's safe boundary, synthesize no later write, and leave an active
  durable plan manually resumable.
- **Continue:** a fresh author action can resume an active same-session plan
  after completed, aborted, failed, or budget-exceeded terminal turns.
- **Restart:** canonical SQLite plan/context/journal reload first. Automatic
  authorization resets to `off`; the user explicitly resumes. Recovered
  continuation instructions stay invisible in the author transcript.

Permission and `ask_user` waits pause automatic continuation. A recovered wait
whose original JavaScript stack is gone may be inspected or safely cancelled,
but is never falsely resumed in place.

A turn outlives the workspace view that started it. Workspace render failures
are caught by a boundary inside `ProjectRuntimeProvider`, below the Agent tool
bridge and runtime, so an editor crash shows its retry screen without
unmounting the tools a running turn calls next. If the tools do disappear (the
app-level boundary), the failure names the cause instead of a bare
canonical-name error. The panel never keeps a turn the transport has released:
every effect of an accepted terminal delivery runs even when an earlier one
throws, and when Stop or 补充 answers `AGENT_CONTROL_NOT_ACTIVE` for a turn whose
`turn_started` was seen, the run is rebuilt from the durable session and journal
(the record a restart reads). Before `turn_started` the turn may still be in
preflight, so that answer is reported and the turn is kept. A request the
provider rejects (HTTP 4xx) reports OpenAI's identifier fields (`type`,
`param`, `code`) through the native transport, never provider prose.

## Context and compaction

The plan, active constraints, current manifest state, the single next
actionable step (`AGENT_LONG_TASK_PINNED_STEP_LIMIT = 1`), and durable command
coverage are semantic-pinned context rows. Every other step stays pageable
through `read_task_plan`. Internal SQLite/chapter ids are
removed from provider projections. Compaction may summarize ordinary history;
it cannot discard these pinned continuity facts or work-kind-specific accepted
write/verified-read evidence.

Milestone E proves preservation and scheduling, not literary summary quality.
Long-book retrieval, literary compaction faithfulness, constraint confirmation,
and artifact budgeting are Milestone F.

## Automated acceptance

Run:

```bash
pnpm eval:agent:long-task
```

The gate covers the current product SQLite baseline, command-receipt rollback,
manifest mutation/reconciliation, close/reopen, product Yjs composition,
multi-turn pinned context, mixed receipt state, unlimited progressing work,
committed writes as progress, stagnation pause, safe stop, exact steering,
terminal manual resume, hidden continuation prompts, turns surviving a crashed
workspace view, released-turn reconciliation, TypeScript, targeted ESLint, and
generated capability drift. It writes `acceptance/milestone-e-long-task.json`.

This does not claim native desktop/iOS/Android lifecycle acceptance, live
multi-provider conformance or literary compaction quality. Agent conversation
checkpoint/fork UI was subsequently implemented and then removed; long-task
continuity remains session-local durable runtime state.

Milestone H extends this execution state machine with read-only whole-book QA.
Run `pnpm eval:agent:writing` for the cited review,
forged-quote, rollback and restart matrix.
