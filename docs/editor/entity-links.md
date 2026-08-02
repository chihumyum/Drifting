# Entity Link appearance and hover preview

Entity Links are inline references from chapter prose to an Element, Chapter,
Drift, Patch, Category, or Storyline. Their appearance is an editor preference
and is synchronized with the rest of the user's preferences.

## Appearance modes

`entityLinkColorMode` supports four modes:

- `contextual`: use the referenced entity's owner color. Elements inherit their
  Category color, Chapters their primary Storyline color, and Drifts their Drift
  group color. Categories and Storylines use their own color. Patch links retain
  the CSS fallback because patches are not hydrated in the entity store.
- `kind`: use the user-selected color for each of the six target kinds. The
  colors are stored in `entityLinkKindColors`.
- `hover`: match ordinary prose at rest and reveal the contextual owner-color
  wash only while hovering.
- `prose`: match ordinary prose and retain only a neutral gray underline.

The settings are exposed in Settings > Editor and applied to both the live
TipTap editor and the static all-chapters renderer. `entityLinkInteractive`
continues to control whether Entity Links respond to pointer interaction.

## Shared hover card

`EntityHoverCard` is the single preview surface used by:

- the left Chapter, Drift, and Element panels;
- Entity Links inside the editor;
- Bottom Timeline items.

The card is portaled to `body`, positioned with `position: fixed`, and flips or
clamps to stay inside the viewport. It intentionally has no entity-name header.
It displays the summary first, followed by metadata already available from the
renderer store. Its maximum height is `min(720px, viewport - 24px)` so summaries
can expand substantially before the card scrolls.

The metadata model performs no database query. It can show chapter status, word
count and storyline membership; Drift status, word count and group path; Element
category, group, aliases and key/value facts; Storyline counts, words and facts;
and Category element count and color. Patch links do not open a hover card until
patch data is available in the same store boundary.

## Acceptance

Machine-checkable coverage lives in:

- `src/renderer/lib/entity-link-appearance.test.ts`
- `src/renderer/lib/extensions/entity-link.test.ts`
- `src/renderer/components/ui/entity-hover-card-model.test.ts`
- `src/renderer/components/ui/entity-hover-card-position.test.ts`

Run the focused checks with:

```sh
pnpm --dir client exec vitest run \
  src/renderer/lib/entity-link-appearance.test.ts \
  src/renderer/lib/extensions/entity-link.test.ts \
  src/renderer/components/ui/entity-hover-card-model.test.ts \
  src/renderer/components/ui/entity-hover-card-position.test.ts
pnpm typecheck
```

These checks cover preference normalization, color resolution, markup
attributes, store-backed metadata, and viewport positioning. Native Tauri visual
behavior remains a manual acceptance boundary.

The broader renderer production check is `pnpm --dir client exec vite
build`. At this milestone it is blocked outside the Entity Link change by the
existing unresolved `@/renderer/lib/word-count` import in `ChapterEditor.tsx`;
the focused suite and workspace typecheck are green.
