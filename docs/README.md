# Drifting Core documentation

This directory contains current product contracts, architecture notes, runbooks,
and acceptance evidence. Current behavior must be read from the sources below;
dated run reports are evidence for one checkout, not product truth.

## Start here

| Question                                            | Source                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do I build and run the client?                  | [`../README.md`](../README.md)                                                                                                                                        |
| What does General Agent support now?                | [`agent-runtime/acceptance/CURRENT_STATUS.md`](agent-runtime/acceptance/CURRENT_STATUS.md)                                                                            |
| What tools and capability counts ship?              | Generated [`agent-capabilities.md`](agent-runtime/acceptance/agent-capabilities.md) and [`agent-capabilities.json`](agent-runtime/acceptance/agent-capabilities.json) |
| What is the current milestone policy and open work? | [`agent-runtime/ROADMAP.md`](agent-runtime/ROADMAP.md)                                                                                                                |
| What are the renderer dependency rules?             | [`renderer-ui-architecture.md`](renderer-ui-architecture.md)                                                                                                          |
| What is the mobile product boundary?                | [`mobile-ui-foundation.md`](mobile-ui-foundation.md)                                                                                                                  |
| What still needs physical-device testing?           | [`mobile-device-acceptance.md`](mobile-device-acceptance.md)                                                                                                          |
| What is historically complete?                      | [`agent-runtime/acceptance/MILESTONE_HISTORY.md`](agent-runtime/acceptance/MILESTONE_HISTORY.md)                                                                      |

## Normative documents

- `agent-runtime/*-protocol.md`, `author-owned-writing-policy.md`, and
  `entity-snapshot-history.md` define runtime invariants.
- [`design-system.md`](design-system.md) and `editor/*.md` define durable UI and
  editor contracts that are not obvious from a screenshot.
- [`ai-provider-settings.md`](ai-provider-settings.md) defines credential and
  provider-routing ownership.
- [`../src-tauri/UNSUPPORTED.md`](../src-tauri/UNSUPPORTED.md) defines explicit
  platform limitations.

## Evidence policy

- Generated capability files and deterministic acceptance JSON are checked-in
  machine evidence. Do not edit generated files by hand.
- Dated paid-provider, real-project, or native run reports may remain when the
  evidence cannot be reproduced in an ordinary local test run.
- Completed phase and milestone prose is summarized in one historical index;
  full deleted reports remain recoverable from Git.
- README and current-status documents link to authoritative detail instead of
  copying tool counts, test counts, or completed milestone narratives.
