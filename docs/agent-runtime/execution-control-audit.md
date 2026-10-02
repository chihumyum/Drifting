# Agent execution control audit

Scope: default General Agent execution, provider output parameters, context
planning/compaction, and automatic continuation (2026-10-01). The criterion is
whether a client estimate can masquerade as a provider capability, truncate
otherwise valid work, or repeatedly retry an unchanged local failure.

| Finding | Result |
| --- | --- |
| Subscription discovery invented a 4,096-token maximum | Unknown output metadata is null. No OAuth output cap is sent. |
| Runtime always requested at most 8,192 output tokens | Default per-call ceiling is null, like existing aggregate limits. Optional wire parameters are omitted. |
| Summary generation always requested at most 1,024 tokens | Default summary calls are also uncapped; explicit caller limits remain supported. |
| Output headroom was checked as if it were a provider request | Planning reserve remains local. Only explicit limits are compared with known provider maxima; conflicts fail once. |
| Compactor errors/circuit-open and initial input overflow requested continuation | They now fail without automatic replay. Later physical boundaries may checkpoint progress and continue. |
| Anthropic requires an output parameter | Use the selected model's declared maximum, or an explicit caller ceiling. No invented 8k fallback in the Agent driver. |
| Anthropic's real context-window stop was treated as unknown failure | Normalize `model_context_window_exceeded` as a resumable physical boundary, with persisted progress. |
| Iteration/tool/aggregate token/cost/duration limits | Already null by default. Explicit caller limits and cancellation remain effective. |
| Context, tool argument limits, result paging, retries | Context uses the full selected model declaration; Standard/Max caps are removed. Payload integrity, recoverable paged results, and bounded pre-effect transport/protocol retries remain. These are not default generation budgets. |

Synthetic evidence exercises discovery/unresolved model paths through the real
Responses driver and runtime: tool call, result return, 16,384 output tokens per
invocation, natural final completion, and no `max_output_tokens` on either
request. Adapter regressions cover optional-cap omission, explicit-cap forwarding,
and Anthropic's required model maximum. Runtime regressions cover preserved
explicit limits, invalid metadata, compaction circuit isolation and initial
overflow without continuation. Existing suites cover cancellation, bounded
caller execution, paging, and pre-effect retry behavior.

Sources: `codex-model-catalog.test.ts`, `runtime-context-planning.test.ts`,
`runtime.test.ts`, `drifting-context-compactor.test.ts`, and the three provider
driver suites. `agent-capabilities` is generated from the executable contracts.
These tests use synthetic transport responses; they do not certify real-account
inference or the desktop UI. The required Anthropic parameter is documented in
the [Messages API](https://platform.claude.com/docs/en/api/messages/create), and
physical overflow in [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows).
