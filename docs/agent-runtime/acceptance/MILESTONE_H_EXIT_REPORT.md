# Milestone H replacement exit report: author-owned writing policy

Status: **Completed**
Date: 2026-08-02

## Why the original H was retired

The original milestone bound editor focus, selection, nearby prose, inferred
intent, default preservation rules and canon policy into an immutable runtime
contract. It could reject a correct model action merely because a different
chapter had previously been open. The observed regression read the requested
Drift `灵感碎片` correctly, then rejected two attempts to append to it with
`WRITING_SCOPE_ENTITY_MISMATCH` because stale chapter `00` was treated as the
only authorized entity.

That is product-authored writing policy, not data safety. It has been removed.

## Removed

- `product-authoring-focus.ts` and its Agent Panel focus chip;
- `writing-intelligence.ts` intent/deictic/style/default-preservation layer;
- `writing-scope-guard.ts` and every `WRITING_SCOPE_*`/
  `WRITING_CANON_PATCH_REQUIRED` write gate;
- automatic manuscript-language injection;
- product-derived voice diagnostics as a runtime/acceptance requirement;
- automatic author-rule contradiction detection that blocked all writes;
- the system-prompt canon-patch requirement and hidden default writing rules.

The runtime/protocol no longer accepts `writingContext`. Tool execution context
contains the project route, not global UI focus.

## Retained

- project isolation;
- live Yjs prose writes;
- revision/CAS concurrency checks;
- effect idempotency and durable receipts;
- inline prose Review/reveal and exact inverse;
- destructive-operation permission;
- long-task, context compaction and internal runtime-recovery continuity.

These protect data and truthful execution without telling the model how to
write.

## Author rule chain

- Project Dashboard `kvJson`: author-editable project facts/rules.
- Settings / Agent menu “Rules”: author-created rules are immediately active;
  Agent proposals remain pending until approval; all rules can be deleted.
- Each turn loads only current active rows and injects them verbatim.
- New projects contain no hidden product rules. Any future starter rules must
  be visible ordinary data and remain editable/deletable.

The normative contract is
[`../author-owned-writing-policy.md`](../author-owned-writing-policy.md).
The machine evidence is
[`milestone-h-writing-intelligence.json`](milestone-h-writing-intelligence.json).

## Regression acceptance

The product-composition test now creates a real Drift named `灵感碎片`, reads
its current prose through the workspace facade, applies an exact append, and
asserts that no tool result failed. No editor focus or writing scope is supplied
to the turn.

Run:

```bash
pnpm --dir client eval:agent:writing
```

The generated report records the current test count, source-set hash,
typecheck, scoped lint and capability-drift result. The optional paid canary now
tests an author-supplied edit instruction without any product-imposed selection
scope.

Current result:

- 6/6 required test files discovered;
- 34/34 tests passed;
- all 6 named invariants matched exactly once;
- TypeScript, scoped ESLint and generated capability drift passed;
- source-set hash:
  `sha256:5d40416c168670193542aa6a45d13c836a40ff0b135a1d52bf9e2af952696394`.
