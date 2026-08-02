# Current Drifting Agent Runtime status

Updated: 2026-08-02

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
6 files, 34/34 tests, plus typecheck, scoped lint and capability drift.

Milestone I, provider and extension platform, is complete. Its provider wire,
MCP transport/security, durable grant and generation-lifecycle contract is in
[`../provider-extension-protocol.md`](../provider-extension-protocol.md). The
implementation and 162-test deterministic acceptance are recorded in
[`MILESTONE_I_EXIT_REPORT.md`](MILESTONE_I_EXIT_REPORT.md) and
[`milestone-i-provider-extension.json`](milestone-i-provider-extension.json).

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
pass. This is E3 evidence; E4 interaction, paid 1M, concurrent General Agent
sessions and the exact historical three-turn write sequence remain open.

## Current product boundary

- The General Agent runs in the Tauri renderer through the provider-neutral
  local runtime and executes authored writes through renderer-owned use cases,
  durable receipts and live Yjs prose coordination.
- Ordinary model turns use the virtual workspace facade; the generated
  inventory separately records its natural provider verbs and hidden domain
  operations so direct-catalog counts do not understate user-facing capability.
- The generated nine-domain CRUD matrix closes 43 applicable lifecycle
  operations. Storyline membership is a guarded complete-graph transaction;
  comments/TODOs, relations, structural entities, project facts, and writing
  memory all have natural workspace paths and lineage-guarded exact inverses.
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
  identity. A new chat is an independent flat session; no editor focus or
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
