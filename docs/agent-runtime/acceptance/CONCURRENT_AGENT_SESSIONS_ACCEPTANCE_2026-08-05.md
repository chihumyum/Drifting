# Concurrent General Agent sessions acceptance — 2026-08-05

Status: **implemented for deterministic same-project execution plus an isolated paid DeepSeek canary; native interaction remains E4**

## Scope

The single General Agent product imposes no numeric admission cap on active
turns across independent conversations in the currently mounted project. A
conversation still owns at most one active turn. Provider, network, memory or
OS resource failure is isolated to the affected execution as far as the host
allows; it is not converted into a product-level concurrency ceiling. This
milestone does not keep turns running across project switches and does not
replay an in-flight provider request after App restart; durable plans remain
available for explicit manual resume.

## Local Claude Code study

The locally installed Claude Code `2.1.220` exposes independent session
identity and lifecycle through `--session-id`, `--resume`, `--fork-session`,
`--background`, `claude agents`, and optional `--worktree`. The installed VS
Code extension keeps session panels, channels and abort controllers in maps
rather than one global current request. The transferable control-plane pattern
is therefore separate session/channel ownership plus precise cancellation;
worktrees are an optional stronger filesystem isolation mechanism, not a
requirement for every concurrent session.

Drifting adopts that control-plane pattern without copying Claude Code's
process/worktree boundary. The current Tauri renderer has one mounted project
tool context, and Drifting prose already has a live Yjs authority, so the
supported boundary is concurrent conversations inside that project.

## Executable contract

- `LocalGeneralAgentTransport` owns active turns by turn ID and route key.
  Different conversation routes may overlap; a duplicate active route fails
  closed, but there is no cross-conversation count check or admission queue.
- Abort, stop-after-tool, steering, permission and required-input responses are
  routed to the exact session/turn. An unscoped abort is rejected while more
  than one turn is active.
- The chat store, activity projection and write-rejection feedback are keyed by
  conversation/session/turn rather than a global running turn. Deleting,
  stopping or finishing one conversation cannot clear a sibling's state.
- Reads may execute concurrently. Every General Agent runtime instance shares
  the renderer reader/writer scheduler, so writes serialize against other
  writes and exclude overlapping reads only at the durable write boundary.
- Agent prose transactions carry a persisted Yjs collaborator origin with
  `sessionId`, `turnId` and `callId`. Deterministic Yjs client identity and the
  existing revision/state-vector/hash checks remain authoritative.
- Every Yjs generation also writes a non-compactable revision-provenance row in
  the same SQLite transaction. General Agent writes retain exact
  session/turn/call identity; local editor changes are `user`; remote sync,
  deterministic system normalization and migrated legacy revisions remain
  separately named and are never guessed to be user edits.
- Agents observe sibling work through shared committed truth, not through each
  other's private planning. Once a sibling commits, a fresh authored-object
  read sees that Yjs/SQLite state. An already-started stale writer receives a
  semantic revision conflict attributed as `self`, `other-agent`, `user`,
  `mixed` or `external-or-unknown`, rereads the target and reconciles the
  remaining request against the new current state. `self` explicitly warns
  that the earlier write may already have succeeded rather than failed.
- CRDT merge is not treated as semantic conflict resolution. If a target
  changes after an Agent read, the stale write fails. The Agent may reread and
  reconcile once; a second conflict on that session/turn/target blocks further
  writes to the target for the rest of the turn. Independent targets and
  sibling sessions continue.
- Durable effect replay happens before collaboration target resolution. A
  previously committed effect therefore remains idempotent even if another
  conversation later renames or deletes the target.

The generated
[`agent-capabilities.md`](agent-capabilities.md) and
[`agent-capabilities.json`](agent-capabilities.json) publish the same limits and
scheduling/conflict contract from
`agent-concurrency-contract.ts`.

## Automated evidence

The focused concurrency matrix covers 41 overlapping provider streams with no
App admission rejection, duplicate-route rejection, exact control routing,
sibling chat selectors, activity call-ID collisions, session-owned revert
feedback, durable Yjs collaborator provenance, model-visible user versus
sibling-Agent conflict attribution and the two-conflict target stop.

Commands run from `client`:

```text
pnpm typecheck
pnpm exec vitest run \
  src/renderer/lib/agent/runtime/local-transport.test.ts \
  src/renderer/store/agent-chat-store.test.ts \
  src/renderer/store/agent-activity-store.test.ts \
  src/renderer/store/agent-edit-store.test.ts \
  src/renderer/lib/agent/runtime/agent-write-collaboration-guard.test.ts \
  src/renderer/lib/agent/runtime/drifting-freshness-product.integration.test.ts \
  src/renderer/lib/agent/runtime/system-prompt.test.ts \
  src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.integration.test.ts \
  src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts \
  src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts
pnpm agent:capabilities:check
```

All three gates pass. The focused matrix contains 86 passing tests across ten
files; the capability check contains another 12 passing contract/boundary
tests.

## Paid DeepSeek same-document evidence

The credentialed, isolated product canary is:

```text
pnpm --dir client eval:agent:concurrency:live
```

It creates a temporary file-backed product database and one synthetic Yjs
chapter, then starts two real `deepseek-v4-flash` General Agent sessions. A
driver-only barrier makes both sessions finish their public `read_object` at
the same revision before either first write request. The first read/write and
the losing session's conflict-recovery sequence are forced only to make the
race deterministic; DeepSeek still produces the real schema-bound arguments,
and every read, write, receipt, review, Yjs CAS, SQLite transaction and model
message uses the product runtime.

The 2026-08-05 passing run observed:

- one turn completed in three model iterations with one successful write;
- the other received exactly one model-visible `other-agent` conflict, reread,
  and completed in five iterations;
- two successful writes produced Yjs revision `2` and exactly two durable
  provenance rows with distinct Agent session/turn/call identities;
- the final SQLite projection exactly matched Yjs, both requested edits were
  present once, and neither original placeholder remained;
- no conflict was attributed to the author and no
  `AGENT_COLLABORATION_CONFLICT_LIMIT` was reached;
- aggregate normalized usage was 19,040 input and 440 output tokens. The
  adapter reported `costUsd=0` because this path does not price DeepSeek usage;
  the record does not claim that the provider request was free.

The live bring-up closed one model-facing provenance gap before this pass:
`revise_object` preparation used to replace the receipt from the public
`read_object` with a hidden fresh read. Same-target sibling edits could
therefore degrade to a generic stale-passage error. Workspace read coverage now
retains the exact prose freshness receipt; when Yjs advanced, the write cites
that model-visible revision and the existing provenance classifier reports the
actual sibling Agent. A supplementary deterministic test also proves the
file-backed gateway's opt-in deferral mode matches the native Rust worker while
ordinary fault fixtures remain fail-fast.

Machine-readable evidence is in
[`concurrent-agent-deepseek-live-2026-08-05.json`](concurrent-agent-deepseek-live-2026-08-05.json).

`pnpm test:agent-runtime` also exposed and then verified a required ordering
fix: collaboration target lookup must not precede durable effect replay. The
full run passes 722 of 723 tests. Its sole remaining failure is an unrelated,
pre-existing authored-object word-count expectation (`13` Markdown source
tokens versus `11` persisted TipTap/Yjs text words); it is outside this
concurrency milestone and was left untouched to avoid overwriting the other
in-progress worktree change.

Sibling activity is intentionally projected only through each running
conversation's history-row indicator. Opening an idle sibling conversation
keeps its composer clear: no cross-conversation working banner is inserted
above the input.

## Remaining manual boundary

DUR-07M remains E4: use the native App to launch at least two conversations,
observe both history-row running indicators, steer one, stop the other, and
confirm that each transcript and activity stream remains independent. This
document does not claim visual/touch interaction evidence, and the synthetic
provider canary does not mutate or certify an author's real project.
