# Semantic outline rail

Status: built on 2026-08-03 and updated on 2026-08-18 for the direct Editor Top
Bar toggle and right-scrollbar review markers across the five prose editors:
whole book, chapter/drift, element, category, and storyline.

## Product contract

The editor has two independent navigation surfaces plus one review overlay:

- A semantic TOC rail remains at the editor area's left edge. It contains only
  the existing plain-text TOC tags and distant-range omission handles.
- The ordinary `.editor-scroll` scrollbar is restored at the editor area's
  right edge. It appears when the manuscript overflows and is the only
  scrollbar and scroll source of truth.
- Comment and Agent-change overview markers sit directly over that native
  scrollbar instead of occupying the Editor's left edge. Only the marker ticks
  capture clicks: their existing jump-and-flash action remains available while
  uncovered scrollbar regions keep their native interaction.

The retired dual-layer implementation is absent. The left TOC rail has no
custom track, viewport-range bar, draggable thumb, track-click behavior, or
scrollbar keyboard handler. TOC tag clicks still use each editor's canonical
jump handler; ordinary wheel, trackpad, keyboard, and thumb scrolling belong to
the right native scrollbar.

TOC tags remain anchored to the rendered positions of acts, chapters,
framework sections, and TipTap `h1/h2/h3` blocks. Every sequential TOC range
intersecting the current viewport receives the existing stronger text style.
The scrollspy reading location remains the primary accent selection and its
ancestors remain part of the active path. No selected item acquires a frame,
chip, background wash, or decorative left spine.

The five structural levels remain act / chapter / scene / beat / note. `h1`
maps to scene, `h2` to beat, and `h3` to note in every editor.

The rail's `OutlineViewportController` now supplies both geometry and the
single-entity scrollspy reading location. The views pass their existing reading
order and canonical jump handlers; whole-book view retains its controlled active
chapter. A clicked single-entity heading stays primary while its own bounds
intersect the viewport, before the normal 80 px threshold / 24 px look-ahead
scan resumes. Pinning and viewport-range styling share the same scoped anchor
snapshot, including in split panes with duplicate block IDs.

Ordinary scroll events share one pending frame and reuse content-relative
anchor bounds. Content mutations and resize invalidate those bounds; full passes
measure each resolved DOM anchor once. Hidden retained tabs detach observers and
listeners, cancel pending measurement and keep scalar geometry/pin state. An
incoming visible/preparing rail refreshes geometry in layout. Removed content
children are unobserved. Hiding also discards any body-portal omission reveal and
its close timer, so returning cannot reopen a stale reveal. These changes do not
alter document content, scroll position or the native scrollbar.

Single-entity editors do not synthesize the entity name as a TOC root. Their
rails contain only real outline entries inside the editor: prose headings for a
chapter/drift, and framework sections plus prose headings for element,
category, and storyline editors. Whole-book view keeps its existing
act/chapter hierarchy.

When a chapter/drift contains no prose headings, the TOC label lane stays
blank. It does not place H1/H2/H3 construction instructions above the rail.
Explicit non-prose empty states, such as a whole-book view with no chapters,
may still provide their own short message.

## Visibility control

The ListTree control in the Editor Top Bar remains immediately beside the
Entity Link highlight toggle. Clicking the button itself toggles the preference
immediately; it does not open a dropdown or secondary menu. The two persisted
states are:

1. `visible`: show the left semantic TOC rail.
2. `hidden`: unmount the left semantic TOC rail.

This preference controls only the left TOC rail. It never hides, dims, or moves
the right native scrollbar when the manuscript overflows. The preference is
persisted on this device by `settings-store`. It is not sent through an account
HTTP preference service. Persisted legacy `always` and `auto` values both
normalize to `visible`; `hidden` remains hidden.

## Dynamic density

Density is derived from the rail's measured height at runtime:

1. `all`: render every root and nested TOC tag while the minimum 17px label
   pitch fits.
2. `active-branch`: keep every root tag, but render descendants only for the
   root containing the current reading location.
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

The manuscript scroll source remains vertical-only and singular:
`.editor-scroll` clips horizontal overflow, consumes overscroll at both
document boundaries, shows its right scrollbar only when content overflows,
and wheel events over TOC labels forward only `deltaY`. This preserves the
existing protection against horizontal page shake at a vertical scroll
boundary.

`EditorScrollMarkers.tsx` is a fixed sibling of `.editor-scroll`. Its 8px map is
aligned with the 8px WebKit scrollbar at the right edge. The map does not take
pointer events, but each Comment or Agent tick does, so tick clicks scroll to
and flash their anchored prose blocks without disabling the rest of the native
track.

`EditorOutlineRail.tsx` owns DOM measurement and TOC interaction.
`outline-rail-model.ts` owns deterministic tree flattening, density planning,
collision layout, active ancestry, and visible-range calculation. Native
scrolling is intentionally not reimplemented in either file.

## Machine-checkable acceptance

Run:

```bash
pnpm exec vitest run \
  src/renderer/components/editor/outline-rail-model.test.ts \
  src/renderer/components/editor/semantic-outline-rail.acceptance.test.ts
pnpm typecheck
```

The tests prove all five editor mounts, left-edge TOC placement, the three
density stages, viewport-based multi-entry highlighting, omission behavior,
absence of synthetic single-entity roots and empty-outline instructions, the
two persisted TOC visibility choices, complete removal of the custom track and
dual scrollbar model, and an ordinary scrollbar that appears on the right only
when the manuscript overflows. It also proves that Comment and Agent review
markers overlay that scrollbar and retain their click-to-jump wiring without
making the whole overlay interactive.

Native visual spacing, scrollbar feel, WKWebView compositing, and
physical-device touch behavior remain manual acceptance boundaries.
