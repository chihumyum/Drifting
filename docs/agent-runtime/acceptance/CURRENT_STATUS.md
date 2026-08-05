# Current Drifting Agent Runtime status

Updated: 2026-08-05

This document is the current human-readable milestone boundary. Historical
`P*_*.md` reports remain evidence for their original checkout and must not be
used as the current capability inventory.

## Sources of truth

- Machine-readable inventory: [`agent-capabilities.json`](agent-capabilities.json)
- Generated human inventory: [`agent-capabilities.md`](agent-capabilities.md)
- Ordered work and milestone rules: [`../ROADMAP.md`](../ROADMAP.md)
- Headless product workflow: [`../headless-debug.md`](../headless-debug.md)
- Durable functional checklist:
  [`GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md`](GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md)

Run the drift gate after changing a tool, strategy, product composition,
context window, capability boundary, or Agent documentation:

```bash
pnpm --dir client agent:capabilities:generate
pnpm --dir client agent:capabilities:check
```

## Current milestone

Milestone A, capability truth, is complete. Its implementation and evidence are
recorded in [`MILESTONE_A_EXIT_REPORT.md`](MILESTONE_A_EXIT_REPORT.md).

Milestone B, tool-call reliability, is complete. Its implementation, explicit
boundaries and 134-test deterministic provider-wire replay are recorded in
[`MILESTONE_B_EXIT_REPORT.md`](MILESTONE_B_EXIT_REPORT.md) and
[`milestone-b-tool-reliability.json`](milestone-b-tool-reliability.json).

Milestone C, durable commit and review, is complete. Its normative state/fault
matrix is in
[`../durable-commit-review-protocol.md`](../durable-commit-review-protocol.md).
The implementation and 67-test deterministic acceptance evidence are recorded
in [`MILESTONE_C_EXIT_REPORT.md`](MILESTONE_C_EXIT_REPORT.md) and
[`milestone-c-durable-review.json`](milestone-c-durable-review.json).

Milestone D, domain CRUD closure, is complete. Its normative transaction and
authority model is in
[`../domain-crud-transaction-protocol.md`](../domain-crud-transaction-protocol.md).
The implementation and 57-test file-backed acceptance evidence are recorded in
[`MILESTONE_D_EXIT_REPORT.md`](MILESTONE_D_EXIT_REPORT.md) and
[`milestone-d-domain-crud.json`](milestone-d-domain-crud.json).

Milestone E, long-task execution, is complete. Its normative state,
continuation, author-control and manifest protocol is in
[`../long-task-execution-protocol.md`](../long-task-execution-protocol.md).
The implementation and 110-test file-backed/Yjs acceptance evidence are
recorded in [`MILESTONE_E_EXIT_REPORT.md`](MILESTONE_E_EXIT_REPORT.md) and
[`milestone-e-long-task.json`](milestone-e-long-task.json).

Milestone F, context engineering, is complete. Its provider budget, canonical
evidence, structured compaction, exact author-rule retention, retrieval and
artifact protocol is in
[`../context-engineering-protocol.md`](../context-engineering-protocol.md).
The implementation and 79-test real-novel/restart/fault evidence are recorded
in [`MILESTONE_F_EXIT_REPORT.md`](MILESTONE_F_EXIT_REPORT.md) and
[`milestone-f-context-engineering.json`](milestone-f-context-engineering.json).

Milestone G's Agent-specific checkpoint, rewind and conversation-fork product
surface was removed on 2026-08-02. It duplicated Drifting's entity snapshot
history, blocked every turn on a whole-workspace capture, and introduced shared
state that does not belong in independent Agent sessions. The retirement record
is in [`MILESTONE_G_EXIT_REPORT.md`](MILESTONE_G_EXIT_REPORT.md); the remaining
snapshot authority is documented in
[`../entity-snapshot-history.md`](../entity-snapshot-history.md).

The original Milestone H writing harness was retired after a real Drift append
was rejected by stale editor focus. The replacement gives writing policy to the
author: no editor-focus injection, deictic binding, product writing defaults,
content scope guard, canon-patch gate or automatic rule-conflict write gate.
Its contract is in
[`../author-owned-writing-policy.md`](../author-owned-writing-policy.md). The
implementation and current regression evidence are recorded in
[`MILESTONE_H_EXIT_REPORT.md`](MILESTONE_H_EXIT_REPORT.md) and
[`milestone-h-writing-intelligence.json`](milestone-h-writing-intelligence.json):
6 files, 35/35 tests, plus typecheck, scoped lint and capability drift.

Milestone I, provider and extension platform, is complete. Its provider wire,
MCP transport/security, durable grant and generation-lifecycle contract is in
[`../provider-extension-protocol.md`](../provider-extension-protocol.md). The
implementation and refreshed 196-test deterministic acceptance are recorded in
[`MILESTONE_I_EXIT_REPORT.md`](MILESTONE_I_EXIT_REPORT.md) and
[`milestone-i-provider-extension.json`](milestone-i-provider-extension.json).

The 2026-08-05 OpenAI transport correction moved GPT-5.6 Responses traffic out
of WKWebView and into a fixed-origin cancellable Rust host. OpenAI API keys are
now injected from native Keychain storage, passive Models & API status uses an
existence-only query, and redacted HTTP/model/quota/network failures preserve a
safe OpenAI request id. Focused deterministic evidence is in
[`openai-native-transport.json`](openai-native-transport.json); the paid Luna
canary passed the provider wire, production Rust HTTP builder, and a
reasoning-on three-parallel-read → durable-write → final-response replay. The
complete dated evidence is recorded in
[`OPENAI_NATIVE_TRANSPORT_RUN_2026-08-05.md`](OPENAI_NATIVE_TRANSPORT_RUN_2026-08-05.md)
because network/account entitlement is not a deterministic release gate.

Milestone J, native and endurance acceptance, is complete for the automated
scope. Its build-vs-interaction and accelerated-vs-wall-clock evidence contract
is in [`../native-endurance-acceptance.md`](../native-endurance-acceptance.md).
The native artifact and 4h/12h resumable soak evidence is recorded in
[`MILESTONE_J_EXIT_REPORT.md`](MILESTONE_J_EXIT_REPORT.md).

Milestone K, long-task reliability and Max context, is complete for its E0-E3
Standard-context scope. Same-turn tool history can compact in bounded
topology-safe chunks, malformed compactor output degrades safely, and Max
requests an explicitly declared window up to 1M. The implementation, automated
evidence, real mounted-renderer 60k/200k canaries and remaining E4/paid-1M
boundary are recorded in
[`MILESTONE_K_EXIT_REPORT.md`](MILESTONE_K_EXIT_REPORT.md) and
[`GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md`](GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md).

The 2026-08-02 paid-write stress extension exercised the same runtime through a
mounted Tauri renderer on disposable copies of `雾港纪事`. The final compound
author workflow completed 36/36 tool calls with zero failures while creating
and rereading a drift, two independently summarized entities, three relations,
a comment and a TODO; direct SQLite comparison found no unrelated chapter or
Yjs mutation. Earlier failures in creation guidance, canonical result paths,
stable edit-tool visibility, literal occurrence search, category resolution,
typed summary initialization and persisted word counts were fixed before that
pass. This is E3 evidence; E4 interaction, paid 1M and the exact historical
three-turn write sequence remain open.

The 2026-08-03 reasoning-on long-book campaign then used a deliberately vague
author prompt, `--thinking adaptive` and no effort override against a disposable
`雾港纪事` clone. Across 201 model iterations it processed 25.5M input tokens,
1,931 tool calls, 181 committed effects and 100 full-compactor plans. Failure-
driven fixes added transactional pre-effect provider resampling, hierarchical
64k compaction with a two-paid-chunk pass budget, one bounded soft-recent
recovery, tolerant but conservative exact prose matching, consistent element
whole-object projections, and literal broad search for metadata, relations and
punctuation. The final vague `继续。` turn completed naturally, committed a
138,375-byte checkpoint with 16 verified summaries and passed SQLite
`quick_check`. Exact session, failure and context metrics are in
[`GENERAL_AGENT_REASONING_STRESS_RUN_2026-08-03.md`](GENERAL_AGENT_REASONING_STRESS_RUN_2026-08-03.md).

On 2026-08-04 the provider-facing writing loop moved transport mechanics out
of working memory. Durable writes now project one author-domain state instead
of raw prose arguments, private receipts or revision metadata; a recovered
success retires stale failures while a focused edit retains one complete
same-turn working copy plus its current passages. Whole replacement still
supersedes the old body. Chapter reads authorize their bundled summary; prose
plus summary commits and reverts atomically; exact no-ops settle as success
without a durable effect. Numeric chapter aliases no longer substitute
`bookOrder` in numeric-title manuscripts. Quoted passages can correct an
accidentally misnamed, fully read manuscript when one same-kind object is the
strictly dominant match; one redundant post-edit read is answered from durable
current-domain state before a second explicit request may reload the body.
`agent-headless-debug-turn.mjs --show-thinking` supplies the machine-visible
reasoning stream without adding it to the author transcript.

The final sync-disabled four-chapter paid regression completed in three model
iterations and 120.852 seconds with 7/7 successful calls. Its two thinking
passes totalled 2,100 characters; mechanics, runtime metadata, character
matching, reread intent, oversized-pass and duplicate-call counters were all
zero. It crossed `drop_discardable`, made eight focused revisions, left one
chapter and every already-aligned summary unchanged, and never browsed or
reloaded a manuscript. Exact run metrics and the isolated-clone boundary are
recorded in
[`GENERAL_AGENT_DOMAIN_REASONING_STRESS_RUN_2026-08-04.md`](GENERAL_AGENT_DOMAIN_REASONING_STRESS_RUN_2026-08-04.md).

The authored-object follow-up on 2026-08-04 replaced the provider's virtual
filesystem contract with six author-domain verbs and exercised vague
character-profile work on paid `deepseek-v4-flash` against disposable database
copies. A forced 26k debug window crossed the full compactor, deleted a visible
test relation, saved an element body and its independently named summary,
completed the first durable target and resumed the second without rereading the
saved body. Paid failures led to alias-consistent relation endpoints,
summary-only safety, atomic one-target checklist titles, explicit
`已保存`/`已删除` durable state and retirement of fulfilled summary work. The
remaining verbose literary deliberation is attributed to the selected weak
model unless a runtime ambiguity provably caused it; it is not enforced with a
scope or tool-round guard.

## Current product boundary

On 2026-08-05 the standalone Shadow CI product, Element Arc lens, and Goal
Evolve workflow were retired. Their panels, settings, rules/jobs/arcs, provider
routes, internal tools, eval corpus, and client-side usage accounting no longer
ship. Migration `0080_retire_shadow_arc_evolve.sql` maps legacy review states
back to `draft`, preserves old generated comments as ordinary API comments, and
drops the four feature-only local tables. General Agent's durable
`workKind=review`, long-task plan, authored-object tools, `element_patch`, live
Yjs writes, and shared comment model remain the supported composition.

- The General Agent runs in the Tauri renderer through the provider-neutral
  local runtime and executes authored writes through renderer-owned use cases,
  durable receipts and live Yjs prose coordination.
- One Agent product now permits any number of concurrent active conversations
  in the currently mounted project; there is no App admission cap.
  Session/turn-scoped controls and activity are independent; reads overlap;
  writes cross one shared reader/writer barrier and revision CAS. Yjs
  transaction origins identify the Agent session, turn and call, while a
  non-compactable per-revision ledger distinguishes exact Agent, local author,
  remote, system and legacy sources. Stale prose feedback tells the model
  whether the winner was this turn, another Agent conversation, the author,
  mixed sources or external/unknown; absence is never treated as proof of a
  user edit. A second stale conflict on the same target stops that target for
  the remainder of the turn instead of permitting an Agent-Agent overwrite loop.
  Project switching still stops turns from the previous mounted project, and
  restart restores plans for manual resume rather than replaying active
  provider requests. Deterministic evidence and the local Claude Code study are
  in
  [`CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md`](CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md).
- Models & API is the only writable BYOK credential surface. Copilot owns its
  provider/model route; General Agent selects its route in the chat composer.
  Both lazily resolve the shared native `byok.<provider>` Keychain entries.
- Ordinary model turns use the authored-object facade: `browse_project`,
  `read_object`, `search_work`, `revise_object`, `write_object`, and
  `delete_object`. The generated inventory separately records these natural
  provider verbs and hidden domain operations so direct-catalog counts do not
  understate user-facing capability.
- The authored-object projection is an implementation seam, not model memory.
  Named authored targets resolve directly; successful writes replace raw tool
  arguments and stale pre-write evidence with bounded semantic current state.
  Paths, extensions, serialization, revision, review and storage identities
  remain runtime-owned and are absent from fresh provider schemas.
- Authored prose interchange is schema-locked in both directions, including
  initial chapter/drift/element/storyline/category creation seeds. H1-H3,
  blockquote, horizontal rule, hard break, bold, italic, strike, underline and
  safe links map directly to the configured TipTap/Yjs structures. Unsupported
  Markdown presentation is stripped while readable text remains ordinary
  prose; editor-only entity-link marks survive edits to unchanged text.
- The generated nine-domain CRUD matrix closes 43 applicable lifecycle
  operations. Storyline membership is a guarded complete-graph transaction;
  comments/TODOs, relations, structural entities, project facts, and writing
  memory all have natural authored targets and lineage-guarded exact inverses.
- SQLite/Yjs remain authoritative. Every SQLite-backed domain mutation writes
  its typed receipt and sync outbox in the same transaction; renderer and
  localStorage state are projections only.
- Dynamic MCP registration is project-scoped, strict-schema and
  generation-isolated. Desktop stdio uses a bounded native child host;
  Streamable HTTP uses the native request host on every Tauri target. Settings
  own server lifecycle, Keychain secret references, health and exact durable
  grant revocation.
- Whole-book plans declare `workKind=edit|review` and compare their frozen chapter manifest with current
  SQLite state on every relevant read/finalization. Added, removed, renamed and
  reordered chapters require one explicit transactional reconciliation;
  removed unfinished steps remain `retired` audit history and can reopen if the
  same chapter identity returns. Edit completion requires accepted exact-target
  writes; review completion requires product-bound exact reads and fully cited
  structured results, including after restart.
- Automatic continuation has no aggregate task quota. It continues independent
  work while another step waits for review, pauses only after two genuinely
  stagnant automatic slices, waits for the current tool on Stop, applies Steer
  exactly once at the next model boundary, and requires fresh author action
  after renderer restart. Runtime continuation prompts stay in model history
  but out of the author transcript.
- Standard mode caps the selected model at 200,000 context tokens. The composer
  Max toggle requests the model's explicit declaration up to 1,000,000 tokens;
  smaller declarations are never enlarged and undeclared custom drivers fall
  back to 32,768 tokens. Provider/model/context mode are captured per turn, and
  every provider call includes exact schema/framing/output/safety reserves.
- Literary compaction uses source-hash-bound schema-v1 summaries and requires an
  exact citation for every compacted write result. Read results may be omitted
  and re-read. Recent exact context is topology-safe and capped at 64,000
  tokens, same-turn sequential tool batches can be chunked, compaction follows
  the captured provider/model, reclaims at least half the planned input when
  eligible history permits, then stops before needless old-history calls; and
  malformed structured output degrades to a non-factual deterministic summary
  instead of killing the task. Goals, the
  current request, author constraints, vetoes and explicit facts remain
  byte-exact with a retention witness.
- Project/prose search uses weighted mixed CJK/Latin relevance with freshness
  and revision provenance. Oversized results are hash-verified SQLite artifacts
  paged by Unicode code point across restart.
- Agent chats have no author-visible checkpoint, conversation rewind or branch
  identity. A new chat is an independent flat session and may run beside any
  number of sibling chats in the same mounted project; no editor focus or
  historical checkpoint payload is inherited. Runtime commit records and
  compaction checkpoints remain internal recovery mechanics, not user branches.
- Drifting's entity history independently captures changed node, element,
  storyline and category prose plus restorable metadata, normally no more than
  once per 15 minutes. Local rows are thinned and retained for 30 days; restore
  first saves the current state and applies a forward Yjs edit.
- The author owns writing policy. The product injects no editor focus, target
  whitelist, style, POV, tense, voice, canon-patch requirement or automatic
  rule-conflict write gate. Any in-project item exposed by workspace tools may
  be read or changed when useful to the request.
- Deterministic DeepSeek/Anthropic/OpenAI conformance is complete. OpenAI's
  certified catalog is GPT-5.6 Sol/Terra/Luna on Responses; model profiles
  drive the Settings and composer thinking/effort controls. Active reasoning
  tool loops replay DeepSeek `reasoning_content`, Anthropic signed thinking
  blocks, or OpenAI encrypted response items exactly, while portable canonical
  history remains provider-neutral. Paid endpoint canaries remain explicit
  opt-in checks rather than a release prerequisite. Native desktop/iOS/Android
  interaction and 4h/12h real-book endurance remain Milestone J.
- Tool calls use one frozen installed definition set, built-in and dynamic
  execution revisions, executable-only alias normalization, strict completed
  JSON validation, and a one-iteration schema repair lease for installed tools.
- Turn checkpoints acknowledge a lost SQLite success response idempotently and
  adopt provider history exactly once. Permanent commit failure does not adopt
  context; independently committed writes remain governed by their own ledger.
- Prose review decisions are ordered SQLite block rows. Accept/reject-one and
  accept/reject-all use the same compare-and-set protocol; guarded Yjs inverses,
  projection refresh, partial decisions, legacy review upgrades and project
  hydration survive renderer/localStorage loss. LocalStorage no longer exposes
  an independent decision API.

Nothing in this status file overrides the generated inventory. If prose here
contradicts that inventory or the final composition drift gate, the milestone
is open and the documentation must be repaired in the same change.
