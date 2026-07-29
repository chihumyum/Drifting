# P1 Exit Report — DeepSeek / OpenAI-compatible read-only Agent

## Identity

- phase: `P1`
- status: `accepted`
- adapterCommitSha: `7c445e65`
- productWiringCommitSha: `cd627bba`
- acceptanceCommitSha: `self`
- runtimeSchemaVersion: `1`
- promptVersion: `1`
- promptSourceSha256: `6c41ebfdd703ad9ac8045e9d591b5e181c991c3807b7249dee920b234dee6b6e`
- toolCatalogSourceSha256: `41575e4c95706ae62fa11a5fc7523492da21a33a750e9dba442fffff050c7966`
- suiteSha256: `ea2df8887aee6ec5ad88a585295d121996df7083310acd5a4b3fe7eeb2e2407c`
- provider: `deepseek`
- model: `deepseek-v4-flash`
- thinking: `false`

Hashes are SHA-256 values of the checked-in prompt source, read-tool catalog
source, and the aggregate P1 test/eval source set respectively.

## Product result

The Tauri renderer now installs the provider-neutral local runtime behind the
existing `GeneralAgentTransport` seam. The production path is:

```text
CompanionPanel / agent-chat-store
  -> LocalGeneralAgentTransport
  -> AgentRuntime
  -> DriftingAgentModelDriver
  -> LLMClient + DeepSeekProvider
  -> DriftingReadToolRuntime
  -> runAgentTool
  -> live renderer stores / repositories
```

Credentials remain local. The product driver resolves the shared DeepSeek BYOK
key only when a turn starts, builds a fresh client per turn, and never follows
the hosted proxy flag. P1 exposes only read-certified tools. No `AgentWriteApi`
capability is handed to the model-facing adapter.

An accepted user message is persisted before provider startup. If a P1
in-memory session id is stale after a renderer restart, the saved conversation
remains usable and starts a fresh model session. Canonical history recovery is
the P2 responsibility.

## Deterministic acceptance

- registered read tools: `15`
- normal schema coverage: `15 / 15`
- empty schema/result coverage: `15 / 15`
- invalid schema coverage: `15 / 15`
- invalid calls reaching dispatcher: `0`
- real `runAgentTool` dispatcher coverage: `15 / 15`
- `AgentWriteApi` calls during real-dispatcher reads: `0`
- domain store mutation during real-dispatcher reads: `0`
- cross-project fixture leakage: `0`
- concurrent isolation: `50 sessions x 20 turns = 1,000 turns`
- session crosstalk: `0`
- peak concurrent model streams: `50`
- replay corpus: `10,000 events`
- replay seq gaps: `0`
- replay duplicate seq/event ids: `0`
- replay state mismatch: `0`
- oversized Unicode result: `12,002 code points`
- oversized result contract: explicit `truncated + resultRef + reread`
- extra dispatcher calls while paging: `0`

The real-dispatcher test includes project overview/brief, nodes and prose,
elements and patches, storylines and relations, comments, memory, prose search,
project search, and materials. Fixtures include Chinese, emoji, empty content,
long content, not-found cases, and a foreign-project sentinel.

## Live model acceptance

Command:

```bash
pnpm --dir client eval:agent:p1:live
```

The launcher reads only `DEEPSEEK_AI_API_KEY` from the ignored
`private-service/.env`, passes it to one isolated Vitest child process, and does
not print or persist the value.

- read tasks: `20 x 3 = 60`
- safety tasks: `2 x 3 = 6`
- read success: `57 / 60 = 95%`
- total success: `63 / 66 = 95.45%`
- required threshold: `>= 90%`
- unauthorized writes: `0`
- cross-project violations: `0`
- unknown tool executions: `0`
- fixture mutations: `0`
- input tokens: `323,374`
- output tokens: `7,437`
- total tokens: `330,811`
- billed cost: unavailable in provider response
- median latency: `1,831 ms`
- p95 latency: `3,792 ms`
- max latency: `6,584 ms`

All three strict misses were the same not-found task. The model called
`list_materials`, correctly determined that the requested title was absent,
and did not fabricate data; the evaluator required the narrower
`read_material` path. This is a non-safety tool-selection variance and leaves
the measured read success above the phase threshold.

Sanitized summary:
`docs/agent-runtime/acceptance/p1-live-summary.json`.

The full local artifact is ignored by Git:
`.local-data/evals/p1-deepseek-live.json`.

## Regression gates

- Agent runtime: `10 files / 76 tests passed` including the real-dispatcher
  integration suite. The credentialed eval is a separate opt-in suite.
- Core full test: `52 files / 274 tests passed`.
- workspace typecheck: passed for Core and Server.
- workspace lint: exit `0`; existing baseline warnings remain
  (`Core: 42`, `Server: 11`), with `0` warnings in P1-targeted files.
- JSON locale parsing and `git diff --check`: passed.

## Manual signoff and open risks

- manualSignoff: `pending user UI smoke`
- The renderer/store/transport path is automated, but no claim is made that the
  user has visually signed off the right-rail chat in this run.
- P1 model history remains memory-resident. A restart preserves the accepted
  transcript but starts fresh model context; P2 replaces this with canonical
  session recovery.
- Oversized result bodies are held in a bounded in-memory result store. P2/P4
  persistence and context planning will make recovery/compaction explicit.
- P1 is intentionally read-only. No write tool is certified or exposed.
