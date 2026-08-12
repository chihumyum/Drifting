# Current Drifting Agent Runtime status

Updated: 2026-08-13

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
pnpm --dir client agent:capabilities:generate
pnpm --dir client agent:capabilities:check
```

## Current product boundary

### Runtime and authority

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
  checks, durable receipts, guarded inverses, and the same sync outbox boundary
  used by manual product writes.

### Tool and authored-object surface

- Ordinary provider turns receive the complete generated set of narrow,
  explicit author-domain tools. Exact names and counts come only from the
  generated capability inventory.
- Generic virtual-file and generic authored-object verbs are retired from the
  provider surface. Paths, JSON documents, Yjs, SQLite, revisions, and storage
  identifiers remain runtime implementation details.
- Chapter, inspiration, element, category, storyline, membership, relation,
  comment/TODO, project fact, author-rule, memory, and element-patch lifecycle
  support is generated and machine checked.
- Authored prose reads and writes use the schema-locked Markdown/TipTap adapter;
  initial creation and subsequent changes preserve the same supported block and
  inline structures.

### Review, concurrency, and recovery

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
- Context budgets are provider-declared. Standard and Max behavior, output and
  schema reserves, compaction topology, source-hash citations, retained author
  constraints, search provenance, and oversized artifact paging are defined in
  the generated inventory and context protocol.
- Agent chats are independent flat sessions. Author-visible Agent checkpoint,
  conversation rewind, and conversation-fork hierarchy are not product
  concepts; manuscript recovery belongs to entity snapshot history.

- Every project has one rolling Markdown `WORKING_MEMORY.md` shared across its
  General Agent conversations. The runtime injects the current revision at turn
  start and exposes one importance-gated checkpoint (`update` or `noop`) before
  the final response. It is intentionally recent working context, not project
  history, canon, manuscript prose, a transcript or the long-term author-rule
  store. SQLite owns a revision-CAS singleton; local mutation and sync outbox are
  atomic; 6k/8k soft/hard token bounds retire the oldest completed `Recent`
  entries while preserving `Current` and the two newest exact entries.
- The desktop General Agent panel can preview, edit, create and clear Working
  Memory even before a provider credential is connected. Concurrent Agent/user
  edits fail closed and preserve an unsaved author draft. This UI is not exposed
  by the current mobile shell.

### Providers and extensions

- Models & API is the single writable BYOK credential surface. Copilot and
  General Agent choose their own provider/model routes but lazily read the same
  native secure-storage entries.
- DeepSeek, Anthropic, and OpenAI deterministic wire conformance is certified.
  Exact supported models, thinking modes, and effort combinations come from the
  generated capability inventory.
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
- Working Memory desktop layout, Markdown readability, destructive-clear
  wording and keyboard interaction still require author visual review. Shared
  schema/runtime tests do not claim an iOS or Android Agent-panel experience.

## Current open verification and follow-up

- Physical-device desktop/iOS/Android interaction remains open where listed in
  the mobile and native manual checklists.
- The deterministic P0 fixes discovered by the 2026-08-06 empty-project novel
  run have not been validated by another paid long-form empty-project campaign.
- Stable partial edit recovery, equivalent-create recovery, relation direction
  and endpoint semantics, actionable domain errors, canonical word counts, and
  project-level cross-session handoff remain ordered follow-up in
  [`GENERAL_AGENT_PEAK_PERSON_REMEDIATION_PLAN_2026-08-06.md`](GENERAL_AGENT_PEAK_PERSON_REMEDIATION_PLAN_2026-08-06.md).
- Subagent orchestration remains deferred. Multiple current conversations are
  supported; that is not subagent delegation.

## Evidence navigation

- Completed A-K and P1-P6 history:
  [`MILESTONE_HISTORY.md`](MILESTONE_HISTORY.md)
- Current deterministic acceptance outputs: `milestone-*.json`,
  `openai-native-transport.json`, and the generated capability inventory in this
  directory
- Non-reproducible provider, real-project, and long-form runs: the dated reports
  listed in the historical index
- Mobile device procedure:
  [`../../mobile-device-acceptance.md`](../../mobile-device-acceptance.md)
- Full native manual regression:
  [`../../../../docs/qa/tauri-native-manual-regression.md`](../../../../docs/qa/tauri-native-manual-regression.md)

Nothing in this status file overrides the generated inventory. If this prose,
the generated files, production composition, or machine drift gate disagree,
the milestone is open until implementation and documentation are repaired in
the same change.
