# Entity Link appearance and hover preview

Entity Links are inline references from chapter prose to an Element, Chapter,
Idea, Patch, Category, or Storyline. Their appearance is an editor preference
and is synchronized with the rest of the user's preferences.

## Appearance modes

`entityLinkColorMode` supports four modes:

- `contextual`: use the referenced entity's owner color. Elements inherit their
  Category color, Chapters their primary Storyline color, and Ideas their Idea
  group color. Categories and Storylines use their own color. Patch links retain
  the CSS fallback because patches are not hydrated in the entity store.
- `kind`: use the user-selected color for each of the six target kinds. The
  colors are stored in `entityLinkKindColors`.
- `hover`: match ordinary prose at rest and reveal the contextual owner-color
  wash only while hovering.
- `prose`: match ordinary prose and always show the selected band style in the
  prose color. There is no separate gray underline.

For `contextual`, `kind`, and `hover`, the separate `entityLinkHighlightMode`
preference offers three treatments in Settings > Editor:

- `band` (色带): keep the prose text color and show the color band only.
- `text` (变色): color the text without a background, including on hover.
- `both` (两者都有): show colored text and the band, preserving the existing
  default for new installations and settings saved before this preference.

When the selected treatment includes a band, `entityLinkBandStyle` offers
`wash` (连续色带, the existing default) or `dots` (细点, a single fine row below
the text). Dots use the resolved entity color, or the prose color in `prose`
mode, and remain a dot row on hover, including across wrapped lines. The
band-style choice is saved independently. Text-only treatment hides its control
outside prose mode without resetting it.

Hover-only mode reveals the selected treatment only while hovering. Prose mode
always shows the band-style control and hides the treatment control. Even a saved
text-only treatment cannot suppress its band; switching back restores the saved
treatment. Disabled and hard-deleted links remain plain prose.
This is a presentation preference stored with the other local settings; it does
not modify entity-link marks or Yjs content. The shared root attribute applies
it immediately to live editors and static all-chapters prose.

Entity Links add no padding or font weight, including Chapter and Idea links.
They inherit the surrounding prose weight and preserve author-applied bold.
Ordinary links retain their text positions and wrapping when highlighting is
toggled or hovered. The existing deep-link arrow remains a separate indicator.

The settings are exposed in Settings > Editor and applied to both the live
TipTap editor and the static all-chapters renderer. `entityLinkInteractive`
continues to control whether Entity Links respond to pointer interaction.

New and replaced mark DOM receives its current color through the mark's
`renderHTML` path, including paste, undo/redo and remote Yjs changes. Ordinary
document edits do not query and recolor every existing link. An explicit
appearance revision still restyles existing marks when owner colors or
preferences change; unchanged CSS values are not written again.

Color resolution shares ID indexes per immutable store collection. Weak keys
allow retired collections to be collected and preserve independent snapshots.
These are presentation caches: color values never become persisted mark attrs
or a second source of prose truth. The static all-chapters renderer continues
to use the same resolver and explicit restyling helper.

Retained editors subscribe to a shared name projection and a memoized
appearance signature. A metric/summary/body update with unchanged names and
ownership preserves those subscription results. Name projections include project
identity and generation; the project runtime releases its last name projection
on disposal. Per-editor auto-detection still excludes self/parent before applying
alias collisions and chapter-last priority. Weak collection caches avoid keeping
retired prose-bearing records alive. Type-color signatures include node kind so
chapter/idea changes refresh existing marks as well.

## Shared hover card

`EntityHoverCard` is the single preview surface used by:

- the left Chapter, Idea, and Element panels;
- Entity Links inside the editor;
- Bottom Timeline items.

The card is portaled to `body`, positioned with `position: fixed`, and flips or
clamps to stay inside the viewport. It intentionally has no entity-name header.
It displays the summary first, followed by metadata already available from the
renderer store. Its maximum height is `min(720px, viewport - 24px)` so summaries
can expand substantially before the card scrolls.

The same card keeps its existing border but uses the restrained
`--entity-hover-card-shadow` token (`0 1px 4px -3px` at low opacity). Its shadow
therefore stays inside the card's 8px anchor gap instead of darkening a newly
lightened sidebar or Bottom Timeline cell after the preview appears.

The metadata model performs no database query. It can show chapter status, word
count and storyline membership; Idea status, word count and group path; Element
category, group, aliases and key/value facts; Storyline counts, words and facts;
and Category element count and color. Patch links do not open a hover card until
patch data is available in the same store boundary.

For chapters with multiple storyline memberships, the card shows one chip per
storyline instead of a numeric total. The primary storyline keeps the standard
chip treatment; secondary storyline chips retain their names and colors with a
quieter border, background, label, and color dot.

Chapter storyline metadata is hydrated from local `node_storyline_link` rows,
including `is_primary`, before the renderer becomes ready. The card and timeline
views share the same resolver: use the declared primary while it remains a member,
then fall back to the first hydrated membership. Offline startup therefore does
not mislabel an affiliated chapter as unaffiliated while network sync is pending.

## Editing linked names

Every way Drifting creates an Entity Link (auto-linking, retroactive linking,
the @-picker and agent writes) links a name or alias of its target, but
ProseMirror keeps a mark on whatever text remains of it. Since 2026-10-06 an
author edit that turns a linked name or alias into text that is neither (for
example deleting 格 from 约格) removes the link from that run in the same step,
so one undo restores both; auto-linking may link the remaining text again if it
is another name. Edits made during an input-method composition are repaired
with the next edit outside one, or by the debounced auto-link pass after it
ends. Remote Yjs changes and undo are not repaired, and links on text that was
not a registered name of their target are left alone. The rule lives in
`src/renderer/lib/extensions/entity-link-repair.ts`, covered by
`entity-link-repair.test.ts`.

## Acceptance

Machine-checkable coverage lives in:

- `src/renderer/lib/entity-link-appearance.test.ts`
- `src/renderer/store/settings-store-appearance.test.ts`
- `scripts/run-entity-link-highlight-acceptance.mjs` (real Settings clicks,
  both band styles at rest/hover, wrapping, prose/disabled/deleted precedence,
  inherited bold, text geometry across enabled/disabled states, and reload;
  generates `docs/editor/acceptance/entity-link-highlight.json`)
- `src/renderer/lib/extensions/entity-link.test.ts`
- `src/renderer/components/ui/entity-hover-card-model.test.ts`
- `src/renderer/components/ui/entity-hover-card-position.test.ts`
- `src/renderer/domain/node-storyline-state.test.ts`

Run the focused checks with:

```sh
pnpm exec vitest run \
  src/renderer/lib/entity-link-appearance.test.ts \
  src/renderer/store/settings-store-appearance.test.ts \
  src/renderer/lib/extensions/entity-link.test.ts \
  src/renderer/components/ui/entity-hover-card-model.test.ts \
  src/renderer/components/ui/entity-hover-card-position.test.ts \
  src/renderer/domain/node-storyline-state.test.ts
pnpm typecheck
pnpm exec node scripts/run-entity-link-highlight-acceptance.mjs
```

These checks cover preference normalization, color resolution, markup
attributes, store-backed metadata, and viewport positioning. The broader
renderer production check is `pnpm exec vite build`.
The [F1 browser evidence](../renderer-performance/acceptance/f1-editor.json)
adds real browser DOM, HTML paste, undo/redo and two-Y.Doc convergence checks.
Run `pnpm perf:renderer --assert-input-budget` and
`pnpm perf:renderer:check --report=.local-data/renderer-performance/latest.json`
for the synthetic input regression. The harness is excluded from app builds.
Native Tauri visual behavior and physical Chinese IME remain separate
acceptance boundaries; Chromium timings are not native input-to-paint results.
