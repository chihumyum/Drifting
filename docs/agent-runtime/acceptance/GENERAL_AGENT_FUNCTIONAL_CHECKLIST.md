# General Agent functional acceptance checklist

Updated: 2026-08-03

This is the durable acceptance index for General Agent changes. A milestone is
not accepted from a test count alone: every applicable row needs an evidence
level, a dated result and a link to its log/report. `Core` rows are release
gates. `Expansion` rows describe the next capability boundary and must not be
reported as implemented until they pass.

## Evidence levels

| Level | Meaning | What it does not prove |
| --- | --- | --- |
| E0 | Static contract, typecheck, lint, generated capability drift | Runtime behavior |
| E1 | Deterministic unit/provider-wire replay | SQLite/Yjs restart or a real provider |
| E2 | File-backed SQLite + live Yjs + crash/reopen acceptance | Paid endpoint or native interaction |
| E3 | Mounted Tauri renderer/headless bridge + configured real provider + real project | Visual/gesture correctness |
| E4 | Manual native App interaction on the named OS/device | Other platforms or long endurance |

Rules:

- “自动化验收通过” requires every applicable Core E0-E2 row.
- “真实模型验收通过” additionally requires the named E3 canary and attached
  provider/model/log IDs.
- “真机验收通过” requires E4. A Tauri build, simulator bundle, headless server
  or screenshot inspection is not E4.
- A failure that committed manuscript data must verify reconciliation and
  idempotency before the same project can be reused.

## A. Start, routing and configuration

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| CFG-01 | Core | E1 | Start a new chat; exactly one runtime session and turn are created. |
| CFG-02 | Core | E2 | Resume an existing chat after renderer/database reopen; history is adopted exactly once. |
| CFG-03 | Core | E1 | Change provider/model while a turn runs; the running turn keeps its captured route and the next turn uses the new route. |
| CFG-04 | Core | E3 | DeepSeek key present/absent/invalid produces success or a semantic auth error without exposing the key. |
| CFG-05 | Core | E3 | Repeat CFG-04 for every enabled Anthropic/OpenAI adapter. |
| CFG-06 | Core | E1 | A model that does not belong to the selected provider is rejected before provider I/O. |
| CFG-07 | Core | E1 | Standard mode plans against `min(200k, declared model window)`. |
| CFG-08 | Core | E1 | Max mode plans against `min(1M, declared model window)` and is immutable for the submitted turn. |
| CFG-09 | Core | E4 | Composer menu shows Max only as enabled for declared 1M models; changing it updates the next turn's context indicator. |
| CFG-10 | Core | E2 | Provider, model and Max preference survive restart and cross-device preference pull applies provider before model. |

## B. Conversation, streaming and author controls

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| CHAT-01 | Core | E4 | Assistant text streams progressively; no complete answer appears as one abrupt block. |
| CHAT-02 | Core | E1 | Thinking stays separate from the final author-facing answer and is hidden when disabled. |
| CHAT-03 | Core | E4 | Internal filesystem paths/tool mechanics are rendered as author semantics rather than raw operations. |
| CHAT-04 | Core | E1 | A tool-only iteration cannot silently end the turn without a final response or an explicit terminal error. |
| CHAT-05 | Core | E2 | Steer is accepted while running and applied exactly once at the next model boundary. |
| CHAT-06 | Core | E2 | Stop waits for the current tool, prevents the next model/tool step and records an aborted terminal. |
| CHAT-07 | Core | E2 | Permission approval/rejection resumes the same call exactly once. |
| CHAT-08 | Core | E2 | Required user input resumes the same turn without creating a second author message. |
| CHAT-09 | Core | E2 | Refresh/reopen reconstructs transcript, tool activities, usage and terminal state without duplication. |
| CHAT-10 | Core | E4 | Errors are actionable and do not expose stack traces, provider payloads, Yjs snapshots or internal paths. |

## C. Tool-call protocol and selection

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| TOOL-01 | Core | E1 | Empty `{}` is accepted only when the selected schema permits it; required fields cannot execute empty. |
| TOOL-02 | Core | E1 | Fragmented UTF-8/JSON tool arguments assemble byte-exactly before validation. |
| TOOL-03 | Core | E1 | Truncated, malformed, duplicate or post-terminal argument fragments never execute. |
| TOOL-04 | Core | E1 | One schema-repair lease can recover a repairable installed-tool call; repeated invalid calls fail explicitly. |
| TOOL-05 | Core | E1 | Unknown/uninstalled tools return the canonical runtime error and do not mutate state. |
| TOOL-06 | Core | E1 | Tool search exposes only executable strict schemas and can discover a needed tool outside the initial subset. |
| TOOL-07 | Core | E1 | Parallel read calls keep call/result identity; writes are scheduled through the write lane. |
| TOOL-08 | Core | E2 | Oversized results return a stable `resultRef`, Unicode-safe pages and identical hash after restart. |
| TOOL-09 | Core | E2 | A result ref is inaccessible from another project/session and corruption fails closed. |
| TOOL-10 | Core | E1 | Provider tool count/schema size and requested output are charged before provider I/O. |
| TOOL-11 | Core | E3 | A compound mutation keeps the installed `edit_file`/`write_file` verbs available across later iterations; no previously installed verb degrades into `UNKNOWN_TOOL`. |
| TOOL-12 | Core | E1 | A tool-capable provider sample is published transactionally: parse/network/rate-limit failure, malformed arguments, missing required reasoning, an unavailable tool, or output exhaustion before an action receives a bounded pre-effect resample; no discarded text/tool/usage event or mutation escapes, while authentication and author cancellation are never retried. |
| TOOL-13 | Core | E3 | Headless `--show-thinking` prints one complete thinking block per iteration plus mechanics, runtime-meta, character-matching, reread-intent, oversized-pass and duplicate-call counters; `SIGINT`, `SIGTERM` and `SIGHUP` preserve a partial audit without exposing thinking in the author transcript. |

## D. Natural workspace reads and navigation

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| READ-01 | Core | E3 | Browse project root and receive semantic collections, not implementation tables. |
| READ-02 | Core | E3 | Read chapter/drift prose from live Yjs, never stale `contentJson`. |
| READ-03 | Core | E2 | Read node/entity/category/storyline/comment/TODO/relation/project fact through stable natural paths. |
| READ-04 | Core | E2 | Search mixed Chinese/Latin titles, aliases and prose with revision provenance. |
| READ-05 | Core | E2 | Rename/reorder during a long task is detected through identity/revision rather than silently targeting another item. |
| READ-06 | Core | E1 | A nonexistent path returns suggestions/semantic not-found data and does not invent an entity. |
| READ-07 | Core | E2 | Pagination/list cursors neither skip nor duplicate entries across exact same revision. |
| READ-08 | Core | E3 | A broad exploratory read can continue to a write/final answer without context or tool-selection failure. |
| READ-09 | Core | E2 | A narrow `grep` against one file or entity directory is literal, reports an exact occurrence count, and represents zero matches explicitly. |

## E. Domain CRUD closure

Each row must verify create, read, update, delete where the domain permits it,
plus receipt, inverse/permission behavior and restart visibility.

| ID | Scope | Minimum evidence | Domain/pass condition |
| --- | --- | --- | --- |
| CRUD-01 | Core | E2 | Chapter and drift nodes, including creating a new node and editing title/summary/prose. |
| CRUD-02 | Core | E2 | Structural outline nodes and ordering/membership. |
| CRUD-03 | Core | E2 | Entities/elements, aliases and typed fields. |
| CRUD-04 | Core | E2 | Entity categories and category membership. |
| CRUD-05 | Core | E2 | Storylines and storyline membership as one guarded transaction. |
| CRUD-06 | Core | E2 | Entity relations, including both endpoints and relation kind. |
| CRUD-07 | Core | E2 | Comments with shared anchor/provenance model. |
| CRUD-08 | Core | E2 | TODO lifecycle and completion state. |
| CRUD-09 | Core | E2 | Project facts/rules without hiding first-class data in generic metadata. |
| CRUD-10 | Core | E2 | Author-managed Agent memories/rules and active/dismissed status. |
| CRUD-11 | Core | E2 | Element/canon patch lifecycle through its sanctioned typed path. |
| CRUD-12 | Core | E2 | Delete or destructive relation/structure changes require permission before execution. |
| CRUD-13 | Core | E2 | Duplicate delivery with the same idempotency key produces one mutation/outbox row. |
| CRUD-14 | Core | E2 | Concurrent stale revision loses with a semantic conflict and no partial state. |
| CRUD-15 | Core | E3 | One paid compound turn creates a drift, two typed entities with independent summaries, exactly three requested relations, one comment and one TODO; canonical-path rereads match and unrelated chapter/Yjs rows remain byte-for-byte unchanged. |

## F. Prose editing and review

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| EDIT-01 | Core | E3 | Append, prepend, replace and delete prose on both chapter and drift targets. |
| EDIT-02 | Core | E2 | Multi-block edits preserve block identity where possible and persist through live Yjs. |
| EDIT-03 | Core | E2 | Agent may edit any in-project target it decides is useful; no editor-focus/scope whitelist rejects a valid target. |
| EDIT-04 | Core | E4 | Auto mode stages a pre-live mask for open existing files, plays the colored reveal for Added and existing-file edits, never paints completed live prose beneath it, atomically hands the mask to the durable review, and leaves no pending review. |
| EDIT-05 | Core | E4 | Review mode inserts the committed diff in the editor with per-block accept/reject badge. |
| EDIT-06 | Core | E2 | Accept/reject one settles only that block through durable compare-and-set. |
| EDIT-07 | Core | E2 | Accept/reject all settles every remaining block, including partial prior decisions. |
| EDIT-08 | Core | E4 | Accept/reject all plays the same family of reveal/inverse animation. |
| EDIT-09 | Core | E2 | Rejection applies a guarded inverse; intervening author edits produce conflict rather than data loss. |
| EDIT-10 | Core | E2 | Renderer/localStorage loss does not lose SQLite review rows or make controls settle the wrong review. |
| EDIT-11 | Core | E2 | A lost success response reconciles the write exactly once after reopen. |
| EDIT-12 | Core | E3 | Five-chapter polish preserves requested plot boundary and reports concrete changed targets. |
| EDIT-13 | Core | E3 | Node prose write/read results expose the actual numeric `wordCount`, and a requested minimum length is verified from persisted content rather than model self-report. |
| EDIT-14 | Core | E3 | The headless product bridge can accept one review block and reject another; SQLite/Yjs readback contains only the accepted block effect. |
| EDIT-15 | Core | E2 | Virtual prose Markdown round-trips TipTap-supported H1-H3, blockquote, horizontal rule, hard break and inline marks; unsupported heading/list/code/table/HTML styles become plain prose, unsafe links lose behavior, and no disabled node or mark enters Yjs. |

## G. Long-running work

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| LONG-01 | Core | E2 | A durable plan has explicit remaining/completed/retired steps and survives restart. |
| LONG-02 | Core | E2 | No aggregate iteration/tool/token/time quota terminates progressing work. |
| LONG-03 | Core | E2 | Automatic continuation resumes progressing work and pauses after two genuinely stagnant slices. |
| LONG-04 | Core | E2 | Pending editor review can coexist with independent later steps. |
| LONG-05 | Core | E2 | Whole-book manifest detects add/remove/rename/reorder and reconciles once transactionally. |
| LONG-06 | Core | E2 | Removed unfinished work stays retired audit history and can reopen by stable identity. |
| LONG-07 | Core | E2 | Review work cites the exact current revision; stale/incomplete citations cannot complete a step. |
| LONG-08 | Core | E2 | Write work completes only from accepted exact-target evidence. |
| LONG-09 | Core | E3 | The real-project sequence “polish 5 chapters → another 5 → clean test blocks” reaches a final answer on all three turns. |
| LONG-10 | Core | E3 | LONG-09 emits no `PINNED_CONTEXT_EXCEEDS_BUDGET`, `COMPACTOR_FAILED`, malformed-summary terminal or duplicate write. |
| LONG-11 | Core | E2 | Stop/restart/retry around a long write never applies the same mutation twice. |
| LONG-12 | Core | E3 | A broad book review can re-read omitted evidence after compaction and continue naturally. |
| LONG-13 | Core | E3 | A vague project-level writing prompt, with provider-default reasoning enabled and no effort override, exposes durable-plan plus natural workspace tools, crosses repeated compactions, performs multi-resource CRUD/relation work and reaches a verified terminal without a prompt-authored file list or procedural recipe. |

## H. Context engineering

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| CTX-01 | Core | E1 | System, selected schemas, framing, output reserve and 10% margin reconcile exactly with the indicator. |
| CTX-02 | Core | E1 | Current author request, explicit author rules/vetoes/facts and durable task/review facts remain byte-exact. |
| CTX-03 | Core | E1 | Small histories retain the latest two turns exactly. |
| CTX-04 | Core | E1 | Recent exact history is capped at 64k and never pins an oversized current turn permanently. |
| CTX-05 | Core | E1 | Sequential tool pairs in one turn split into bounded compactor chunks without splitting a pair. |
| CTX-06 | Core | E1 | Overlapping parallel call/result intervals remain one topology-safe unit. |
| CTX-07 | Core | E1 | Compaction uses the turn's captured provider/model, including Anthropic/OpenAI routes. |
| CTX-08 | Core | E1 | Malformed/no-tool/unsupported compactor output produces a deterministic non-factual fallback rather than terminating the task. |
| CTX-09 | Core | E1 | Every compacted write result has exact evidence; exploratory reads may be omitted and fetched again. |
| CTX-10 | Core | E2 | Summary source IDs/hashes, projection coverage and recovery envelope verify after restart. |
| CTX-11 | Core | E2 | Durable summary reuse avoids a redundant provider compaction call. |
| CTX-12 | Core | E1 | Compaction must reduce tokens; no-gain chunks remain exact and cannot corrupt coverage. |
| CTX-12A | Core | E1 | Compaction reclaims at least 50% working room when eligible history permits, then stops; a small overage cannot trigger calls for every historical chunk. |
| CTX-13 | Core | E4 | Context ring uses the selected standard/Max denominator and modal category totals equal the planned input. |
| CTX-14 | Core | E3 | One 200k long-turn canary and one eligible 1M Max canary cross the compaction threshold and still finish. |
| CTX-15 | Core | E2 | A tool-heavy completed turn whose witnessed V2 payload exceeds 512 KiB commits a bounded V4 digest checkpoint; restart rebuilds exact history from normalized message rows, verifies count/hash before adoption, and revalidates retained summaries against current canonical sources. |

## I. Durability, isolation and recovery

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| DUR-01 | Core | E2 | Turn journal append, terminal and history adoption are atomic/idempotent. |
| DUR-02 | Core | E2 | Permanent durable-commit failure does not adopt provider history; committed writes remain reconcilable. |
| DUR-03 | Core | E2 | Crash before/after model, tool, write, review and terminal boundaries recovers to one legal state. |
| DUR-04 | Core | E2 | SQLite is authoritative; localStorage deletion changes no durable Agent decision. |
| DUR-05 | Core | E2 | Yjs and SQLite revision disagreement fails or reconciles explicitly, never overwrites silently. |
| DUR-06 | Core | E2 | Two independent sessions reading the same project do not share messages, controls, summaries or permissions. |
| DUR-07 | Expansion | E2+E4 | Multiple General Agent sessions execute concurrently; writes serialize/conflict by entity revision while reads continue. |
| DUR-08 | Expansion | E2 | App restart restores multiple active session plans independently without global “current Agent” state. |

## J. MCP, provider extension and security

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| EXT-01 | Core | E1 | Dynamic tools are project-scoped, strict-schema and generation-isolated. |
| EXT-02 | Core | E2 | Desktop stdio MCP starts/stops through bounded native child hosting and revokes stale generation calls. |
| EXT-03 | Core | E2 | Streamable HTTP MCP works through the native request host on desktop/mobile targets. |
| EXT-04 | Core | E2 | Secrets remain Keychain references and never enter SQLite, localStorage, logs or model context. |
| EXT-05 | Core | E2 | Durable grants match exact server/tool/access identity; revocation takes effect immediately. |
| EXT-06 | Core | E1 | Provider wire replay covers DeepSeek, Anthropic and OpenAI text/tool/usage/finish/error cases. |
| EXT-07 | Core | E3 | Opt-in paid canary succeeds for each configured provider without becoming a default CI expense. |
| EXT-08 | Core | E1 | Provider/model catalog and context declarations are explicit; unknown model names cannot silently claim 1M. |

## K. Platform and endurance

| ID | Scope | Minimum evidence | Acceptance action and pass condition |
| --- | --- | --- | --- |
| NATIVE-01 | Core | E0 | Desktop, iOS and Android targets compile with the renderer-local runtime. |
| NATIVE-02 | Core | E4 | Desktop chat, tool activity, review badges, reveal, Stop, Steer and Max interaction pass manually. |
| NATIVE-03 | Core | E4 | Repeat applicable interaction rows on iOS. |
| NATIVE-04 | Core | E4 | Repeat applicable interaction rows on Android. |
| SOAK-01 | Core | E2 | Accelerated 4h/12h workload preserves bounded memory, receipts and resumability. |
| SOAK-02 | Core | E3 | Wall-clock real-provider/real-project endurance uses provider-default reasoning unless the scenario tests another mode, and records provider latency, compactions, retries and terminal rate. |

## Required command baseline

```bash
pnpm --dir client typecheck
pnpm --dir client test:agent-runtime
pnpm --dir client eval:agent:tool-reliability
pnpm --dir client eval:agent:durability
pnpm --dir client eval:agent:crud
pnpm --dir client eval:agent:long-task
pnpm --dir client eval:agent:context
pnpm --dir client eval:agent:writing
pnpm --dir client eval:agent:extensions
pnpm --dir client agent:capabilities:check
```

E3/E4 runs append a record rather than editing the checklist definition:

```text
Date / checkout:
Platform / device:
Provider / model / context mode:
Project fixture and revision:
Checklist IDs:
Result:
Log/report paths:
Known open failures:
Operator:
```

Latest E3 record: the 2026-08-03 DeepSeek Standard-200k campaign used
provider-default reasoning (`adaptive`, no effort override), a vague
project-level author prompt and a disposable `雾港纪事` clone. It completed all
14 durable task steps across 201 model iterations, 1,931 tool calls, 181
committed effects and 100 full-compactor plans; the final turn completed and
checkpointed 16 verified summaries. See
[`GENERAL_AGENT_REASONING_STRESS_RUN_2026-08-03.md`](GENERAL_AGENT_REASONING_STRESS_RUN_2026-08-03.md).
