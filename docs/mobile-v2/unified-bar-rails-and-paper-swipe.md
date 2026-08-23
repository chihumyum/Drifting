# Mobile V2 unified bar, vertical rails, and stable paper deck

Status: **M3 implementation and iOS Simulator acceptance complete**

Updated: 2026-08-23

This document records the implemented M3 presentation and gesture boundary.
It is current checkout truth for the Mobile Shell paper workspace. M4 still
owns complete editing, comments, Search, and all-chapters acceptance; M5 still
owns complete Planning touch drag.

## One controlled bar

`MobilePaperDeck` mounts one `MobileUnifiedBar` and passes the M2 workspace
controller state into `selectMobileUnifiedBarProjection`. The bar is 56 CSS px
high before the bottom safe-area inset and has three stable regions:

- left: Back or keyboard dismissal, disabled at the read root;
- center in read state: active-paper identity plus open-paper count; tapping it
  opens Overview as a controller surface;
- right in read state: structure and tool panel actions; repeated activation
  cycles `none -> docked -> full -> none`, while switching sides enters the
  other side's docked state;
- center/right in edit state: the existing editor accessory and TOC/comment
  action are hosted inside the bar instead of separate floating chrome.

The bar remains mounted while its projection controls visibility, mode,
placement, and keyboard ownership. It sits at the safe bottom for an ordinary
paper, moves above a docked bottom panel, overlays a full panel, and follows
the visual keyboard inset while editing.

## Two one-level vertical rails

The top structure workspace has one 56px left rail:

1. Chapters
2. Elements
3. Inspiration

The bottom tool workspace has one 56px left rail:

1. Planning
2. Agent
3. Library
4. Stats

Planning owns Timeline and Plot Grid as internal subtabs. Library owns TODO and
material library as internal subtabs. Those choices do not become a second
workspace rail. Dashboard remains an ordinary paper. Project-wide
user/settings actions remain on the shelf and in Overview rather than
consuming either rail.

Both panels retain their continuous boundary handle. A settled extent at or
below 8% closes the panel, at or above 50% promotes it to full, and intermediate
values remain docked. The panel takes space from the corresponding edge by
moving the paper-deck boundary. The paper remains 100dvw by 100dvh and is
cropped; no prose/editor ancestor uses `transform: scale(...)`.

## Stable paper swipe

The old paper pinch, proportional paper scale, long-press cluster quick switch,
floating rail button, and Simulator-only bottom-panel build flag are removed
from the production Mobile Shell.

The replacement is a manually arbitrated horizontal pointer sequence on the
full paper row. It starts only when all of these are true:

- the controller is on a read paper;
- no top/bottom panel, transient surface, keyboard, TOC, or Comment rail owns
  the gesture;
- the current DOM selection is collapsed and IME composition is inactive;
- the pointer did not start on a link, button, form control, canvas, Timeline,
  Plot Grid, comment/TOC rail, explicitly excluded target, or nested
  horizontally scrollable container.

The first 8px is undecided. Horizontal ownership requires a 1.2 dominant-axis
ratio and must be established before a 180ms stationary hold, so a long press
does not unexpectedly change papers. Release commits one adjacent paper when
distance reaches 22% of the viewport clamped to 72-96px, or horizontal velocity
reaches 0.45px/ms. It never skips or wraps papers.

During a drag the ordered flex row exposes adjacent full static snapshots. Only
the active paper owns `MobilePaperContent` and its live editor/Yjs connection.
After settlement, ordinary session activation updates the active key, URL, and
scroll-memory lifecycle. `prefers-reduced-motion: reduce` changes settlement to
an immediate `auto` scroll and removes panel/bar animation without changing the
resulting controller state.

## Session and navigation invariants

M3 keeps the existing reducer-owned mobile paper session rather than adding a
second navigation store:

- open-new inserts one target once and activates it;
- activate-existing changes only the active key;
- close and close-neighbor retain deterministic fallback activation;
- Overview reorder writes the same ordered session;
- URL synchronization follows settled activation, never gesture preview;
- each paper retains its own `scrollTop` and restart restoration;
- Overview and Super Views remain outside the paper list.

An inactive prose paper renders its frozen live JSON when available, then the
read-only snapshot path. Activation occurs only after the row settles, so two
live editors are never mounted during a swipe.

## Deterministic evidence

- `src/renderer/shells/mobile/workspace/mobile-paper-swipe.test.ts`
- `src/renderer/shells/mobile/workspace/MobileUnifiedBar.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-workspace-session.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-workspace-session-storage.test.ts`
- `src/renderer/app/mobile-standalone-routes.acceptance.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-v2-design.acceptance.test.ts`

These checks cover gesture eligibility, axis/threshold/velocity/edge decisions,
bar panel cycling, session ordering/activation/close/reorder/restoration, the
single live paper source contract, vertical rail structure, 1:1 crop geometry,
and removal of old pinch/cluster production seams.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m3-unified-workspace-simulator-2026-08-23.md`](../qa/mobile-v2-m3-unified-workspace-simulator-2026-08-23.md)
records the existing iPhone 16e Simulator run. Visible native pixels covered
bar geometry, both rails, panel dock/full/close, and Overview. The iOS renderer
bridge dispatched explicitly labelled `synthetic-dom` paper drags and proved
bidirectional activation plus interactive-target exclusion. Simulator
Reduce Motion was enabled at the OS preference level and observed through the
running WKWebView, then restored.

That evidence is not physical touch. Real-finger continuity, ergonomics,
selection/IME interaction, assistive technology, Android presentation, and
low-memory/lifecycle behavior remain device gates. Complete all-chapters,
Search, comments, Planning, Agent, Super Views, Google Drive, and native RC
acceptance remain M4-M9 work.
