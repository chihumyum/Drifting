# General Agent author-owned writing policy

Status: normative for Milestone H replacement and later.

Drifting provides a durable project workspace and safe data mechanics. It does
not prescribe how the author or model should write. Writing policy belongs to
the author.

## 1. Provider context

Every General Agent turn receives only the writing guidance the author owns:

- the current author request and conversation history;
- editable project facts/rules from the project's `kvJson`;
- active long-term Agent rules created by the author or explicitly approved by
  the author;
- the project's shared rolling `WORKING_MEMORY.md`, whose current revision is
  injected at turn start; updating it is optional and reserved for important
  shared changes, with no memory tool call required on unchanged turns;
- durable task and runtime recovery state required to continue the requested
  work.

The product does not derive or inject an editor entity, selection, block,
nearby prose, target whitelist, style profile, POV, tense, voice, plot rule,
canon rule, citation duty or manuscript language.

### Prompt cleanup, version 52 (2026-10-01)

The base prompt describes the task, domain, and execution boundaries. The model
chooses reading breadth, reasoning depth, and verification. An explicit request
to read or review a complete work or chapter set requires that full scope,
including body continuation cursors; summaries and search excerpts do not
replace it. Bounded chapter requests still follow displayed chapter order.

The first cleanup removes instructions to keep reasoning brief, stop at the
next editorial decision, avoid full reads except for a concrete ambiguity,
avoid adjacent chapters, never reconstruct reading coverage, and never analyze
tool syntax. Saved write results and restored review/read state now describe
facts without forbidding rereads. Related excerpts no longer claim to replace
source reading. Checklist and Working Memory descriptions retain their tool
contracts while dropping repeated workflow coaching.

This follows the emphasis on goals, context, constraints, and completion in
[OpenAI's Codex best practices](https://learn.chatgpt.com/guides/best-practices)
and autonomous completion in the public
[Codex GPT-5.1 prompt](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md).
That prompt is one published model-specific implementation, not evidence that
every Codex client uses identical instructions.

Project isolation, read-only turns, write freshness, concurrent-edit handling,
review decisions, full-body replacement coverage, result pagination, and
destructive-operation approval remain intact. Provider serialization recovery,
compaction algorithms, tool schemas, author rules, and request budgets are
outside this first cleanup. Existing conversations can still contain older
tool text until it leaves context.

### Conditional prompt removal, version 53 (2026-10-01)

Mobile context chips remain local transcript metadata; their object references
and behavioral note are no longer prepended to the model prompt. The current
project route and the author's message still supply the requested scope.
Compacted summaries retain their content and section labels without an added
instruction about continuing work or concealing recovery/history mechanics.

OpenAI-compatible sample retries append only a short error message identifying
output exhaustion, an unavailable tool, malformed arguments, missing required
reasoning, or an invalid response. They no longer supply a retry instruction,
tool catalog copy, or discarded reasoning excerpt. Retries preserve the
original reasoning mode/effort, tool choice, output limit, and validation
requirements; they can return an answer or multiple valid tool calls. Bounded
retry and validation before publishing any action remain unchanged. A runtime
request explicitly forcing a structured completion tool retains its separate
protocol; provider sample recovery no longer introduces that restriction.

## 2. No content mutation guard

Any project item exposed by the installed workspace tools may be read or
changed when the model decides it is useful for the author's request. The
currently open editor, a previously active chapter and phrases such as
“这里”/“这段” are not product-level authority and never become a write scope.

The runtime does not:

- resolve deictic phrases against UI focus;
- freeze UI focus into a turn;
- reject a write because another entity was open or named earlier;
- require the author to add an entity to an internal scope;
- require canon/element patches before changing prose;
- infer conflicting writing rules and block all writes pending confirmation;
- impose default plot, chronology, POV, tense or voice preservation.

The model resolves ordinary language from the conversation and workspace. It
may call `ask_user` when the intended result is genuinely ambiguous, but the
product does not manufacture an ambiguity or force a question.

## 3. Retained execution integrity

Removing content policy does not remove data integrity:

- project isolation prevents cross-project access;
- current Yjs prose remains the manuscript source of truth;
- read-before-write revisions and CAS reject stale concurrent writes;
- stable idempotency keys prevent duplicated effects;
- ordinary prose edits retain inline Review/reveal and exact undo;
- destructive structural operations request explicit permission by default;
- the author may explicitly allow dangerous operations without disabling
  project isolation, freshness, CAS, receipts or guarded write execution;
- durable receipts, runtime commit records and task state prevent false
  recovery claims.

These mechanisms protect data and authorship. They do not decide literary
content or restrict which in-project entity the model may choose.

## 4. Author rule lifecycle

Project-level facts and rules are ordinary editable KV rows on the Project
Dashboard. They are loaded verbatim on each new turn.

Long-term Agent rules support `preference`, `directive` and `veto`:

- an author-created rule is active immediately;
- an Agent-proposed rule remains pending until the author approves it;
- the author can delete any rule so it no longer enters later prompts;
- approval, supersession and deletion persist through SQLite and the sync
  outbox;
- only active, non-deleted rules are injected.

New projects currently start with no hidden writing rules. A future starter
template may create ordinary visible rows, but every row must remain editable
and deletable by the author.

## 5. Multi-session consequence

No Session depends on global editor focus. Multiple Sessions may eventually
load the same current project rules while keeping independent conversation,
Provider history and task state. Concurrent data mutations are coordinated by
the shared writer scheduler and revision/CAS checks, not by literary scope.

## 6. Headless acceptance

Run:

```bash
pnpm eval:agent:writing
```

The gate proves:

- no product-derived focus or default literary rules enter the system prompt;
- explicit full reading is required without product-imposed reasoning or reread limits;
- saved results and restored progress retain evidence without discouraging rereads;
- mobile context stays out of model prompts and summaries carry no extra behavioral wrapper;
- all five sample recovery cases append only error information and preserve inference settings;
- author-owned project rules and approved long-term rules are injected;
- the capability manifest declares no content scope or canon-patch gate;
- one turn can edit arbitrary project prose entities;
- the reported regression can append to a Drift without inheriting a stale
  chapter focus;
- TypeScript, scoped ESLint and generated capability docs remain synchronized.

The generated evidence is
[`acceptance/milestone-h-writing-intelligence.json`](acceptance/milestone-h-writing-intelligence.json).
These deterministic checks cover prompt and runtime contracts. They do not
prove that a live provider reads an entire manuscript; that behavior still
needs a separate run with synthetic long-form text.
