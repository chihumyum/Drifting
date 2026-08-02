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
The implementation and 50-test file-backed acceptance evidence are recorded in
[`MILESTONE_D_EXIT_REPORT.md`](MILESTONE_D_EXIT_REPORT.md) and
[`milestone-d-domain-crud.json`](milestone-d-domain-crud.json).

Milestone E, long-task execution, is complete. Its normative state,
continuation, author-control and manifest protocol is in
[`../long-task-execution-protocol.md`](../long-task-execution-protocol.md).
The implementation and 100-test file-backed/Yjs acceptance evidence are
recorded in [`MILESTONE_E_EXIT_REPORT.md`](MILESTONE_E_EXIT_REPORT.md) and
[`milestone-e-long-task.json`](milestone-e-long-task.json).

Milestone F, context engineering, is complete. Its provider budget, canonical
evidence, structured compaction, constraint-confirmation, retrieval and
artifact protocol is in
[`../context-engineering-protocol.md`](../context-engineering-protocol.md).
The implementation and 82-test real-novel/restart/fault evidence are recorded
in [`MILESTONE_F_EXIT_REPORT.md`](MILESTONE_F_EXIT_REPORT.md) and
[`milestone-f-context-engineering.json`](milestone-f-context-engineering.json).

Milestone G, checkpoint and rewind, is complete. Its provider-neutral capture,
preview-token, compare-and-set restore, compensation and conversation-fork
contract is in
[`../checkpoint-rewind-protocol.md`](../checkpoint-rewind-protocol.md). The
implementation and 43-test real SQLite/Yjs/restart/fault evidence are recorded
in [`MILESTONE_G_EXIT_REPORT.md`](MILESTONE_G_EXIT_REPORT.md) and
[`milestone-g-checkpoint.json`](milestone-g-checkpoint.json).

Milestone H, writing intelligence, is complete. Its immutable editor-focus,
scope/canon fail-closed, author-voice evidence and cited review contract is in
[`../editor-native-writing-protocol.md`](../editor-native-writing-protocol.md).
The implementation and 75-test deterministic/local-manuscript acceptance are
recorded in [`MILESTONE_H_EXIT_REPORT.md`](MILESTONE_H_EXIT_REPORT.md) and
[`milestone-h-writing-intelligence.json`](milestone-h-writing-intelligence.json).

Milestone I, provider and extension platform, is complete. Its provider wire,
MCP transport/security, durable grant and generation-lifecycle contract is in
[`../provider-extension-protocol.md`](../provider-extension-protocol.md). The
implementation and 142-test deterministic acceptance are recorded in
[`MILESTONE_I_EXIT_REPORT.md`](MILESTONE_I_EXIT_REPORT.md) and
[`milestone-i-provider-extension.json`](milestone-i-provider-extension.json).

Milestone J, native and endurance acceptance, is complete for the automated
scope. Its build-vs-interaction and accelerated-vs-wall-clock evidence contract
is in [`../native-endurance-acceptance.md`](../native-endurance-acceptance.md).
The native artifact and 4h/12h resumable soak evidence is recorded in
[`MILESTONE_J_EXIT_REPORT.md`](MILESTONE_J_EXIT_REPORT.md).

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
- The default General Agent driver declares a 200,000-token context window and
  8,192-token output ceiling. Smaller declarations are never enlarged;
  undeclared custom drivers fall back to 32,768 tokens. Every provider call
  includes exact schema/framing/output/safety reserves before I/O.
- Literary compaction uses source-hash-bound schema-v1 summaries and requires an
  exact citation for every compacted tool result. Goals, author constraints,
  vetoes and explicit facts remain byte-exact with a retention witness.
  High-confidence contradictions block every write until `ask_user` durably
  records the author's answer against the current conflict IDs.
- Project/prose search uses weighted mixed CJK/Latin relevance with freshness
  and revision provenance. Oversized results are hash-verified SQLite artifacts
  paged by Unicode code point across restart.
- A complete provider-neutral user checkpoint is captured before every
  requested Agent turn; pinned manual checkpoints use the same authoritative
  SQLite/Yjs path. The toolbar supports preview, pin/delete, conversation-only
  fork, and explicit manuscript restore plus fork without truncating the source
  conversation.
- Manuscript restore is guarded by a one-use 15-minute preview token and
  all-entity compare-and-set checks. Multi-entity writes use a durable saga;
  later failure compensates in reverse order, renderer restart continues
  recovery, and concurrent author edits win instead of being overwritten.
- Checkpoint manuscript scope is current node/element/storyline/category prose
  plus entity-time-machine metadata. Deleted captured identities fail closed;
  structural graph deletion/recreation remains under the domain CRUD review
  protocol rather than being silently inferred by rewind.
- Every requested turn binds active editor entity, exact selection/block and
  nearby prose into immutable provider-neutral writing context. Deictic writes
  without focus, cross-entity/span mutations, and patch-required canon prose
  fail before certified execution. The panel surfaces this as semantic writing
  focus instead of paths or persistence internals.
- Current entity names and aliases explicitly present in a request resolve to a
  canonical one-or-many target set. Named cross-entity writing can proceed
  without pretending one editor pane owns all targets, while substitutions
  outside that set fail before mutation.
- Voice-continuity metrics are diagnostic mutation detectors, not autonomous
  quality judges. Semantic summaries and read-only whole-book QA require exact
  current-source citations; forged quotes and incomplete page evidence fail
  transactionally.
- Deterministic DeepSeek/Anthropic/OpenAI conformance is complete. Paid endpoint
  canaries remain explicit opt-in checks rather than a release prerequisite.
  Native desktop/iOS/Android interaction and 4h/12h real-book endurance remain
  Milestone J.
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
