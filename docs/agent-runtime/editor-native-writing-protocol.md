# Agent Runtime editor-native writing protocol

Status: normative for Milestone H and later.

This protocol defines how Drifting turns an author's natural writing request
and current editor state into a provider-neutral, immutable mutation boundary.
It also defines the evidence required for literary review, canon evolution and
whole-book QA. The virtual workspace remains an internal execution model; it
is not the product language shown to the author.

## 1. Product-owned authoring focus

At the beginning of every requested turn, the product resolves the active
chapter, drift, element, storyline or category to one canonical prose entity.
The captured focus contains:

- semantic entity kind, identity, name and canonical workspace path;
- focus mode: whole entity, current block or exact text selection;
- stable selected block identities and ordinals;
- the exact selected text;
- bounded prose immediately before and after the focus.

The snapshot is copied into `AgentWritingTurnContext`, frozen with the runtime
context and reused for every tool call in that turn. Navigation or selection
changes during execution do not silently broaden it. An explicit later author
turn is required to bind a different scope.

The product also resolves every current node/entity name and alias explicitly
present in the author's request into a canonical target set. This is separate
from the active pane: it allows a named multi-entity task without pretending
that one editor selection covers all entities. Similar names are not inferred,
and a write outside the resolved set fails closed.

The Agent panel may name this focus semantically, such as “这里指向 · 第十二章
· 已选文字”. It must not expose paths, Yjs versions, receipt ids or filesystem
terminology merely because the internal runtime uses a virtual workspace.

## 2. Intent and ambiguity

The provider-neutral classifier records intent, mutation kind, scope kind,
preservation duties and required evidence. It distinguishes at least:

- advice/inspection from an instruction to mutate;
- polish, rewrite, continuation and summary;
- read-only whole-book QA from whole-book diagnosis plus edits;
- canon evolution and structural operations;
- a concrete editor focus from an unresolved deictic request.

“这里”“这段” or “selected text” with no captured editor focus is not guessed.
Any resulting prose write fails with `WRITING_SCOPE_UNRESOLVED`; the Agent must
ask a focused question. Resource creation with an explicit name remains
available because it does not pretend to resolve existing prose.

## 3. Exact prose mutation boundary

The writing-scope guard runs after a virtual path has resolved to its hidden
domain command and before a certified mutation executes.

- A selection-scoped `edit_file` may replace only exact `oldText` witnessed in
  the selected span.
- Whole-file, direct-block, append, delete or range operations cannot bypass a
  partial selection.
- A block-scoped instruction may target only the captured block identity or
  ordinal.
- A focused instruction cannot mutate a different entity by path, name or id.
- An explicitly named multi-entity instruction may mutate only the complete
  product-resolved name/alias target set.
- Whole-entity work is allowed only when the author explicitly names the
  current chapter/entity scope.

These are execution checks, not prompt advice. An out-of-bound call returns a
stable `WRITING_SCOPE_*` error and performs no write.

## 4. Author voice and rewrite preservation

Nearby prose is the primary author-voice evidence. A compact style profile
describes cadence, paragraph length, sentence length, dialogue, punctuation
and point-of-view signals only to help the provider notice local form. It is
never a formula for manufacturing prose.

Polish, rewrite and continuation preserve plot facts, canon, chronology,
point of view, tense and author voice unless the author explicitly overrides a
dimension. The deterministic continuity score is a mutation detector used by
headless acceptance. It is not a literary-quality verdict and cannot approve
an overwrite on its own.

## 5. Canon impact and sanctioned evolution

The product matches author requests against current entity names and aliases,
then records canon impact as `none`, `low`, `medium` or `high`. Explicit canon
evolution, destructive structural work and named plot changes are high impact.

When `requiresSanctionedPatch` is true, direct prose mutation fails with
`WRITING_CANON_PATCH_REQUIRED`. The Agent must first read current canon and
record the temporal canon/element-patch evolution through the certified domain
path. Prose may embody that accepted truth only after a new explicit author
turn binds its mutation scope. Prose alone is never the authority for changed
canon.

Ordinary reversible prose editing remains automatic and author-visible in the
editor with block-level review/reveal behavior. Destructive structural changes
continue through argument-bound chat permission and durable receipts.

## 6. Semantic summaries and whole-book QA

Every semantic summary, diagnosis or QA verdict distinguishes claims,
findings, inference and unresolved uncertainty. Every claim/finding cites a
non-empty exact quote from current source evidence.

Whole-book durable plans declare an immutable `workKind`:

- `edit`: a step completes only from accepted exact-target write evidence;
- `review`: a step completes only after an exact target read plus a structured
  cited `reviewResult`; it must not manufacture a manuscript edit merely to
  make progress.

For review work, Drifting ignores provider-supplied receipt handles, finds the
latest exact-target read itself, verifies its content hash and pagination
receipts, validates every quote, and binds the product-owned evidence ref. A
forged quote, wrong target, missing page or stale receipt rolls the step
transition back. Verified evidence reconstructs after SQLite reopen.

## 7. Context and compaction

Writing context is rendered into the system envelope before provider I/O. The
exact focus and nearby prose are canonical current-turn evidence. Existing
Milestone F rules still apply: explicit author constraints remain exact,
summaries are source-hash-bound, contradictions block writes and oversized
results use verified durable paging.

Compaction may summarize older literary evidence but may not rewrite the
current immutable focus, author vetoes, active task state or accepted review
facts. Steering affects the next model boundary; it does not retroactively
change the current turn's captured edit boundary.

## 8. Headless acceptance and privacy

Run:

```bash
pnpm --dir client eval:agent:writing
```

The gate covers:

- a deterministic Chinese/English author-intent and ambiguity oracle;
- editor-selection capture and cross-entity/span/block negative cases;
- canon-patch-required fail-closed behavior;
- provider context, `workKind` and product focus integration;
- synthetic voice-preserving baselines and voice-flattening mutations;
- exact citations plus forged-quote mutations;
- real file-backed SQLite review completion, fault rollback and restart;
- typecheck, scoped lint and generated capability drift.

When the local `雾港纪事` fixture is available, it is read only inside the test
process. The report stores only counts, byte totals and aggregate scores; it
never stores manuscript prose.

## 9. Explicit boundary

This milestone proves product-owned scope and evidence, not that heuristics can
judge beautiful writing. A paid live-provider canary is useful but remains
separate from the deterministic gate. Multi-provider conformance and concrete
MCP lifecycle are Milestone I. Desktop/iOS/Android interaction and long-running
real-book endurance are Milestone J.
