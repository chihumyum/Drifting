# Milestone H exit report: editor-native writing intelligence

Status: **Completed**
Date: 2026-08-02

## Outcome

The General Agent now receives a product-owned writing contract rather than
inferring scope only from chat text or internal workspace paths. Every requested
turn binds the active semantic editor entity, exact selection/block, nearby
voice evidence and explicitly named current entities before provider I/O.
Ambiguous, out-of-scope and patch-required canon writes fail before a certified
mutation. Read-only whole-book QA can now complete durably from verified cited
reads without manufacturing manuscript edits.

The normative contract is
[`../editor-native-writing-protocol.md`](../editor-native-writing-protocol.md).
The machine evidence is
[`milestone-h-writing-intelligence.json`](milestone-h-writing-intelligence.json).

## Shipped

- Editor selection memory captures exact selected text, stable block identity,
  ordinal and bounded neighboring prose. The product maps the active node,
  element, storyline or category pane to its canonical prose entity.
- Current entity names and aliases named by the author resolve to a canonical
  one-or-many target set. This supports explicit cross-entity work without
  treating an arbitrary open editor as global authority.
- Provider-neutral intent records mutation kind, semantic scope, ambiguity,
  preservation duties, evidence needs and canon impact. Advice is separated
  from mutation; read-only and editing whole-book work receive distinct
  `workKind` instructions.
- The frozen runtime tool context carries exact focus, target set, nearby prose
  and a diagnostic local style profile through every call in the turn.
- A pre-write scope guard rejects missing deictic focus, another entity,
  out-of-selection replacement, direct block/whole-file bypass, and a
  substitution outside explicitly named targets.
- Explicit named canon/plot evolution sets
  `requiresSanctionedPatch`. Direct prose then fails with
  `WRITING_CANON_PATCH_REQUIRED`; the accepted temporal evolution and a new
  author turn are required before prose may embody it.
- Long-task schema v3 persists immutable `workKind`, structured cited review
  results and product-owned read evidence. `edit` steps still require accepted
  writes; `review` steps require exact current-target reads.
- Review completion ignores provider receipt handles, verifies SHA-256 and all
  pagination receipts, validates every exact quote, rolls forged evidence back,
  and reconstructs evidence after a real SQLite reopen.
- The Agent panel exposes a compact semantic authoring-focus chip and keeps
  paths, ids, Yjs and receipt concepts out of author-facing language.
- Capability schema v6 publishes the writing-intelligence contract. A
  network-free aggregate runner and an optional isolated DeepSeek writing
  canary are available.

## Automated acceptance

Run:

```bash
pnpm --dir client eval:agent:writing
```

Result:

- 11/11 required files discovered;
- 75/75 milestone tests passed;
- all 11 named invariant assertions matched exactly once;
- TypeScript, scoped ESLint and generated capability drift checks passed;
- the author-intent oracle passed 25/25 Chinese/English cases;
- 19 voice samples were evaluated, including 16 read-only local
  `雾港纪事` samples; identical median was 1.0, flattened median was 0.2416,
  and mutation detection was 100%;
- the private fixture exposed 17 files / 297,247 bytes to the test process, but
  no manuscript prose was persisted in the report;
- the exact semantic result was accepted and 12/12 forged citation mutations
  were rejected;
- real file-backed SQLite proved exact-target read binding, incomplete/forged
  evidence rollback and restart recovery;
- the real product composition proved inline review, automatic reveal and
  explicit one-or-many target writes under the new context boundary.

The report's source-set hash is
`sha256:26fc85d54b01b6619e28ebeac1218c3d930ffc57a5afe00b95e79a63b57b4b6e`.

Full Core regression after the implementation:

```bash
pnpm --dir client test
pnpm --dir client lint
```

Result: **132 files, 854/854 tests passed**. Full Core ESLint reports **0
errors and 41 pre-existing warnings**; the H-scoped files pass cleanly.

## Optional paid canary

`pnpm --dir client eval:agent:writing:live` runs one synthetic selected
sentence through the configured DeepSeek provider and requires read-before-edit
plus an exact selection-bound write. It is deliberately not part of the
network-free exit gate and was not invoked while closing H, so this milestone
does not claim live provider conformance or incur an API call implicitly.

## Explicitly unverified here

- The deterministic style score detects severe flattening; it does not judge
  beauty, originality or whether a rewrite is subjectively better.
- The current intent oracle is a bounded safety classifier, not a general NLU
  benchmark. Unknown requests may still require provider reasoning or author
  clarification.
- Live multi-provider conformance, provider-specific token/accounting quirks,
  concrete MCP transports/configuration, durable broader grants and extension
  isolation remain Milestone I.
- Native desktop/iOS/Android visual interaction, lifecycle behavior and 4h/12h
  real-book endurance remain Milestone J.

Milestone I, provider and extension platform, is now active.
