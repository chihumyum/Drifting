# Current Drifting Agent Runtime status

Updated: 2026-10-03

This document is the current human-readable product and verification boundary.
Historical phase reports and dated provider runs are evidence for their
recorded checkout, not capability inventories.

## Sources of truth

1. Machine-readable composition:
   [`agent-capabilities.json`](agent-capabilities.json)
2. Generated human-readable composition:
   [`agent-capabilities.md`](agent-capabilities.md)
3. Durable acceptance definitions:
   [`GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md`](GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md)
4. Milestone policy and open work:
   [`../ROADMAP.md`](../ROADMAP.md)
5. Normative runtime protocols in `docs/agent-runtime/`

After a tool, provider, strategy, context, product composition, or Agent
documentation change, run:

```bash
pnpm agent:capabilities:generate
pnpm agent:capabilities:check
```

## Current product boundary

### Runtime and authority

- Prompt version 53 removes reading/reasoning micromanagement from the base
  prompt, tool guidance, saved results, and restored domain state. Requested
  full reading is explicit. See
  [`../author-owned-writing-policy.md`](../author-owned-writing-policy.md) and
  [`milestone-h-writing-intelligence.json`](milestone-h-writing-intelligence.json).
  Live-provider reading behavior remains unverified by this deterministic gate.
- Mobile context is no longer appended to the model prompt. Summary wrappers
  contain no behavioral instructions. OpenAI-compatible sample retries append
  only an error description and preserve reasoning and tool-choice settings.

- General Agent is the only first-class Agent product. Standalone Shadow CI,
  Element Arc, and Goal Evolve are retired and must not regain panels, routes,
  tables, provider settings, prompts, or eval corpora.
- The provider-neutral local runtime is installed by the renderer on every
  Tauri target. Current execution does not depend on the removed Node/Claude
  CLI, a sidecar, or a remote runner.
- SQLite owns the durable runtime journal, effects, permissions, plans, review
  decisions, and receipts. Live Yjs owns prose. Renderer stores and
  localStorage are rebuildable presentation projections.
- Agent domain writes execute through renderer-owned use cases with revision
  checks, durable receipts, guarded inverses, and the same authored change-set
  journal boundary used by manual product writes.
- Prose word counts are rebuildable projections with an explicit `seed` or
  `yjs` semantic hash plus an exact local revision basis.
  Manual edits, Agent edits and snapshot restore derive from captured Yjs state;
  project boot reconciles invalid or stale projection values without rewriting prose.
  SyncEngine never transports these projection scalars; a future remote apply
  rebuilds them from the resulting local Yjs state. Aggregates are chapter-only;
  pending projections are shown as pending rather than exact. See
  [`../../prose-metrics.md`](../../prose-metrics.md).

### Approved future Ambient design — not shipped

- The target design for Shadow as an Ambient Editor is frozen in
  [`../../ambient-editor/README.md`](../../ambient-editor/README.md). It is a
  future subsystem composed on the shared Agent Runtime, not a restored
  standalone Shadow CI/runtime.
- The design defines read-only reconciliation over author-owned Editorial
  Lenses, Canon, and a rebuildable evidence-backed World Model, producing
  first-class editorial Concerns without pass/fail, gates, or manuscript
  mutation.
- No Ambient route, World Model, Review Debt queue, Concern Inbox, provider
  capability, synced Ambient schema, or background scheduler is currently a
  shipped Agent capability. The generated inventory remains authoritative.
- The current retirement guard remains in force: implementation must not
  restore `src/renderer/lib/shadow`, `shadow_job`, `project_rule`, old review
  states, old Shadow panels, or old eval corpora.
- The progressive implementation and evidence gates are defined in
  [`../../ambient-editor/delivery-and-acceptance.md`](../../ambient-editor/delivery-and-acceptance.md).
  Design acceptance proves documentation consistency only.

### Tool and authored-object surface

- The installed built-in surface is the complete generated set of narrow,
  explicit author-domain tools. Exact names and counts come only from the
  generated capability inventory.
- Provider tool exposure uses the persisted `agentToolSearch` preference
  (default `auto`). `off` exposes full schemas. `auto`/`on` expose fixed
  `tool_search` and `call_tool` entrypoints, with the complete authorized tool
  directory in the search description. No author prompt or task state can
  prune that directory. The model retrieves exact schemas as normal tool
  results and dispatches operations through `call_tool`.
- Search, schema repair, pagination and final synthesis keep the same provider
  `tools` array within a turn. Synthesis disables invocation with `tool_choice`
  while preserving the tool prefix. Catalog or access changes take effect at
  the next turn. Journals, validation, approvals, write receipts and recovery
  retain the original operation names; discovery changes only provider framing.
  The planner charges that framing before compaction. See
  [tool discovery](../tool-discovery.md) and the generated capability inventory.
  Deterministic runtime/provider tests cover this contract; live account cache
  hit rates have not been measured.
- Explicit retry/continuation retains certified tool-search schemas across
  writes and process restart. Authored-object reads still expire after writes;
  failed-turn recovery never replays writes. Schema reuse leaves the provider
  tool prefix fixed and is covered by file-backed runtime recovery tests.
- Each turn carries an explicit tool-access choice
  (`AgentToolAccessChoice = 'read_only' | 'read_write'`). Answer-only
  `read_only` turns are a hard runtime boundary, not a prompt convention: write
  tool definitions are removed from the provider surface entirely, a dedicated
  read-only system prompt is injected, and the Working Memory
  `checkpoint_working_memory` instruction is disabled for that turn. The
  current mobile Agent panel sends its turns as `read_only`.
- Generic virtual-file and generic authored-object verbs are retired from the
  provider surface. Paths, JSON documents, Yjs, SQLite, revisions, and storage
  identifiers remain runtime implementation details.
- Chapter, inspiration, element, category, storyline, membership, relation type, relation,
  comment/TODO, project fact, author-rule, memory, and element-patch lifecycle
  support is generated and machine checked.
- During an author-requested write task, General Agent may leave a concise,
  evidence-backed incidental finding as an existing Comment/TODO on the
  relevant authored object. This is opportunistic, not an Ambient scan: it
  does not search for extra issues or turn the requested work into a TODO.
  `create_comment` still uses the normal anchored write and review boundary.
- An open TODO in Review or the editor rail offers **让 Agent 处理**. It starts
  one separate same-project Agent conversation in the background, preserves
  the author's displayed chat and unsent draft, and stores the conversation
  link as a synced `comment_action`. The TODO stays open for author review.
  Opening the linked chat exposes its progress and normal Agent controls.
  A project switch cancels pending startup and foreign running turns because
  the tool bridge remains bound to the viewed project. This is an explicit
  user-launched session, not a persistent Ambient worker or a worktree.
- Project relations use synced first-class type definitions rather than new
  free-text labels. A type declares `directed` or `symmetric` orientation,
  endpoint roles, and allowed source/target entity kinds. Desktop relation
  creation offers only compatible types and an explicit endpoint swap. Every
  relation has one non-null type id; copied labels, nullable types, and
  `unconfigured` compatibility rows are absent and old payloads fail closed.
  TODO/Library shortcuts use a deterministic locked `generic-association`
  type. SQLite, SyncEngine provider sync (Google Drive / local folder), and
  General Agent use the same definition
  and durable receipt/revert boundary. See
  [`../../relation-types.md`](../../relation-types.md).
- Authored prose reads and writes use the schema-locked Markdown/TipTap adapter;
  initial creation and subsequent changes preserve the same supported block and
  inline structures.

### Review, concurrency, and recovery

- Prose freshness reads build a fallback seed only when authoritative Yjs state
  is absent. Both basis checks, live flushes and durable read receipts remain;
  see [paired performance evidence](../prose-read-performance.md) for the
  measured service scope and browser/provider limitations.

- Prose review is write-first and durable per block. Accept/reject-one and
  accept/reject-all use ordered SQLite decisions and guarded Yjs inverses;
  restart hydration does not depend on localStorage.
- Added and Modified presentation markers are projections of committed effects.
  A local display failure cannot turn an already committed domain write into a
  model-visible failure or justify a duplicate mutation.
- A conversation owns at most one active turn. The App imposes no numeric
  admission cap across conversations in the currently mounted project.
- Reads may overlap. Writes cross the shared reader/writer and entity revision
  boundaries. Yjs revision provenance distinguishes Agent sessions, the local
  author, remote changes, system changes, and legacy unknowns.
- Project switching stops turns owned by the previous project. Restart restores
  durable plans for explicit manual resume; it does not replay an in-flight
  provider request.

### Long work and context

- Whole-book edit/review tasks freeze a chapter manifest and persist their plan,
  steps, constraints, evidence, and reconciliation state across slices and
  restart.
- Stop waits for the current tool's durable boundary. Steer applies exactly once
  at the next model boundary. Automatic continuation never reauthorizes itself
  after restart and pauses after repeated slices without durable progress.
- Context windows use each selected model declaration in full, with no Standard/Max
  cap. Output and schema reserves, compaction topology, source-hash citations, retained author
  constraints, search provenance, and oversized artifact paging are defined in
  the generated inventory and context protocol.
- Agent chats are independent flat sessions. Author-visible Agent checkpoint,
  conversation rewind, and conversation-fork hierarchy are not product
  concepts; manuscript recovery belongs to entity snapshot history.
- Every project has one rolling Markdown `WORKING_MEMORY.md` shared across its
  General Agent conversations. The runtime injects the current revision at turn
  start. Working Memory writes are optional: call `checkpoint_working_memory`
  with `update` only when important shared context changed; otherwise answer
  directly without a memory tool call. There is no `noop` operation or mandatory
  pre-final checkpoint. It is intentionally recent working context, not project
  history, canon, manuscript prose, a transcript or the long-term author-rule
  store. SQLite owns a revision-CAS singleton; local mutation and sync outbox are
  atomic; 6k/8k soft/hard token bounds retire the oldest completed `Recent`
  entries while preserving `Current` and the two newest exact entries.
- The desktop General Agent panel can preview, edit, create and clear Working
  Memory even before a provider credential is connected. Concurrent Agent/user
  edits fail closed and preserve an unsaved author draft. The mobile Agent
  panel also exposes this UI through its Working Memory tab, rendering the same
  shared `AgentWorkingMemoryView`.

### Providers and extensions

- ChatGPT subscription model discovery now uses the native account catalog,
  refreshes on sign-in/menu/focus/online events, and preserves saved model ids
  through restart or fetch failure. Unknown output ceilings remain null;
  default Agent and summary requests have no client output cap. Input reserves
  do not truncate generation or impersonate model capabilities. Configuration,
  compaction, and pre-call context failures no longer auto-resume unchanged
  input. Synthetic complete tool-loop, catalog, settings, Responses and native
  projection tests cover this path; current real-account catalog/UI
  acceptance remains unverified. The generated bundled model list is fallback
  evidence, not a live entitlement catalog. See [provider settings](../../ai-provider-settings.md).

- Models & API is the single writable BYOK credential surface. Copilot and
  General Agent choose their own provider/model routes but lazily read the same
  native secure-storage entries.
- DeepSeek, Anthropic, and OpenAI deterministic wire conformance is certified.
  Exact supported models, thinking modes, and effort combinations come from the
  generated capability inventory.
- `openai-codex` reuses the certified OpenAI Responses body on the ChatGPT Codex
  backend with the author's own subscription sign-in. It is experimental and
  unsupported: OpenAI publishes no third-party contract for it, the native host
  presents the official CLI's client identity to be accepted, and it is not a
  release claim. A bounded local Headless Agent run on 2026-09-04 validated the
  current checkout with `gpt-5.6-sol`: reasoning, streamed function-call
  assembly, tool execution/result replay, final text, usage, and durable turn
  commit all completed through the author's ChatGPT sign-in. This is
  checkout-specific canary evidence, not a stable upstream compatibility claim.
- Project-scoped MCP supports bounded desktop stdio and native Streamable HTTP.
  Configuration, health, lifecycle generations, secret references, and exact
  durable grants remain renderer/native authority.
- Paid endpoint canaries are explicit opt-in evidence and are not silently
  treated as deterministic release gates.

### Native and mobile

- Desktop and mobile use separate shells over the shared project runtime and
  domain/use-case layer. Mobile uses its own paper session, navigation,
  overview, panels, and interaction state instead of a narrow desktop shell.
- iOS Simulator and Android debug artifact production plus resumable 4h/12h
  workload-equivalent automation are recorded machine gates.
- Compilation, state-machine tests, and Simulator automation do not prove
  physical-device touch, IME, safe-area, background, visual quality, or Android
  device behavior.
- Relation-type desktop layout and interaction still require author visual
  review. Shared data/sync/type checks do not claim an iOS or Android relation
  management experience; physical-device acceptance remains manual.
- Working Memory desktop layout, Markdown readability, destructive-clear
  wording and keyboard interaction still require author visual review. The
  mobile Agent panel (conversation list, turn history, Working Memory tab) is
  implemented in the shared renderer, but shared schema/runtime tests do not
  claim device-level iOS or Android Agent-panel acceptance; that remains
  manual.

## Current open verification and follow-up

- Ambient Editor implementation phases 1–7 are open. Phase 0 freezes the target
  design but ships no behavior; see
  [`../../ambient-editor/delivery-and-acceptance.md`](../../ambient-editor/delivery-and-acceptance.md).
- Physical-device desktop/iOS/Android interaction remains open where listed in
  the mobile and native manual checklists.
- The deterministic P0 fixes discovered by the 2026-08-06 empty-project novel
  run have not been validated by another paid long-form empty-project campaign.
- Stable partial edit recovery, equivalent-create recovery, and remaining
  actionable domain errors remain ordered follow-up from the 2026-08-06
  remediation plan. That dated report was not retained in the public
  repository.
- Subagent orchestration remains deferred. Multiple current conversations are
  supported; that is not subagent delegation.
- TODO handoff has synthetic E1 coverage in
  [`todo-agent-handoff.json`](todo-agent-handoff.json), regenerated with
  `pnpm agent:todo:acceptance` and checked with
  `pnpm agent:todo:acceptance --check`. Paid-provider behavior, SQLite restart,
  and desktop/mobile visual interaction have not been accepted for this path.

## Developer CLI

The internal developer CLI is shipped as `pnpm drifting`. It exposes the
generated General Agent domain reads/writes against an exclusively opened,
automatically backed-up local database; guarded scalar resource lifecycle for
projects, acts, drift groups, timeline markers and library items; the existing
loopback Agent turn/review bridge; real authenticated server HTTP requests; and
versioned workspace scenarios. JSON envelopes are the default coding-agent
protocol, and `workspace describe [tool]` exposes the exact production input
schemas for generated domain reads and writes.

The CLI does not generic-CRUD Yjs/update logs, Agent runtime journals and
receipts, outbox rows, derived indexes, upload workflow rows, secure
credentials, or migrations. Exact per-table coverage and exclusions come from
the generated
[`dev-cli capability inventory`](../../dev-cli/acceptance/cli-capabilities.md).
`pnpm drifting:check` verifies generated drift, schema-table accountability,
offline safety, domain resource invariants, and a real file-backed SQLite/Yjs
chapter lifecycle. Remote authentication, paid-provider behavior, and native
device UX remain separate acceptance boundaries.

## Evidence navigation

- Completed A-K and P1-P6 milestone history is recoverable from Git history.
- Current deterministic acceptance outputs: `milestone-*.json`,
  `openai-native-transport.json`, and the generated capability inventory in this
  directory
- Non-reproducible provider, real-project, and long-form runs: dated reports
  recorded for their checkout and recoverable from Git history, except for a
  small number of dated reports never retained in the public repository
- Mobile device procedure:
  [`../../mobile-device-acceptance.md`](../../mobile-device-acceptance.md)
- Full native manual regression:
  [`../../qa/tauri-native-manual-regression.md`](../../qa/tauri-native-manual-regression.md)

Nothing in this status file overrides the generated inventory. If this prose,
the generated files, production composition, or machine drift gate disagree,
the milestone is open until implementation and documentation are repaired in
the same change.

Closed prose search can capture bounded text projections in shared Rust. Live
Yjs and the renderer still own editing and the Agent protocol. Performance and
fallback coverage: [Rust reuse](../../rust-reuse-performance.md).
