# Drifting Agent Runtime roadmap

This file is the durable milestone policy and current work ledger. The detailed
product boundary lives in
[`acceptance/CURRENT_STATUS.md`](acceptance/CURRENT_STATUS.md); exact capability
composition lives in the generated inventory.

## Milestone rule

A milestone is complete only when the same change contains:

1. the production implementation;
2. deterministic tests for changed contracts;
3. a headless path, or an explicit native/manual acceptance boundary;
4. updated README, status, commands, and machine-checkable evidence;
5. an explicit list of anything still unverified.

Passing tests while durable documentation still describes previous behavior is
an open milestone.

## Current work

| Area                          | Current boundary                                                                                                                                                                    | Exit evidence                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Native interaction            | Desktop/iOS/Android visual, touch, IME, safe-area, background, and real-device behavior remain manual                                                                               | [`../mobile-device-acceptance.md`](../mobile-device-acceptance.md) and the native QA checklist |
| Long-form quality rerun       | The post-`雾港纪事` deterministic P0 fixes have not been validated by another paid empty-project long-form campaign                                                                 | Dated run plus remediation report linked from current status                                   |
| Editing and handoff follow-up | Stable partial edit recovery, equivalent-create recovery, error guidance, trusted word counts, project-level cross-session handoff, and live-provider compliance with the Working Memory checkpoint remain tracked follow-up | Remediation plan and future deterministic/live evidence |
| Subagents                     | Deferred; not part of the shipped single-product/multi-conversation runtime                                                                                                         | Generated capability inventory                                                                 |

## Evidence map

- Machine-readable composition:
  [`acceptance/agent-capabilities.json`](acceptance/agent-capabilities.json)
- Generated human composition:
  [`acceptance/agent-capabilities.md`](acceptance/agent-capabilities.md)
- Current product and verification boundary:
  [`acceptance/CURRENT_STATUS.md`](acceptance/CURRENT_STATUS.md)
- Durable functional contract:
  [`acceptance/GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md`](acceptance/GENERAL_AGENT_FUNCTIONAL_CHECKLIST.md)
- Completed A-K and P1-P6 history:
  [`acceptance/MILESTONE_HISTORY.md`](acceptance/MILESTONE_HISTORY.md)
- Headless operator workflow: [`headless-debug.md`](headless-debug.md)
- Aggregate commands: [`../../package.json`](../../package.json)

The former A-K sequence is closed or explicitly removed. It is retained as one
historical index rather than seventeen current-looking phase reports.
