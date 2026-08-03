# Semantic outline rail

Status: built on 2026-08-03 and updated on 2026-08-04 for the five prose editors:
whole book, chapter/drift, element, category, and storyline.

## Product contract

The old 200px overlay panel is retired. Every prose editor owns one semantic
structure rail at the editor area's left edge. The native right scrollbar is
hidden; the underlying `.editor-scroll` remains the only scroll source of truth.

The rail shares one document-height coordinate system across four surfaces:

- TOC tags are anchored to the rendered positions of acts, chapters, framework
  sections, and TipTap `h1/h2/h3` blocks.
- The rail has two scrollbar layers. The narrow inner thumb represents the
  actual viewport and supports track click, pointer drag, mouse wheel, arrows,
  Page Up/Down, Home, and End. Its length is the ordinary viewport/document
  ratio and stays stable while scrolling; it is not resized from the number of
  visible TOC tags.
- A wider outer semantic range starts at the first currently visible TOC tag
  and extends to just before the first rendered tag after the visible set. A
  lone `01` therefore owns the full interval from `01` to `03`, rather than a
  short dot around `01`. It changes only when that discrete tag set changes, so
  it stays still while the reader moves inside one TOC section. Clicking a tag
  targets this outer range immediately; the inner thumb then follows the smooth
  manuscript scroll.
- Both scrollbar layers are square-ended rectangular bars. Neither the outer
  semantic range nor the inner viewport thumb uses rounded corners; the inner
  thumb also has no contrasting outline or outer ring.
- Every sequential TOC range intersecting the viewport receives stronger text.
  The existing scrollspy reading location is the primary accent selection; its
  ancestors remain part of the active path.
- Existing manual/Shadow/Copilot/TODO and Agent-change markers reuse the same
  rail coordinate, in the narrow lanes immediately beside the thumb.

The five-level semantics remain act / chapter / scene / beat / note. `h1` maps
to scene, `h2` to beat, and `h3` to note in every editor. TOC tags are plain
text: selection, hover, and current state never add a frame, chip, or background
wash. There is no decorative left selection spine. The moving thumb is a
functional scrollbar control, not a block highlight.

Single-entity editors do not synthesize the entity name as a TOC root. Their
rails contain only real outline entries inside the editor: prose headings for a
chapter/drift, and framework sections plus prose headings for element,
category, and storyline editors. Whole-book view keeps its existing
act/chapter hierarchy.

When a chapter/drift contains no prose headings, the rail leaves its TOC label
lane blank. It does not place H1/H2/H3 construction instructions above the
scrollbar. Explicit non-prose empty states, such as a whole-book view with no
chapters, may still provide their own short message.

## Visibility modes

The ListTree control in the Editor Top Bar sits immediately beside the Entity Link
highlight toggle. It opens one radio-style dropdown with three mutually exclusive
display modes:

1. `always`: keep TOC tags, both scrollbar layers, and review-marker lanes visible
   at their active contrast even while the editor is idle.
2. `auto`: preserve the compact default. Idle time hides TOC tags, the outer
   semantic range, and review ticks while leaving the inner viewport thumb visible
   at low contrast; scrolling or direct interaction restores the whole rail.
3. `hidden`: unmount the entire semantic rail. No TOC tags, inner thumb, outer
   range, rail track, or rail marker lanes remain visible. The native scrollbar
   stays hidden, so this mode presents no scrollbar at all.

The selected mode is persisted in `settings-store` and participates in the existing
cross-device preferences sync. New and migrated installations default to `auto`.

## Left-edge placement and activity

The scrollbar is fixed to the editor area’s left edge and no longer follows the
rendered paper gutter. When the application’s left sidebar is open, the rail
therefore sits immediately to that sidebar’s right; split panes each own a rail
at their own left edge. TOC tags always render to the right of the scrollbar.

In `auto` mode, idle TOC text, the outer semantic range, and review ticks are
hidden, but the inner viewport thumb remains visible at low contrast. Scrolling
or direct scrollbar interaction restores the TOC and outer range and raises the
inner thumb's contrast. `always` holds that active presentation without requiring
scroll input.

Review ticks now share the narrow scrollbar coordinate instead of occupying a
separate 18px strip between the TOC text and thumb.

## Dynamic density

Density is derived from the rail's measured height at runtime:

1. `all`: render every root and nested TOC tag while the minimum 17px label
   pitch fits.
2. `active-branch`: keep every root tag, but render descendants only for the
   root containing the current reading location. In whole-book view this means
   all act/chapter tags plus every scene/beat/note in the current chapter.
3. `windowed`: if the roots still do not fit, keep a document-order window
   around the current item. Contiguous distant ranges become upper/lower
   omission handles.

Hovering or focusing an omission handle replaces the shorthand with a small
`body`-portal group of the nearest real TOC tags at their normal compact type
size. There is no magnification animation. Choosing one uses the same canonical
TOC jump handler and recentres the density window around the destination; it
does not restore the retired full-height panel.

## Geometry and lifecycle

Anchor offsets are measured within the scoped `.editor-scroll`, never through a
global document query. `ResizeObserver` and a coalesced `MutationObserver`
refresh positions after editor hydration, typing, font/layout changes, and
virtual chapter mounts. Ordinary scroll frames only update viewport metrics;
they do not rescan every anchor.

The manuscript scroll source is vertical-only and singular: `.editor-scroll`
clips horizontal overflow, consumes overscroll at both document boundaries,
and wheel events on the rail forward only `deltaY`. Its parent
`.workspace-stage` is deliberately non-scrollable; routed surfaces such as the
dashboard own their own scroll source instead. Small diagonal components in a
macOS trackpad fling therefore cannot change `scrollLeft`, and vertical
momentum reaching the manuscript bottom cannot chain into an outer scrollbar
or WKWebView rubber-band that changes the centred page width.

`EditorOutlineRail.tsx` owns DOM measurement and interaction.
`outline-rail-model.ts` owns the deterministic tree flattening, density plan,
collision layout, active ancestry, and visible-range calculation.

## Machine-checkable acceptance

Run:

```bash
pnpm --dir client exec vitest run \
  src/renderer/components/editor/outline-rail-model.test.ts \
  src/renderer/components/editor/semantic-outline-rail.acceptance.test.ts \
  src/renderer/services/preferences-sync.service.test.ts
pnpm --dir client typecheck
```

The tests prove fixed left-edge placement, right-side TOC tags, all three density stages,
current-branch preservation, the hundreds-of-chapters window, collision
spreading, multi-range visibility, absence of synthetic single-entity roots and
empty-outline instructions, unchanged whole-book wiring, all five editor mounts,
the three persisted visibility modes, complete hidden-mode unmounting, hidden
native scrollbar, fixed viewport-proportional inner thumb, stepwise outer TOC
range, plain-text tags, vertical-only fling handling, and shared marker-lane
placement.

Native visual spacing, pointer feel, WKWebView compositing, and physical-device
touch behavior remain manual acceptance boundaries.
