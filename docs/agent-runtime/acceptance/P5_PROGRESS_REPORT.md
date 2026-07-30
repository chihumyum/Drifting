# P5 Progress Report — Drifting creative Agent runtime

## Identity

- phase: `P5`
- status: `implemented slice accepted; Claude Code parity incomplete`
- aggregate: `pnpm --dir client eval:agent:p5`
- aggregateGitHead: `68751ebeeceb66fdc38553df9dea108cfd5d4c95`
- aggregateSourceSha256: `165439dc71e8e2d7ea246fcaf27ff13f2ef5abaa68c7fbc95018d2c22b4a3a6a`
- aggregateNodeVersion: `v22.23.1`
- embeddedMigrationCount: `66`
- latestMigration: `0065_agent_runtime_element_patch_receipt`
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

## Deterministic acceptance

Run:

```bash
pnpm --dir client eval:agent:p5
```

The closing aggregate passed:

| Gate | Files | Tests |
| --- | ---: | ---: |
| Control, permission, and interaction | 5 / 5 | 37 / 37 |
| Restart recovery | 3 / 3 | 34 / 34 |
| Result artifacts and context | 6 / 6 | 51 / 51 |
| Yjs prose and durable review | 6 / 6 | 39 / 39 |
| Element patches and certification | 3 / 3 | 16 / 16 |
| **Total** | **23 / 23** | **177 / 177** |

The aggregate also verifies:

- journal entries are canonical and unique
- migration count is exactly `66`
- the latest index is `65`
- the latest tag is `0065_agent_runtime_element_patch_receipt`
- both `0064_agent_runtime_result_artifact.sql` and
  `0065_agent_runtime_element_patch_receipt.sql` exist and contain their
  required first-class tables
- Rust embeds the canonical `drizzle` directory rather than maintaining a
  second migration list

The sanitized machine-readable result is
`docs/agent-runtime/acceptance/p5-summary.json`.

## Write certification

The General Agent catalog contains `34` writes. P5 certifies `10 / 34`; the
other `24` remain unavailable to the runtime.

Certified writes:

- node fields: `rename_node`, `set_node_summary`
- Yjs prose: `edit_block`, `edit_blocks`, `append_paragraph`,
  `insert_blocks`, `remove_blocks`, `replace_block_range`
- canon evolution: `create_element_patch`, `update_element_patch`

`create_element` and `update_element` are not certified. P5 deliberately
certifies the sanctioned longitudinal `element_patch` channel, not arbitrary
direct canon replacement.

## Control and recovery boundary

Only the `once` permission grant is implemented. `session` and `project`
grants are not implemented or advertised.

An in-process `permission` or `ask_user` wait resumes exactly once from its
canonical resolution. After a full renderer/app restart, the JavaScript
execution stack no longer exists. The pending control is recovered for honest
UI display and safe cancellation; it cannot resume that lost stack in place.
The supported recovery is cancel and start a new turn, not synthetic replay.

## Context boundary

The verified author-constraint ledger is implemented as a planner seam but is
not connected to a product author-confirmation flow. Therefore the product does
not infer constraints from regexes or silently compact old author messages.
Without an explicit verified policy, old `user` rows remain fail-safe pinned.
This is safe but leaves long author-heavy conversations less compressible than
the final design.

## Explicitly unverified or deferred

- DeepSeek live-model smoke: not run.
- Native desktop smoke: not run.
- iOS smoke: not run.
- Android smoke: not run.
- Multi-provider adapter conformance: not implemented.
- Subagent orchestration: not implemented.
- MCP discovery and execution: not implemented.
- `session` and `project` permission grants: not implemented.
- Lost-stack waiting-control resume in place: not implemented; safe cancel only.
- Product author-confirmed constraint ledger: not connected.
- `create_element` and `update_element`: not certified.

These are open scope, not hidden acceptance exceptions. Passing
`eval:agent:p5` means the implemented P5 runtime contracts are deterministic
and regression-tested; it does not mean Drifting has reached full Claude Code
feature breadth.
