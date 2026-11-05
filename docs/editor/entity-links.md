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
clamps to stay inside the viewport. It leads with the entity's name, since the
same card also stands alone over truncated timeline tiles and graph cards.
It displays the summary first, followed by metadata already available from the
renderer store. Its maximum height is `min(720px, viewport - 24px)`; an Entity
Link's card in prose covers at most `min(480px, viewport - 24px)` of the page.
What does not fit scrolls inside the card, and while more is below, its body
fades out over its last 32px.

The pointer can cross from an Entity Link into its card (the owner's hover
state gives it `HOVER_CARD_GRACE_MS`), so a long card can be scrolled and read;
leaving the card, pressing outside it or Escape closes it. Wheeling over the
link itself also scrolls a long card.

Key/value facts run in: the key leads in muted ink, its value follows on the
same line and wraps across the card's full width, so a long key such as
「第六章之后（已定未写）」 never squeezes its value into a column one character
wide. Relation cards in the story graph use the same rows.

The card wears `.hover-card-surface`: the sidebar's opaque colour, 16px
corners, a resting glass edge and the floating shadow.

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

## Names split across links

A name is read within a stretch of a paragraph whose formatting is the same
apart from Entity Links: bold or italic still splits a name, a link boundary
does not. A name only partly linked to its target is linked whole with the link
already on it, so it becomes one link (a deep link stays a deep link).

Until 2026-11-04 every pass searched one text node at a time. A Markdown file
edit that respelled 安娜蒂 as 安纳蒂 left 安 and 蒂 linked and 纳 plain, and no
later pass could see 安纳蒂 there even after it became an alias. Now:

- the editor's debounced auto-link pass links such names whole after every
  document change and once when an editor opens (`entity-link-name-runs.ts`;
  see "Prose nobody has typed into" below). Existing split links therefore mend
  when their chapter is opened, once the full spelling is a registered name;
- written prose (agent writes and Markdown file edits) is relinked the same way
  across a paragraph's text children (`lib/agent/yjs-entity-relink.ts`);
- a Markdown file edit or agent text replacement keeps text written inside one
  link in that link (`lib/entity-link-inheritance.ts`), so a respelled name
  stays one link even before its new spelling is registered. Text written at a
  link's edge, or in place of text that was outside it, does not join it.

Retroactive linking of a newly created element (`retroactive-entity-links.ts`)
still searches one text node at a time; a new element has no links to mend.

## Prose nobody has typed into

Automatic element links (Settings > Editor) were made for typing: the editor
links registered names after each pause. Until 2026-11-06 nothing linked the
names in prose that no one typed. A chapter the Agent created and kept writing
showed its characters as plain text, and they counted as appearances nowhere
(Element stats, the mention graph, the Agent's own appearance search, all fed
by `inline_mention`), until the author typed a character into that chapter.
Now:

- the Agent links registered names in what it writes. A prose command
  (`edit_prose_file`, `edit_block`, the chapter/element/storyline/category body
  tools) links the names in the blocks it writes before the command is
  prepared, so the links are part of the operation its deterministic Yjs
  update and inverse derive from (`linkNamesInProseOperation`). The body of a
  chapter, idea, element, storyline or category the Agent creates is linked
  the same way (`linkNamesInProseBlocks`). Names are the open project's, minus
  the entity being written, and none while automatic element links are off
  (`writtenProseLinkConfig` in `lib/agent/chapter-prose.ts`). Blocks the
  command does not write are left as they are;
- an editor that opens runs one full auto-link pass once its document has
  loaded, 500 ms after the view is created. It links names registered after
  the prose was written (an element created later, a new alias) and anything
  another path left plain. The continuous chapter view renders unfocused rows
  as static prose, so a row's names are linked when it becomes the focused
  editor, not when it scrolls into view. A document whose names are
  all linked receives no write. A view that cannot be edited (no Yjs document
  yet, a load error) writes nothing;
- creating an element (by the author or the Agent) links its
  names in the project's closed prose: chapters, ideas and the bodies of other
  elements, storylines and categories
  (`services/element-name-backfill.service.ts`, retained by the project
  runtime). Open editors link it themselves, as before. Names are read against
  every registered name, so a longer name still wins, but only the created
  elements' names are linked: a closed chapter is not otherwise rewritten.
  Documents are visited one at a time, each once for every element queued for
  it, and the change is journaled as a `system` revision; a chapter's
  `contentJson` cache is refreshed with it. Nothing is written while an Agent
  turn runs in the project, because a link landing between an Agent's read and
  its write would make that write stale; elements the Agent creates during a
  turn are linked when the turn ends. A seed-only body without Yjs state, or
  an element deleted before its turn came, is skipped.

Each pass is a local change: it is journaled and synced like typing, is not
an undo step, and does not count as the author typing. A name or alias added
to an existing element is still linked in a closed document only when that
document is opened.

## Acceptance

Machine-checkable coverage lives in:

- `src/renderer/lib/entity-link-appearance.test.ts`
- `src/renderer/store/settings-store-appearance.test.ts`
- `scripts/run-entity-link-highlight-acceptance.mjs` (real Settings clicks,
  both band styles at rest/hover, wrapping, prose/disabled/deleted precedence,
  inherited bold, text geometry across enabled/disabled states, and reload;
  generates `docs/editor/acceptance/entity-link-highlight.json`)
- `src/renderer/lib/extensions/entity-link.test.ts`
- `src/renderer/lib/extensions/entity-link-name-runs.test.ts` and
  `src/renderer/lib/agent/yjs-entity-relink.test.ts` (names split across
  links and text children are linked whole; other formatting still splits; an
  opened editable view links new names; Agent operations link the blocks they
  write)
- `src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts`
  (an Agent body rewrite and a created chapter are stored with their names
  linked)
- `src/renderer/services/element-name-backfill.integration.test.ts` (a
  created element is linked in closed chapters only after the running Agent
  turn ends, open chapters are left to their editor, several elements share
  one write per chapter, a deleted element links nothing)
- `src/renderer/components/ui/entity-hover-card-model.test.ts`
- `src/renderer/components/ui/entity-hover-card-position.test.ts`
- `src/renderer/components/ui/hover-card-long-content.acceptance.test.ts`
  (enterable prose card capped at 480px, run-in facts, lower-edge fade)
- `src/renderer/domain/node-storyline-state.test.ts`

Run the focused checks with:

```sh
pnpm exec vitest run \
  src/renderer/lib/entity-link-appearance.test.ts \
  src/renderer/store/settings-store-appearance.test.ts \
  src/renderer/lib/extensions/entity-link.test.ts \
  src/renderer/lib/extensions/entity-link-name-runs.test.ts \
  src/renderer/lib/agent/yjs-entity-relink.test.ts \
  src/renderer/services/element-name-backfill.integration.test.ts \
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
