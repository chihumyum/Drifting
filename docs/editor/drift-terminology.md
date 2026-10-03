# Ideas / 构想 terminology

## Product contract

- `Drift` remains the canonical internal domain name used by TypeScript identifiers,
  database fields, tool kinds, and the `/drifts` Agent workspace path.
- The English feature and collection label is **Ideas**; one item is an **Idea**.
  Actions use sentence case, including **New idea**, **Untitled idea**, and **Bind idea**.
  The product name remains **Drifting**.
- The Simplified Chinese product label for a Drift is **构想**. Use it consistently in
  navigation, editors, menus, dialogs, statistics, timeline bindings, graph actions,
  Agent activity, and Chinese author-facing Agent responses.
- `构想` is the current Chinese author-input name. Legacy input aliases `灵感`,
  `漂移`, `inspiration`, and `drift` continue to resolve the same Drift entity, including
  existing Agent task targets. In Chinese output, use `构想`.
- This terminology change does not migrate persisted data or change API/tool contracts.
- Newly created ideas use the active UI language for their default title. Existing
  author-written titles and manuscript contents are unchanged.

## Acceptance

`src/renderer/locales/drift-terminology.acceptance.test.ts` verifies the principal locale
keys, Agent-facing labels, and this contract. It also scans renderer source and durable
documentation so retired Chinese labels cannot silently return to the active app, and
checks English locale values for retired feature labels independently of internal keys.
Historical QA reports and the paused Apple-native archive retain their original wording;
input parsing retains the explicitly listed legacy aliases.

Run it with:

```bash
pnpm exec vitest run src/renderer/locales/drift-terminology.acceptance.test.ts
```
