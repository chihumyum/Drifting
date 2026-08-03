# Semantic outline rail

Status: built on 2026-08-03 for the five prose editors: whole book, chapter/drift,
element, category, and storyline.

## Product contract

The old top-bar TOC toggle and 200px overlay panel are retired. Every prose
editor now owns one permanent structure rail beside the manuscript. The native
right scrollbar is hidden; the underlying `.editor-scroll` remains the only
scroll source of truth.

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

## Width-aware placement and activity

Placement is derived from the real gutter between `.editor-body` and the
rendered `.page`, so opening application sidebars can change the mode even when
the outer window does not resize:

1. `resident`: when at least 98px of left gutter exists, the rail fits that
   gutter. TOC text sits 4px from the scrollbar instead of leaving a review-lane
   gap. While idle, text, thumb, and review ticks remain visible at low contrast;
   scrolling or direct interaction raises their contrast.
2. `edge`: when the gutter is narrower, the scrollbar moves to the editor's
   left edge and TOC text flips to its right. While idle, TOC text, the outer
   semantic range, and review ticks are hidden, but the inner viewport thumb
   remains visible at low contrast. Scrolling or direct scrollbar interaction
   restores the TOC and outer range and raises the inner thumb's contrast.

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

`EditorOutlineRail.tsx` owns DOM measurement and interaction.
`outline-rail-model.ts` owns the deterministic tree flattening, density plan,
collision layout, active ancestry, and visible-range calculation.

## Machine-checkable acceptance

Run:

```bash
pnpm --dir client exec vitest run \
  src/renderer/components/editor/outline-rail-model.test.ts \
  src/renderer/components/editor/semantic-outline-rail.acceptance.test.ts
pnpm --dir client typecheck
```

The tests prove the two width placements, all three density stages,
current-branch preservation, the hundreds-of-chapters window, collision
spreading, multi-range visibility, all five editor mounts, removal of the old
toggle, hidden native scrollbar, fixed viewport-proportional inner thumb,
stepwise outer TOC range, plain-text tags, and shared marker-lane placement.

Native visual spacing, pointer feel, WKWebView compositing, and physical-device
touch behavior remain manual acceptance boundaries.
