# General Agent milestone history

This is a compact historical index. It does not define current capability or
acceptance. Use [`CURRENT_STATUS.md`](CURRENT_STATUS.md) and the generated
[`agent-capabilities.md`](agent-capabilities.md) for current claims.

The former individual `MILESTONE_*_EXIT_REPORT.md` and `P*_*.md` files were
removed from the active documentation tree after their stable conclusions and
evidence links were consolidated here. Their complete original text remains in
Git and can be inspected with:

```bash
git log -p -- docs/agent-runtime/acceptance/<report>.md
```

## A-K milestones

| ID  | Historical outcome                                                            | Retained evidence or current contract                                                                                                                         |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Capability truth completed                                                    | Generated [`agent-capabilities.json`](agent-capabilities.json) and [`agent-capabilities.md`](agent-capabilities.md)                                           |
| B   | Tool-call reliability completed                                               | [`milestone-b-tool-reliability.json`](milestone-b-tool-reliability.json)                                                                                      |
| C   | Durable commit and inline review completed                                    | [`../durable-commit-review-protocol.md`](../durable-commit-review-protocol.md), [`milestone-c-durable-review.json`](milestone-c-durable-review.json)          |
| D   | Domain CRUD and structural transactions completed                             | [`../domain-crud-transaction-protocol.md`](../domain-crud-transaction-protocol.md), [`milestone-d-domain-crud.json`](milestone-d-domain-crud.json)            |
| E   | Durable long-task execution completed                                         | [`../long-task-execution-protocol.md`](../long-task-execution-protocol.md), [`milestone-e-long-task.json`](milestone-e-long-task.json)                        |
| F   | Provider-aware context engineering completed                                  | [`../context-engineering-protocol.md`](../context-engineering-protocol.md), [`milestone-f-context-engineering.json`](milestone-f-context-engineering.json)    |
| G   | Agent checkpoint/rewind/fork product removed                                  | [`../entity-snapshot-history.md`](../entity-snapshot-history.md); the current baseline excludes the retired objects and retirement acceptance guards that boundary |
| H   | Original scope/canon gate retired; author-owned writing policy completed      | [`../author-owned-writing-policy.md`](../author-owned-writing-policy.md), [`milestone-h-writing-intelligence.json`](milestone-h-writing-intelligence.json)    |
| I   | Provider and MCP extension platform completed                                 | [`../provider-extension-protocol.md`](../provider-extension-protocol.md), [`milestone-i-provider-extension.json`](milestone-i-provider-extension.json)        |
| J   | Native build plus accelerated 4h/12h workload-equivalent automation completed | [`../native-endurance-acceptance.md`](../native-endurance-acceptance.md), `milestone-j-*.json`; physical-device interaction remained manual                   |
| K   | Standard-context long-task reliability completed                              | [`GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md`](GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md); E4 interaction and paid 1M remained explicit boundaries           |

## P1-P6 phases

| Phase | Historical scope                                        | Why it is not current truth                                                                               |
| ----- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| P1    | DeepSeek read-only runtime and first paid corpus gate   | Predates durable writes, current domain tools, provider expansion, and current schemas                    |
| P2    | Canonical journal and crash recovery                    | The recovery invariant remains, but counts and schema identities were phase-specific                      |
| P3    | First write-certified runtime and guarded Yjs reversal  | Superseded by the broader durable review and CRUD contracts                                               |
| P4    | Provider-neutral context, tool selection, and freshness | Superseded by current generated tools and context protocol                                                |
| P5    | Single-Agent long-task slice                            | Its own report marked capability counts and permission/provider boundaries as superseded                  |
| P6    | First mounted product loop                              | Predates Anthropic/OpenAI certification, authored-object tools, concurrency, and current context handling |

The corresponding `p1-` through `p6-*.json` artifacts remain temporarily
because phase commands still reference some output paths. Retire or retarget
those commands before removing their machine evidence.

## Dated non-reproducible evidence

- [`GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md`](GENERAL_AGENT_ACCEPTANCE_RUN_2026-08-02.md)
- [`GENERAL_AGENT_REASONING_STRESS_RUN_2026-08-03.md`](GENERAL_AGENT_REASONING_STRESS_RUN_2026-08-03.md)
- [`GENERAL_AGENT_DOMAIN_REASONING_STRESS_RUN_2026-08-04.md`](GENERAL_AGENT_DOMAIN_REASONING_STRESS_RUN_2026-08-04.md)
- [`OPENAI_NATIVE_TRANSPORT_RUN_2026-08-05.md`](OPENAI_NATIVE_TRANSPORT_RUN_2026-08-05.md)
- [`CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md`](CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md)
- [`GENERAL_AGENT_PEAK_PERSON_NOVEL_RUN_2026-08-06.md`](GENERAL_AGENT_PEAK_PERSON_NOVEL_RUN_2026-08-06.md) and its active remediation plan

These reports prove only their recorded checkout, provider, fixture, and
evidence level. They must never override current generated composition.
