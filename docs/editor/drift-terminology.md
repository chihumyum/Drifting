# Drift terminology

## Product contract

- `Drift` remains the canonical internal domain name used by TypeScript identifiers,
  database fields, tool kinds, and the `/drifts` Agent workspace path.
- The Simplified Chinese product label for a Drift is **灵感**. Use it consistently in
  navigation, editors, menus, dialogs, statistics, timeline bindings, graph actions,
  Agent activity, and Chinese author-facing Agent responses.
- `灵感`, `漂移`, `inspiration`, and `drift` remain accepted author-input aliases for the
  same Drift entity. In Chinese output, prefer `灵感`.
- This terminology change does not migrate persisted data or change API/tool contracts.

## Acceptance

`src/renderer/locales/drift-terminology.acceptance.test.ts` verifies the principal locale
keys, Agent-facing labels, and this contract. It also scans renderer source and durable
documentation so the retired Chinese label cannot silently return.

Run it with:

```bash
pnpm exec vitest run src/renderer/locales/drift-terminology.acceptance.test.ts
```
