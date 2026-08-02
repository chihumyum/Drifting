# Milestone F exit report: literary context engineering

> Supersession note, 2026-08-02: the historical automatic contradiction
> detector and write gate described below were removed by the author-owned
> writing-policy replacement. Exact author rules are still retained across
> compaction, but the model—not a product regex guard—resolves them.

Status: **Completed**
Date: 2026-08-02

## Outcome

The General Agent now has a provider-aware 200k context pipeline for long-form
writing rather than a static UI number. Canonical history is planned and
verified for every provider call; author truth remains exact across compaction;
long-book evidence can be retrieved semantically; oversized reads survive
restart; and exact author-authored rules survive compaction without becoming a
product-level write gate.

The normative contract is
[`../context-engineering-protocol.md`](../context-engineering-protocol.md). The
machine evidence is
[`milestone-f-context-engineering.json`](milestone-f-context-engineering.json).

## Shipped

- The default driver declares a 200,000-token context window, 8,192-token output
  ceiling and explicit provider/tool framing. A smaller declaration wins; an
  undeclared driver receives a conservative 32,768-token window.
- Every invocation and completed-turn checkpoint uses the same V2 canonical
  bridge, exact selected schemas, output reserve and ten-percent safety margin.
- Direct author goals, instructions, vetoes and facts are source/hash-bound in a
  verified ledger. Checkpoints include an exact retention witness.
- The literary compactor returns schema-v1 synopsis/evidence/decision/unresolved/
  next-action data through one forced tool call. Every tool result requires a
  byte-exact citation. Forged or missing evidence fails closed.
- No-gain short compaction tails remain byte-exact while profitable sibling
  chunks proceed. An all-no-gain, failed or timed-out compactor opens a
  session/provider-epoch circuit and is not retried in a loop.
- Contradictory fact values and overlapping instruction/veto pairs create a
  pinned conflict note. Runtime authorization rejects every write until
  `ask_user` persists a non-blank answer with the exact live conflict IDs.
- `search_project`, `search_prose` and workspace `grep` share weighted mixed
  CJK/Latin ranking, exact phrase/coverage scoring, a small freshness
  tie-breaker, Unicode-safe snippets and revision provenance.
- Truncated tool results expose immutable hash/byte/character metadata and page
  from project/session-scoped SQLite artifacts after close/reopen. Invalid EOF,
  cross-scope, corruption and quota cases fail closed.
- The generated capability schema is now v4 and publishes the executable
  context-engineering contract.

## Automated acceptance

Run:

```bash
pnpm --dir client eval:agent:context
```

Result:

- 11/11 required files discovered;
- 79/79 milestone tests passed;
- all 11 named invariant assertions matched exactly once;
- TypeScript, targeted ESLint and generated capability drift checks passed;
- the local `雾港纪事` fixture was present: 17 Markdown files and 297,247
  bytes; no private prose was written to the report;
- 59/59 literary oracle cases were retrieved at top 5: canon 34/34, character
  voice 8/8, aliases 11/11, writing rules 2/2 and chapter evidence 4/4;
- three 200k context slices ran, two compacted, with 71.96% median token
  reduction and 70.89% maximum window ratio;
- compacted evidence recall, character-voice recall, author-constraint recall,
  source coverage and restart evidence recall were all 1.0;
- six protected author rows retained an exact witness;
- a restarted planner reused verified summaries without another compactor call;
- injected compactor failure ran once and produced zero circuit retries;
- real file-backed SQLite artifact paging and V2 canonical checkpoint recovery
  passed after repository restart;
- write-effect and long-task command replays produced no duplicate mutation.

The report's source-set hash is
`sha256:2c3da6bb5d6415209f42ab1b33426714458721f002aada146e927caaa4ad9b90`.

Full Core regression after the implementation:

```bash
pnpm --dir client test
pnpm --dir client lint
```

Result: **126 files, 824/824 tests passed**. Full Core ESLint reported **0
errors** and 41 existing warnings.

## Explicitly unverified here

- The provider-independent score proves that facts, voice anchors and author
  decisions remain available. It does not claim that a fake provider writes
  beautiful prose. Ambiguity, edit scope, voice imitation, semantic summaries,
  canon impact and whole-book QA are Milestone H.
- Agent-specific manuscript/conversation checkpoint preview, rewind and fork
  were later implemented in Milestone G and subsequently removed in favor of
  independent entity snapshot history and flat Agent sessions.
- Live multi-provider conformance and concrete MCP transports/configuration are
  Milestone I.
- Native desktop/iOS/Android lifecycle plus 4h/12h real-book endurance are
  Milestone J.

Milestone G's historical checkpoint work is recorded separately; it is no
longer a current product capability.
