# P4 Exit Report — Provider-neutral context, tool search, and freshness

## Identity

- phase: `P4`
- status: `accepted`
- aggregate: `pnpm eval:agent:p4`
- aggregateGitHead: `e4253dbc16f5d4c06670a21d0331633c6264183a`
- aggregateSourceSha256: `dae43b9d8e4133620632e20bd7d525a4c5a7eab037c98366bc1ffaf96102383c`
- aggregateNodeVersion: `v24.4.0`
- embeddedMigrationCount: `64`
- latestMigration: `0063_agent_runtime_freshness`
- provider: `not applicable`
- model: `not applicable`

P4 was delivered in independently reviewable batches:

- `d71d467f8042976e54dd934f9b1f90bd933c31f9` — add policy-safe local tool search
- `be43b5707bd91855069c7ccc2d86ffa7b29cf298` — add verified context planner
- `e1e774413161cccbddc0a07867c8e6ba77ad4075` — integrate per-iteration tool search
- `54ae803ab8d6e5647ace218362ee6aed108df6e3` — add durable freshness receipts
- `6bf33ed2be82deec314c68197257555c8c8c60a7` — bridge verified provider context
- `1d6db6531ea07a7f7da2d6f400307785dfa0fad5` — recover verified context checkpoints
- `a6a9782aa7462957b6815e051d85450bad6df332` — enforce durable freshness on node writes
- `c03bff3675fe4cf5e4c3f4253431921bedfbee97` — guard exact inverses with the post-write node revision
- `25f03bbf4f585e664fbb135d1e107f36840152c1` — enforce verified provider context
- `e4253dbc16f5d4c06670a21d0331633c6264183a` — persist completed context checkpoints

The aggregate is deterministic and provider-neutral. It does not call
Anthropic, DeepSeek, or another hosted model. Provider conformance belongs
after the runtime framework gate.

## Product result

P4 closes four framework boundaries:

```text
policy-filtered catalog
  -> local per-iteration tool selection (hard max 8)
  -> verified context bridge and planner
  -> provider request
  -> exact final-turn V2 checkpoint

Drifting read tool
  -> immutable read receipt and entity observation
  -> explicit expectedRevision on a certified node write
  -> renderer use case
  -> SQL compare-and-set plus sync outbox in one transaction
```

Inside the provider-neutral projection, context summaries and freshness notes
are first-class context messages rather than canonical user messages or
synthetic tool results. The OpenAI-compatible wire adapter necessarily maps
those explicit context types onto a `user` role, with
`drifting_verified_summary` or `drifting_verified_note` provenance JSON. That
wire compatibility mapping is distinct from canonical history. Canonical
source rows, source bindings, manifests, planner projection, budget, and
provider envelope are hashed and verified before reuse.

The runtime replans on every provider iteration using exactly the selected tool
schemas. The provider request seam receives only the required first-class
planned context; it cannot access an unplanned legacy `messages` or
`systemPrompt` fallback. The completed checkpoint is planned again after the
final assistant message, so restart never resumes from the pre-answer provider
request.

## Local tool-search gate

Machine-asserted thresholds:

- fixed corpus: `150` unique bilingual intents
- top-3 recall: `>= 95%`
- top-5 recall: `>= 99%`
- safety-intent top-5 recall: `100%`
- selected tools: `<= 8`
- median provider-schema reduction: `>= 30%`
- warmed local searches: `10,000`
- warmed p95: `< 20 ms`
- policy leakage to unavailable or disallowed tools: `0`

Latest observed metrics are written by the closing aggregate to
`docs/agent-runtime/acceptance/p4-summary.json`. Dynamic latency is reported
separately from the machine-asserted threshold and is not hard-coded as a
portable guarantee.

Latest observed on the closing aggregate:

- top-3 recall: `98.67%`
- top-5 recall: `100%`
- safety-intent top-5 recall: `100%`
- median provider-schema reduction: `76.40%`
- warmed local search p95 over `10,000` calls: `2.787 ms`

## Context-planning and bridge gate

Machine-asserted matrix:

- generated topology histories: `10,000`
- dangling, orphaned, split, or duplicate tool topology: `0`
- long scenarios: `20`
- deterministic seeds per scenario: `3`
- long runs: `60`
- pinned exact recall: `100%`
- constraint recall: `100%`
- completion proxy drop: `<= 5%`
- median token reduction: `>= 50%`
- p95 context-window ratio: `<= 90%`
- full compactor calls per long run: exactly `1`
- retry after compactor throw/hash drift/split pair/no gain/timeout: `0`

Latest observed on the closing aggregate:

- generated histories: `10,000`; topology violations: `0`
- long runs: `60`
- pinned exact recall: `100%`
- constraint recall: `100%`
- completion proxy drop: `0%`
- median token reduction: `85.68%`
- p95 context-window ratio: `29.57%`

The bridge round-trips mixed text, thinking, read, and write history; scopes
tool call IDs by turn; keeps the latest two turns exact; rejects unknown or
dangling historical tools; and charges selected schemas plus provider framing
before planning.

The runtime integration gate proves:

- planning occurs before every provider call
- each call budgets the exact per-iteration selected schemas
- pinned overflow and malformed topology fail before provider invocation
- the compactor circuit is isolated by session and provider epoch
- the final assistant is present in the durable completed-turn checkpoint
- `LocalGeneralAgentTransport` passes that exact completed checkpoint into the
  canonical `commitTurn` call
- a canonical denied `UNKNOWN_TOOL` call/result pair can self-heal when a
  previously available tool is later removed
- unknown successful history and forged denial evidence still fail closed

## Durable freshness and product CAS gate

Migration `0063_agent_runtime_freshness.sql` adds immutable read receipts,
entity observations, and write expectations. The repository gate uses
file-backed `node:sqlite` and checks exact result bytes/hash, provenance,
foreign keys, cascade behavior, immutable triggers, and guarded mutation.

The deterministic race matrix contains `1,000` entities and two contenders per
entity:

- committed contenders: exactly `1,000`
- stale contenders: exactly `1,000`
- mutation callbacks: exactly `1,000`
- committed effects: exactly `1,000`
- outbox rows: exactly `1,000`
- duplicate effects or outbox rows: `0`
- project crossover: `0`

The product integration independently proves read receipt delivery,
`expectedRevision` validation, both certified node-field writes, idempotency,
cross-project rejection, and the validation-to-mutation race. A concurrent
manual node update makes the Agent SQL compare-and-set lose; the Agent mutation
and sync outbox both remain at `0`. Exact inverses retain the successfully
written node revision as their guard, so a later manual edit is not overwritten
by rejection.

## V2 restart and integrity gate

The file-backed restart gate commits the final assistant and V2 provider
envelope atomically, closes the database, opens a new connection, verifies the
nested integrity chain, and resumes only canonical history.

It rejects:

- an invalid outer checkpoint hash
- a tampered canonical source
- a tampered source manifest
- a tampered source binding
- a tampered provider projection
- a tampered fixed-input budget

P2 array checkpoints remain readable for storage migration compatibility.
That compatibility is not a legacy provider-request fallback. V2 checkpoint
mismatches fail closed and do not fall back to display-cache history.

## Red-team P1 gate

Three release-blocking findings were converted into executable regression
tests:

- provider requests have no legacy path to unplanned canonical history
- summary metadata, including every `sourceId`, is charged to the context
  budget; the `3,000`-source regression now fails closed at `28,325 > 13,904`
  instead of undercounting the projection as `48` tokens
- V2 tool arguments use the same recursive canonical JSON semantics during
  persistence and verification, independent of object insertion order

## Aggregate and regression gates

- P4 aggregate: passed
- P4 aggregate test files: `16 / 16`
- P4 aggregate tests: `135 / 135`
- Agent Runtime aggregate: `29 files / 203 tests passed`
- Core full test: `77 files / 432 tests passed`
- P1 deterministic acceptance: `4 / 4`, passed twice consecutively
- Core TypeScript check: passed
- workspace lint: `0 errors`; `53` pre-existing warnings (`42` Core, `11`
  Server)
- embedded Rust migration compatibility/idempotency and canonical-journal
  constraint tests: `2 / 2 passed`
- `git diff --check`: passed

Sanitized aggregate result:
`docs/agent-runtime/acceptance/p4-summary.json`.

## Manual signoff and open risks

- manualSignoff: `pending native user smoke`
- Product write certification remains limited to `rename_node` and
  `set_node_summary`.
- Other entity kinds currently emit no freshness observation. This is explicit
  empty coverage, not inferred freshness.
- Oversized `read_tool_result` full-body/resultRef paging still uses a bounded
  in-memory map. A persisted receipt can be replayed, but an app restart cannot
  continue fetching new pages from that prior in-memory resultRef. Complete
  large-result pagination is therefore not claimed as durable.
- V2 uses unkeyed SHA-256 for integrity and internal self-consistency, not
  authenticity. It catches accidental or partial drift, but cannot resist a
  local attacker who can rewrite the payload and every corresponding hash.
- Provider adapters are deliberately outside this framework gate. No Anthropic
  key or Anthropic SDK is needed to accept P4.
- Native desktop/mobile UI behavior and visible review controls remain pending
  manual smoke.
