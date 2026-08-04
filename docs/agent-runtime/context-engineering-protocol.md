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

The standard product mode caps a declared provider window at 200,000 tokens.
Max mode requests the provider's declared window up to 1,000,000 tokens. It
never invents support: a 200k declaration remains 200k, and an unknown custom
driver remains on the conservative fallback. Context mode, provider and model
are captured when the author submits the turn and cannot change midway.

The default DeepSeek driver declares:

| Field | Value |
| --- | ---: |
| Context window | 200,000 tokens |
| Maximum output per call | 8,192 tokens |
| Provider framing reserve | 512 tokens |
| Per selected tool reserve | 8 tokens |

A driver declaration is authoritative. Product configuration and Standard/Max
mode may reduce its window, but must never enlarge it. A custom driver with no
declaration receives the conservative 32,768-token fallback; only an explicit
DEV/test override may choose another value.

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

The product classifier promotes the initial session goal, current author
request and directly stated durable guidance into one of:

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

## 4. Author-owned constraints

Explicit author instructions, vetoes and facts remain exact, source-hash-bound
rows across compaction. The runtime does not infer a product writing policy
from them and does not block writes through an automatic contradiction gate.

The current author request and current active project rules are presented to
the model, which resolves precedence through normal reasoning. It may use
`ask_user` only when a real author decision remains ambiguous. A later explicit
correction naturally supersedes older conversational guidance without an
internal conflict-ID protocol.

### Domain projection boundary

Canonical history retains the exact provider-neutral tool calls, results and
durable write provenance required for audit and restart. That does not make
transport syntax part of the model's working memory. Once a write is durably
committed or represented by an inline-review row, the next provider projection
replaces its raw call/result pair with one bounded author-domain state such as
"章节「06」正文已更新". Provider-visible state must not contain `writeRef`,
revision receipts, hidden command names, Yjs/SQLite identities or a second JSON
encoding of authored prose.

A later durable success for one authored target supersedes stale provider
evidence without discarding useful current literary state:

- an earlier explicitly failed write to that same target;
- a whole-body replacement retires every older body read for that target;
- a focused edit keeps one complete same-turn body as the working copy and
  overlays its current modified passages plus latest summary.

Those rows remain byte-exact in canonical history and checkpoint hashes; they
are only discarded from the next provider projection. An unresolved latest
failure remains exact. This prevents the model from comparing an accepted
current manuscript with obsolete pre-edit prose or replaying a giant failed
argument payload after recovery.

Provider string escaping is normalized at the authored-text boundary. A
multi-replacement prose edit evaluates every row against one freshly read
revision: exact matching rows commit together, accidental no-ops are ignored,
and isolated stale rows are skipped and reported semantically. If no row
matches, the operation still fails stale. The final Yjs mutation retains the
same revision compare-and-set, so partial stale-row tolerance cannot cross a
concurrent author edit.

Before that fresh revision is claimed, fully read authored objects of the same
kind are scored by the quoted old passages. If one object is a strictly
dominant match, an accidentally misnamed edit is prepared against that object;
matching rows commit in its single review and rows belonging elsewhere remain
unfinished. A tie, unread candidate or zero match stays on the ordinary
fail-closed path. This is passage localization, not permission to spread one
review across multiple chapters.

If every requested row is already satisfied or has identical old/new authored
text, preparation returns semantic idempotent success before the durable write
coordinator claims an effect. The no-op call/result pair is immediately
discardable, including a large repeated prose payload. A whole-body write with
unchanged prose but a changed summary is not a no-op and proceeds normally.

The same boundary removes legacy provider escape artifacts before text is
shown to the model. A unique replacement may tolerate quote-family,
paragraph-leading indentation and invisible line-end differences, and may
unwrap an accidental pair of quotation marks around narration. Wording,
paragraph structure, other punctuation and match cardinality remain exact.
These are runtime-owned presentation repairs, not instructions for the model
to reason about serialization.

For an explicitly named chapter, 灵感 or entity, tool selection omits project
inventory. A direct read accepts the authored name; opening a named collection
returns that collection without requiring the model to choose a separate
browse verb. A missing ordinal chapter is represented as writable manuscript
state and may carry the complete relevant outline paragraph, so the model can
create it without discovering a virtual directory. Neighboring continuity is
summary-first and full prose is fetched only for a concrete unresolved gap.
Every chapter or drift body read includes its authored summary and records
complete coverage for both views, so a body-plus-summary or summary-only write
does not require a redundant summary read.

After a committed focused edit, durable `read_progress` retains complete-read
status, the latest summary and bounded current passages. If the model
immediately asks for the same whole body again, the first request returns that
compact current-working-copy state instead of injecting another manuscript.
A second explicit request is allowed through to live Yjs, so a real post-
compaction uncertainty can still recover full evidence. Summary rendering is
sentence-terminal-idempotent; an existing `。`, `！`, `？` or equivalent is not
duplicated in this projection.

## 5. Literary compaction

Small histories keep the latest two turns byte-exact. That convenience is not
an unbounded pin: recent compressible context is capped at 64,000 tokens. If a
current turn is larger, the planner walks backward over the smallest
tool-topology-safe units. The current author request stays independently
semantic-pinned, so an oversized read batch can be compacted without losing the
instruction that caused it.

Within the active turn, the latest complete authored read for each target and
the exact successful write delta remain a working set while they fit. Authored
reads may use at most 80% of the exact-source budget; oversized units are
skipped instead of evicting every smaller chapter, and a newer complete read
supersedes an older complete read of the same target. A focused durable edit
keeps one complete same-turn read and appends only its current changed passages;
there is no parallel obsolete copy. A whole-body rewrite supersedes the older
body because the replacement itself is the current manuscript. A cached
verified summary whose source later becomes superseded is retired rather than
treated as invalid compactor output.

Compacted progress is reconstructed from reliable completed-write evidence,
not from the model's plan or from successful reads. The newest authored state
wins. The resulting provider note describes chapters, summaries and remaining
author work only; it must not reconstruct tool history, matching attempts,
paths, escaping, revision identifiers or persistence mechanics.

The full compactor receives only contiguous, unpinned eligible runs. Chunks may
split inside one turn at the smallest boundary that does not separate a tool
call from its result; overlapping parallel call/result intervals remain one
unit. Each bounded chunk asks for one forced structured call with schema
version 1:

- synopsis;
- exact evidence citations;
- decisions;
- unresolved questions;
- next actions.

Evidence kinds are `canon_fact`, `character_voice`, `author_decision`,
`write_outcome`, `task_progress` and `unresolved`. Every compacted write-tool
result must have a citation containing its canonical source ID and a short
byte-exact quote. Exploratory read results may be omitted and fetched again;
facts retained from them still need exact evidence. Unknown IDs, forged quotes,
missing write-result citations, duplicate citations and unsupported fields are
rejected.

Compaction reuses the turn's captured provider/model instead of silently
routing through DeepSeek. If the provider cannot return the structure, returns
truncated JSON or otherwise fails one chunk, Drifting substitutes a
deterministic non-factual fallback. It retains exact write-result evidence and
instructs the Agent to re-read current workspace state; a single malformed
summary therefore degrades recall but does not terminate a progressing task.
Cancellation and timeout still stop compaction immediately.

The compactor contract targets at least the larger of (a) current overage plus
two-percent/2,048-token headroom and (b) 50% of the planned input. Product
composition currently requests 85% reduction. It permits chunks up to 64k,
further bounded to 45% of the selected provider's usable source budget, and
uses at most two paid summary chunks per invocation; eligible remainder is
represented by deterministic non-factual rollups. This prevents a progressing
long task from compacting again immediately after one more tool batch without
turning every historical chunk into a serial paid call.

The planner independently verifies source coverage, source hash, contiguity,
tool topology and token gain. A valid short tail whose summary provenance would
cost more than the original remains byte-exact while profitable sibling chunks
may still be applied. After one all-no-gain batch, the planner may release the
oldest topology-safe soft recent-exact units and recalculate once because that
changes the eligible projection. A second no-gain result opens the scoped
compaction circuit. Invalid output, failure and timeout do not receive that
recovery and are not retried repeatedly in the same session/provider epoch.

The mounted product allows five minutes for the outer verified full-compaction
pass. Individual provider chunks keep their independent shorter timeout and
deterministic fallback, so one stalled summary cannot consume the whole pass.

Verified summaries may be cached in memory or loaded from durable checkpoints.
Every reuse is revalidated against the current canonical source IDs and hashes.

### Durable checkpoint size boundary

Normalized `agent_runtime_message` rows remain the exact provider-neutral
history. A completed turn first builds the fully witnessed V2 checkpoint. If
its serialized payload is at most 512 KiB, that V2 envelope is stored directly.
If it is larger, the commit stores a bounded V4 checkpoint containing the
canonical message count, SHA-256 of the rebuilt canonical history, and verified
restart summaries. The writer drops the oldest summary accelerators until the
V4 payload is within 512 KiB; it never drops normalized messages.

On restart, V4 recovery rebuilds canonical history from normalized rows and
must reproduce both the stored count and digest before adopting history or
loading any summary. The planner then independently revalidates every retained
summary against current source IDs and hashes. V3 remains readable for existing
databases but is no longer the oversized-turn write format. These hashes prove
durable self-consistency, not authenticity against a local attacker capable of
rewriting the database and every hash.

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
- topology-safe same-turn chunking, provider-aligned compaction and deterministic
  malformed-output fallback;
- SQLite artifact paging and V2/V3/V4 checkpoint recovery across process restart;
- idempotent write/task receipts with zero duplicate mutations;
- typecheck, scoped lint and generated capability drift gate.

## 9. Explicit boundary

This protocol proves that the right evidence reaches the provider without
silent loss or contradiction. It does not claim that a deterministic fake
provider can judge beautiful prose. Real ambiguity, scope selection, author
voice imitation, canon-impact reasoning and whole-book semantic QA are measured
in Milestone H. Live provider conformance is Milestone I; native lifecycle and
endurance are Milestone J.
