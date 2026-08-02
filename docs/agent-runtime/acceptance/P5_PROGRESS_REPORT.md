# P5 Progress Report — Drifting creative Agent runtime

> Historical report for the P5 checkout. Its counts, context window and
> continuation boundary are superseded by
> [`agent-capabilities.md`](agent-capabilities.md) and
> [`CURRENT_STATUS.md`](CURRENT_STATUS.md); do not treat the values below as
> current product claims.

## Identity

- phase: `P5`
- status: `single-Agent long-task slice accepted; Claude Code parity incomplete`
- aggregate: `pnpm --dir client eval:agent:p5`
- aggregateGitHead: `bfe2dc035606c41c0488ed3b1b6c1a41cb0a4a81` plus the current working tree
- aggregateSourceSha256: `2db46df581b74e4d566e82a49952de2396f2e0b5bce4c4c66bcd559ed637b817`
- aggregateNodeVersion: `v22.23.1`
- embeddedMigrationCount: `68`
- latestMigration: `0067_agent_runtime_long_task`
- provider: `not applicable`
- model: `not applicable`

The P5 aggregate is deterministic and provider-neutral. It does not call
DeepSeek, Anthropic, or another hosted model. It accepts the implemented
runtime slice; it does not claim complete Claude Code parity.

## Product result

P5 closes the highest-risk Drifting-specific runtime gaps:

```text
provider tool call
  -> strict schema validation
  -> policy decision / canonical user control
  -> read or renderer-owned write use case
  -> durable receipt and exact result
  -> durable review / guarded inverse
  -> provider-visible continuation
```

- Permission, `ask_user`, steering, stop-now, and stop-after-current-tool are
  canonical runtime controls. A denied call becomes a provider-visible tool
  result rather than an out-of-band UI failure.
- Interrupted writes are inspected from durable effects and receipts before a
  session resumes. A receipt-proven Yjs write is reconciled without dispatching
  the mutation again.
- Oversized tool results use durable, content-addressed SQLite artifacts.
  Unicode paging is by code point, survives restart, and is scoped to the exact
  project and session.
- The production context compactor runs behind the verified planner. It can
  compact eligible assistant/tool history without changing protected tool
  topology, write/review evidence, or freshness evidence.
- Prose reads and writes bind to the live Yjs document with an exact revision,
  state vector, and semantic hash. Six prose mutations use deterministic
  forward commands and guarded inverses.
- Visible edit review is backed by durable review identities. Ordered effects
  remain distinct, approval settles the canonical review, and rejection
  executes guarded inverses in reverse effect order.
- `create_element_patch` and `update_element_patch` are first-class sanctioned
  canon-evolution writes. They use exact patch-set or patch freshness,
  receipts bound to the frozen effect and exact postimage revision,
  transactional sync outbox writes, and restart-safe inverse reconciliation.
- `create_comment`, `update_element`, `update_storyline`, and
  `update_project_facts` now use the same transaction-owned mutation, sync
  outbox, immutable receipt, durable review, and guarded inverse boundary.
- Authoritative full-book reads use stable chapter/drift/storyline ordering and
  live Yjs prose, including closed documents; stale `contentJson` is only a
  seed, never the final prose truth.
- A durable task/step/constraint ledger tracks whole-book work across budget
  slices and renderer restarts. `whole_book_chapters` freezes the renderer's
  canonical chapter order and generates exactly one step per chapter; the
  provider neither enumerates chapters nor sees resolved internal ids.
  Completion is revalidated against the frozen manifest and an accepted,
  target-matching Yjs prose review.
- Every task step resolves its `resultRef` directly against durable
  review/effect provenance. This is independent of the bounded recent-review
  prompt window, so old accepted reviews in books with more than 20 chapters
  remain safely actionable.
- The current progress window and active constraints are semantic-pinned across
  compaction. On every searched model iteration, durable active-plan hints
  deterministically keep plan, chapter-read, and prose-edit tools available;
  a generic “continue” prompt does not have to rediscover long-task intent.
- The Agent Panel projects the canonical journal for text, thinking, partial
  tool arguments, results, controls, reviews, and terminal state. An active
  plan or `budget_exceeded` slice exposes one explicit “continue” action on the
  same runtime session and never auto-loops.
- Provider-neutral turns never enter the legacy whole-turn checkpoint trail.
  Both the UI and direct API fail closed; canonical undo is exclusively the
  durable review's revision-guarded inverse.
- Runtime-discovered plugin/MCP tools share the central schema, selection,
  project-isolation, and permission path. This is the transport-neutral MCP
  base; no concrete stdio/HTTP connection UI is claimed.

## Deterministic acceptance

Run:

```bash
pnpm --dir client eval:agent:p5
```

The closing aggregate passed:

| Gate | Files | Tests |
| --- | ---: | ---: |
| Control, permission, and interaction | 5 / 5 | 52 / 52 |
| Restart recovery | 8 / 8 | 50 / 50 |
| Result artifacts and context | 8 / 8 | 74 / 74 |
| Yjs prose and durable review | 7 / 7 | 43 / 43 |
| Element patches and certification | 3 / 3 | 16 / 16 |
| Product composition and entity writes | 3 / 3 | 9 / 9 |
| Long-task and continuation | 2 / 2 | 15 / 15 |
| Dynamic tool and MCP base | 5 / 5 | 73 / 73 |
| **Total** | **41 / 41** | **332 / 332** |

The aggregate also verifies:

- journal entries are canonical and unique
- migration count is exactly `68`
- the latest index is `67`
- the latest tag is `0067_agent_runtime_long_task`
- both `0064_agent_runtime_result_artifact.sql` and
  `0065_agent_runtime_element_patch_receipt.sql`, plus
  `0066_agent_runtime_entity_write_receipt.sql` and
  `0067_agent_runtime_long_task.sql`, exist and contain their required
  first-class tables, including the frozen chapter manifest
- Rust embeds the canonical `drizzle` directory rather than maintaining a
  second migration list

The sanitized machine-readable result is
`docs/agent-runtime/acceptance/p5-summary.json`.

## Write certification

The General Agent catalog contains `34` writes. This slice certifies `14 / 34`;
the other `20` remain unavailable to the runtime.

Certified writes:

- node fields: `rename_node`, `set_node_summary`
- Yjs prose: `edit_block`, `edit_blocks`, `append_paragraph`,
  `insert_blocks`, `remove_blocks`, `replace_block_range`
- canon evolution: `create_element_patch`, `update_element_patch`
- entity facts: `update_element`, `update_storyline`,
  `update_project_facts`
- comments: `create_comment`

`create_element` is still not certified. Direct `update_element` is certified,
but established canon should still evolve through `element_patch` when the
change represents an in-story evolution rather than correcting the current
entity record.

## Control and recovery boundary

Only the `once` permission grant is implemented. `session` and `project`
grants are not implemented or advertised.

An in-process `permission` or `ask_user` wait resumes exactly once from its
canonical resolution. After a full renderer/app restart, the JavaScript
execution stack no longer exists. The pending control is recovered for honest
UI display and safe cancellation; it cannot resume that lost stack in place.
The supported recovery is cancel and start a new turn, not synthetic replay.

## Context and long-task boundary

The product context coordinator uses a `32768`-token fallback window, budgets
the exact exposed schemas, reserves at least `4096` output tokens plus a `10%`
safety margin, keeps the latest two turns exact, treats thinking as discardable,
and keeps tool calls/results atomic.
It uses a conservative Chinese-aware fallback estimator; provider-exact
tokenizer injection remains available but is not configured for DeepSeek.

When context pressure requires compaction, the configured provider returns
structured summaries for eligible complete runs. The planner verifies exact
source ids, source hashes, coverage, topology, and actual token reduction before
admitting a summary. Verified summaries are reused within the provider epoch
and recovered from the latest validated durable checkpoint. Canonical source
rows remain in SQLite; older full checkpoint payloads are reduced to immutable
digests while the latest two full anchors remain available.

The first session goal and explicit author constraints are provenance-bound.
For long work, the Agent must also persist the objective, steps, and active
constraints in the durable task ledger. Only a 48-step window is pinned into
each model call; the complete plan and every step's durable review evidence
remain pageable in SQLite. Budget and normal turn boundaries require an
explicit author continuation rather than an unattended loop.

The remaining semantic risk is model quality: a structurally verified summary
can still omit nuance, and one accepted prose mutation proves that a chapter
was touched safely—not that its literary polish is sufficient. Native
live-provider whole-book trials and author review remain necessary.

## Explicitly unverified or deferred

- DeepSeek live-model smoke: not run.
- Native desktop smoke: not run.
- iOS smoke: not run.
- Android smoke: not run.
- Multi-provider adapter conformance: not implemented.
- Subagent orchestration: not implemented.
- Concrete MCP stdio/Streamable HTTP transport and configuration UI: not
  implemented. Dynamic registration, discovery bridging, execution, project
  isolation, schema validation, and per-call permission policy are implemented.
- `session` and `project` permission grants: not implemented.
- Lost-stack waiting-control resume in place: not implemented; safe cancel only.
- Author-confirmation UI for inferred constraint candidates: not implemented.
- `create_element`: not certified.

These are open scope, not hidden acceptance exceptions. Passing
`eval:agent:p5` means the implemented P5 runtime contracts are deterministic
and regression-tested; it does not mean Drifting has reached full Claude Code
feature breadth.
