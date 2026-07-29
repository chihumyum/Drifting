# P2 Exit Report — Canonical persistence and crash recovery

## Identity

- phase: `P2`
- status: `accepted`
- persistenceCommitSha: `2bfb605ca06d9a970855d3c9b3e76f8a907d405e`
- recoveryCommitSha: `a253d0de01bf7359bdcd2142d15e7991a80e9aa2`
- acceptanceCommitSha: `self`
- runtimeSchemaVersion: `1`
- promptVersion: `1`
- promptSourceSha256: `6c41ebfdd703ad9ac8045e9d591b5e181c991c3807b7249dee920b234dee6b6e`
- toolCatalogSourceSha256: `41575e4c95706ae62fa11a5fc7523492da21a33a750e9dba442fffff050c7966`
- suiteSha256: `6fb8a5c6323955201f7e1f7bb82e2730829201ec06ed0c195cc8efbf62ec7757`
- provider: `not applicable`
- model: `not applicable`

Hashes are SHA-256 values of the checked-in prompt source, tool catalog
source, and aggregate P2 recovery/transport/crash-suite source set.

## Product result

The renderer-owned runtime now persists canonical sessions, turns, complete
messages, immutable journal entries, tool-call lifecycle rows, and exact
provider checkpoints in SQLite. The production path is:

```text
agent-chat-store
  -> LocalGeneralAgentTransport
  -> RepositoryAgentTransportPersistence
  -> AgentRuntimePersistenceRepository
  -> SQLite canonical rows and immutable journal
```

An accepted prompt and its turn row commit atomically before provider startup.
After restart, provider history is reconstructed only from canonically
completed turns. Failed or interrupted turns, streamed partial assistant text,
and display-cache JSON are never promoted into model context.

`runtimeSessionId` is the new provider-neutral resume identity. The legacy
`sdkSessionId` remains readable for old data but is never reinterpreted as a
runtime session. Durable chat routes require both project and conversation
ownership; cross-route resume fails before provider invocation.

Provider or model changes advance `providerEpoch`. A terminal `done` event is
withheld from the UI until the canonical turn commit succeeds.

## Deterministic recovery acceptance

- lifecycle markers: `10`
- deterministic seeds per marker: `20`
- crash cases: `200 / 200`
- real child-process `SIGKILL`: `200`
- accepted prompt loss: `0`
- duplicate tool calls/results: `0`
- orphan tool calls/results: `0`
- duplicate terminal events: `0`
- event sequence gaps: `0`
- corrupt sessions: `0`
- partial assistant content in complete provider history: `0`
- foreign-key violations: `0`
- SQLite integrity failures: `0`
- canonical killed/graceful hash mismatches: `0`

The ten crash markers cover accepted prompt, running turn, partial assistant,
tool call, tool ready, tool execution, tool result, final assistant delta,
terminal journal, and canonical turn commit.

The harness creates a fresh temporary file-backed SQLite database from the
checked-in `0060_agent_runtime_persistence.sql` migration for every case. It
starts a writer process, kills it at an acknowledged committed boundary, then
uses a separate recovery process and compares the result with an independently
recovered graceful reference.

## 10,000-event recovery gate

- event count: `10,000`
- samples: `20`
- stable canonical hash: `true`
- violations: `0`
- worker median: `51.23 ms`
- worker p95: `54.36 ms`
- worker max: `56.87 ms`
- end-to-end median: `94.77 ms`
- end-to-end p95: `97.59 ms`
- end-to-end max: `105.48 ms`
- required p95 threshold: `< 2,000 ms`

Sanitized result:
`docs/agent-runtime/acceptance/p2-crash-summary.json`.

## Recovery policy

- Only a turn with canonical `completed` state and a valid terminal journal
  contributes to future provider history.
- A terminal journal without the atomic database commit is conservatively
  recovered as `interrupted`; it is never inferred to be completed.
- In-flight reads recover as `interrupted`.
- A write that entered execution recovers as `uncertain` and is never retried
  blindly.
- Orphan completed tool calls receive one deterministic interrupted result;
  results without a corresponding call are discarded from provider history.
- Checkpoints require exact SHA-256 verification and exact canonical context.
- Recovery plans use compare-and-set preconditions and are idempotent.
- UI transcript reconstruction uses normalized canonical rows, not
  `messagesJson`.

## Regression gates

- targeted P2 runtime/persistence suite: `6 files / 45 tests passed`
- Agent Runtime aggregate: `13 files / 99 tests passed`
- Core full test: `56 files / 303 tests passed`
- Core TypeScript check: passed
- targeted ESLint: passed with `0` warnings
- `git diff --check`: passed

## Manual signoff and open risks

- manualSignoff: `pending user UI smoke`
- Event append and tool lifecycle projection are currently two durable steps.
  A crash between them is repaired deterministically from the immutable
  journal; a future compound repository transaction can remove this recovery
  window.
- P2 checkpoints intentionally represent uncompressed exact history. P4 must
  extend checkpoint validation for pinned/compressed context without weakening
  hash, tool-pair, or freshness invariants.
- No write tool is certified by P2. P3 owns durable idempotency, mutation
  receipts, approval/review state, exact or compensating revert, and Yjs write
  recovery.
