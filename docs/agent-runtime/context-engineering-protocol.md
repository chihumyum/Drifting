# Agent Runtime context engineering protocol

Status: normative for Milestone F and later.

This protocol defines how Drifting turns a long, durable writing session into
the exact provider input for one model call. It covers budgeting, canonical
evidence, compaction, author constraints, evidence retrieval and oversized
tool results. It does not define prose-quality judgment; that belongs to
Milestone H.

## 1. Canonical history and provider envelope

The runtime's persisted model history, durable write/review facts, long-task
plan and freshness facts are canonical. A provider never receives that raw
state through an alternate path. Every invocation must pass through the V2
context bridge and produce:

- canonical source rows with stable source IDs;
- a source manifest and content hashes;
- a verified projection consisting only of exact source rows or source-bound
  summaries;
- a constraint ledger with an exact retention witness;
- a content-free usage snapshot for the UI context indicator.

`verifyAgentContextProviderEnvelope` must succeed before a checkpoint is
accepted or recovered. There is no unplanned provider-history fallback.

## 2. Provider-aware budget

The default Drifting driver declares
`deepseek-v4-flash:drifting-context-v1`:

| Field | Value |
| --- | ---: |
| Context window | 200,000 tokens |
| Maximum output per call | 8,192 tokens |
| Provider framing reserve | 512 tokens |
| Per selected tool reserve | 8 tokens |

A driver declaration is authoritative. Product configuration may reduce its
window, but must never enlarge it. A custom driver with no declaration receives
the conservative 32,768-token fallback; only an explicit DEV/test override may
choose another value.

For every provider call, the planner charges:

1. exact projected source/summary payload;
2. the exact selected tool schemas for that iteration;
3. provider and per-tool framing;
4. requested output, with the runtime minimum output reserve;
5. a ten-percent context safety margin.

The output request must also fit the driver's declared per-call ceiling.
Budget failures happen before provider I/O.

The provider-neutral fallback estimator counts CJK code points directly rather
than using UTF-8 bytes divided by four. Provider adapters may install a stricter
tokenizer.

## 3. Protected author truth

The product classifier promotes only directly stated user rows into one of:

- `session_goal`;
- `author_instruction`;
- `author_veto`;
- `author_fact`.

Every entry is bound to the canonical source ID and source hash. The planner
keeps those rows byte-exact and emits an `exact` retention witness containing
their ordered IDs and aggregate hash. Compaction cannot replace or rewrite
them. Durable task-plan, task-constraint, freshness, write-review and
write-revert notes are also semantic-pinned.

The classifier is intentionally conservative. It is not permission to infer
unstated preferences or manufacture canon.

## 4. Contradictory constraints

Provider-free detection handles only high-confidence contradictions:

- two author facts assign different values to the same subject/key;
- an author instruction and veto target the same lexical action.

An explicit later correction such as “更正” or “以此为准” resolves the older
fact without another interruption. Otherwise the runtime adds a pinned
`context_constraint_confirmation_required` note with stable conflict IDs.

This is a runtime safety boundary, not prompt advice:

1. every write tool is rejected with
   `CONTEXT_CONSTRAINT_CONFIRMATION_REQUIRED`;
2. the Agent must call `ask_user` with a focused question and the exact current
   `constraintConflictIds`;
3. stale or invented IDs are rejected;
4. the author's non-blank answer and confirmed IDs are persisted in the
   canonical `ask_user` tool result;
5. the next context plan recomputes conflicts from canonical history and only
   then unlocks writes.

## 5. Literary compaction

The full compactor receives only contiguous, unpinned eligible runs and never
splits a read tool call from its result. Each bounded chunk must return one
forced structured call with schema version 1:

- synopsis;
- exact evidence citations;
- decisions;
- unresolved questions;
- next actions.

Evidence kinds are `canon_fact`, `character_voice`, `author_decision`,
`write_outcome`, `task_progress` and `unresolved`. Every compacted tool result
must have at least one citation containing its canonical source ID and a short
byte-exact quote. Unknown IDs, forged quotes, missing tool-result citations,
duplicate citations and unsupported fields fail closed.

The planner independently verifies source coverage, source hash, contiguity,
tool topology and token gain. A valid short tail whose summary provenance would
cost more than the original remains byte-exact while profitable sibling chunks
may still be applied. An all-no-gain batch fails and opens the scoped compaction
circuit. A failed or timed-out compactor is not retried repeatedly in the same
session/provider epoch.

Verified summaries may be cached in memory or loaded from durable checkpoints.
Every reuse is revalidated against the current canonical source IDs and hashes.

## 6. Long-book evidence retrieval

`search_project`, `search_prose` and workspace `grep` use the same deterministic
provider-free ranker. It supports mixed CJK/Latin tokenization and ranks title,
alias, canon fact, summary and prose fields with explicit weights. Exact phrase
and query-term coverage dominate; freshness is only a small tie-breaker so a
recent distractor cannot outrank an older authoritative fact.

Every match returns semantic identity plus:

- matched terms and field;
- a Unicode-safe snippet;
- path/block provenance when applicable;
- current domain or Yjs revision and `updatedAt` freshness.

Live Yjs prose is read at query time. Search indexes and `contentJson` are not a
write source of truth.

## 7. Oversized tool results

An oversized result is persisted as a project/session-scoped SQLite artifact.
The initial result returns a preview, `resultRef`, total Unicode characters,
total bytes and SHA-256 content hash. `read_tool_result` pages by Unicode code
point and repeats the immutable hash/size metadata on every page.

Paging works after repository close/reopen. Requests from another project or
session, an offset beyond EOF, content corruption and quota overflow fail
closed. Garbage collection is age-scoped and must not invalidate live refs as a
side effect of a failed insert.

## 8. Headless acceptance and privacy

Run:

```bash
pnpm --dir client eval:agent:context
```

The gate uses the committed distilled `fog-harbor.golden.json` plus the user's
local manuscript when available. Private prose is read only inside the test
process. The machine report records availability, file count and byte count,
never manuscript text.

The required gates are:

- canon, character voice, alias, writing-rule and chapter-evidence recall@5 =
  1.0 on the literary oracle;
- compacted evidence, voice and constraint recall = 1.0;
- exact constraint retention witness;
- median token reduction at least 50%;
- maximum planned context ratio at most 90%;
- verified summary reuse after restart with no redundant compactor call;
- one failed compactor call and zero retries after its circuit opens;
- SQLite artifact paging and V2 checkpoint recovery across process restart;
- idempotent write/task receipts with zero duplicate mutations;
- typecheck, scoped lint and generated capability drift gate.

## 9. Explicit boundary

This protocol proves that the right evidence reaches the provider without
silent loss or contradiction. It does not claim that a deterministic fake
provider can judge beautiful prose. Real ambiguity, scope selection, author
voice imitation, canon-impact reasoning and whole-book semantic QA are measured
in Milestone H. Live provider conformance is Milestone I; native lifecycle and
endurance are Milestone J.
