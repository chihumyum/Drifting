# Drifting Agent Runtime roadmap

This file is the durable execution ledger for closing the gap between the
current Drifting Agent Runtime, a Claude Code-grade runtime, and an editor-native
long-form writing Agent.

## Milestone rule

A milestone is complete only when the same change contains all of the
following:

1. the production implementation;
2. deterministic tests for the changed contracts;
3. a headless acceptance path, or a precise explanation of the native/manual
   evidence that cannot be automated;
4. updated README, status/exit report, command documentation, and generated
   capability evidence affected by the change;
5. an explicit list of anything still unverified.

Passing unit tests while durable documentation describes older behavior is a
failed milestone. Capability counts and status prose must be generated from, or
machine-checked against, the final product composition whenever possible.

## Ordered milestones

| ID  | Milestone                       | Exit condition                                                                                                                                       | Status      |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| A   | Capability truth                | Final composition, executable ownership, generated inventory, README and acceptance evidence agree.                                                  | Completed   |
| B   | Tool-call reliability           | Stable per-iteration tool lease, canonical aliases, strict streamed arguments, recoverable model mistakes, idempotent retries.                       | Completed   |
| C   | Durable commit and review       | Effects, context adoption, review settlement, restart recovery and concurrent author edits remain unambiguous under fault injection.                 | Completed   |
| D   | Domain CRUD closure             | Storyline membership, comments/TODOs, relations, memory and guarded structural transactions have complete create/read/update/delete/revert paths.    | Completed   |
| E   | Long-task execution             | Durable plans can continue, pause, steer, survive restart and finalize without repeating accepted work or silently skipping manifest changes.        | Completed   |
| F   | Context engineering             | Provider-aware budgeting, literary compaction evaluation, constraint confirmation, evidence retrieval and artifact paging pass long-book acceptance. | Completed   |
| G   | Agent checkpoint and fork       | Retired: rely on entity snapshot history for manuscript recovery and keep conversations as independent flat sessions.                              | Removed     |
| H   | Author-owned writing policy     | No hidden writing defaults, editor-focus binding, content-scope guard or canon gate; author rules are ordinary editable project data.               | Completed   |
| I   | Provider and extension platform | Provider conformance plus concrete MCP transports/configuration, durable grants and extension lifecycle are shipped and isolated.                    | Completed   |
| J   | Native and endurance acceptance | Desktop/iOS/Android smoke, network/restart/concurrency faults and 4h/12h real-book endurance gates are recorded.                                     | Completed   |

Milestones are executed in this order unless a discovered correctness bug makes
an earlier invariant unsafe. Subagents are intentionally not a blocker for the
single-Agent writing product and remain deferred until the single-Agent gates
above are closed.

## Evidence locations

- Generated capability inventory: `acceptance/agent-capabilities.json` and
  `acceptance/agent-capabilities.md`
- Current milestone report: `acceptance/CURRENT_STATUS.md`
- Historical phase reports: `acceptance/P*_*.md`
- Headless product bridge: `headless-debug.md`
- Aggregate commands: `package.json`

Historical reports are immutable evidence of what a past gate asserted. They
may contain a prominent superseded notice, but current capability claims belong
in the generated inventory and `CURRENT_STATUS.md` rather than being copied by
hand into every historical report.

## Milestone reports

- A: [`acceptance/MILESTONE_A_EXIT_REPORT.md`](acceptance/MILESTONE_A_EXIT_REPORT.md)
- B: [`acceptance/MILESTONE_B_EXIT_REPORT.md`](acceptance/MILESTONE_B_EXIT_REPORT.md)
- C: [`acceptance/MILESTONE_C_EXIT_REPORT.md`](acceptance/MILESTONE_C_EXIT_REPORT.md)
- D: [`acceptance/MILESTONE_D_EXIT_REPORT.md`](acceptance/MILESTONE_D_EXIT_REPORT.md)
- E: [`acceptance/MILESTONE_E_EXIT_REPORT.md`](acceptance/MILESTONE_E_EXIT_REPORT.md)
- F: [`acceptance/MILESTONE_F_EXIT_REPORT.md`](acceptance/MILESTONE_F_EXIT_REPORT.md)
- G: [`acceptance/MILESTONE_G_EXIT_REPORT.md`](acceptance/MILESTONE_G_EXIT_REPORT.md)
- H: [`acceptance/MILESTONE_H_EXIT_REPORT.md`](acceptance/MILESTONE_H_EXIT_REPORT.md)
- I: [`acceptance/MILESTONE_I_EXIT_REPORT.md`](acceptance/MILESTONE_I_EXIT_REPORT.md)
- J: [`acceptance/MILESTONE_J_EXIT_REPORT.md`](acceptance/MILESTONE_J_EXIT_REPORT.md)
