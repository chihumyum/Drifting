# Milestone B exit report — tool-call reliability

Date: 2026-08-02

## Result

Milestone B is complete. The provider/tool boundary now treats a model tool
call as a leased, canonical, fully assembled operation rather than trusting a
name and partial JSON fragments opportunistically. Recoverable model mistakes
receive one schema-visible repair iteration; runtime or policy drift remains
fail-closed.

The machine-readable acceptance result is
[`milestone-b-tool-reliability.json`](milestone-b-tool-reliability.json).

## Production contracts closed

- The complete installed definition set is frozen at turn start. Every
  provider iteration selects from that set, and the composite runtime binds
  each built-in execution to the exact owner, access class, schema,
  description, and inner revision that was selected.
- Runtime-discovered MCP/plugin tools retain their existing source-generation
  lease. A definition replacement between selection, approval, and execution
  cannot consume stale authority.
- Only executable dispatcher aliases may normalize to a canonical tool name.
  Search terms and human labels remain non-executable and unknown names fail
  closed.
- Streamed arguments are accumulated independently by call id, bounded by
  bytes, parsed only after `tool_call_end`, required to be a JSON object,
  validated by the local definition, normalized to portable data, and emitted
  once to the canonical journal.
- If a globally installed tool was omitted by tool search, or its arguments
  were empty, malformed, wrongly shaped, schema-invalid, or too large, that
  canonical definition is forced into the next provider iteration for one
  repair attempt. A truly unknown name is never admitted.
- Two identical all-failed tool rounds still remove tool access and require an
  honest synthesis. This avoids an infinite malformed-call loop without adding
  a normal task-round or token ceiling.
- Adjacent reads remain concurrent, writes remain globally serialized with
  read/write barriers, and canonical result ordering remains deterministic.
- Write delivery retains the stable `sessionId:turnId:callId` idempotency key.
  Duplicate committed delivery returns the durable result without re-running
  the mutation; uncertain entered writes require reconciliation.
- Verified compaction does not erase the selected executable tool surface on
  the following model iteration.

## Headless acceptance

Run from the repository root:

```bash
pnpm --dir client eval:agent:tool-reliability
```

The command replays provider wire shapes deterministically, including
single-character JSON chunks and two interleaved calls. It then runs the
durable idempotency/recovery and context-compaction suites plus the complete
workspace TypeScript check. The runner requires 13 named contract assertions;
merely discovering green test files is insufficient.

Observed result for the generated report:

- 8 required test files discovered;
- 134/134 tests passed;
- 13/13 named reliability gates passed;
- TypeScript passed;
- targeted milestone ESLint passed;
- full Core suite: 120 files / 781 tests passed;
- generated capability composition/drift gate: 1 file / 2 tests passed;
- source-set hash recorded in the JSON report.

## Explicit boundaries

- No network provider call is required for this protocol milestone. Captured
  provider stream shapes are deterministic here; live multi-provider
  conformance belongs to milestone I.
- No native UI behavior changed in this milestone. Desktop/iOS/Android native
  smoke belongs to milestone J.
- A repair lease helps the model correct one call; it does not invent missing
  required values or reinterpret destructive intent.
- This milestone does not broaden domain CRUD. Missing entity, relation,
  comment/TODO, memory, and structural transactions remain milestone D work.

The next milestone is C: durable commit, review, restart, and concurrent-author
correctness under fault injection.
