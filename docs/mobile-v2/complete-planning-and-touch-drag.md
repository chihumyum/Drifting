# Mobile V2 complete Planning and touch drag

Status: **M5 implementation and Simulator/Emulator acceptance complete**

Updated: 2026-08-23

This document records the implemented M5 Planning boundary. Mobile reuses the
shared Bottom Timeline and normalized Plot Grid rather than maintaining a
reduced planning product. M6 owns Agent, Library/TODO, and Stats presentation;
M5 does not broaden those surfaces.

## Complete shared Timeline

The Planning workspace mounts `BottomTimeline presentation="mobile"` behind
the one-level bottom rail. The mobile presentation retains the shared authored
model and commands:

- book order and narrative time;
- Act Rail and narrative markers, including create, move, bind, and context
  actions;
- primary storyline lanes, cross-storyline memberships, the unaffiliated lane,
  and the narrative unplaced drawer;
- spread, locate, horizontal pan, midpoint-anchored pinch scale, and persisted
  position;
- ordinary-paper activation for placed cards and unplaced chips;
- the desktop-shared node, storyline, Act, and marker menus.

Planning and Plot Grid remain nested interaction owners in the M3 paper-swipe
arbiter. A timeline pan, pinch, menu, card drag, Plot input, or Plot resize
therefore cannot become a paper-navigation swipe.

## Touch drag ownership

Touch cards use one explicit arbitration model:

1. movement beyond 8px before 180ms yields the scroll/pan path and performs no
   chapter write;
2. an approximately 180ms hold arms drag; subsequent movement creates one
   body-portaled compositor ghost and hides the source card;
3. remaining stationary for 500ms opens the shared context menu instead of
   starting a drag;
4. a second touch transfers ownership to pinch and cancels the card sequence;
5. `pointercancel`, explicit cancellation, early pan, and an invalid target
   restore visuals and write nothing.

During an active drag, a 48px horizontal edge zone advances the actual
Timeline scroll owner on animation frames. Target resolution is repeated after
each scroll step, so the final drop can land on a primary lane, the synthetic
unaffiliated lane, or a narrative destination reached by edge scrolling. The
grabbed pixel inside the card remains under the pointer.

Pointer-up resolves one final target and passes it through an exactly-once
closure before the shared `commitChapterLaneDrop` and
`persistChapterTimelineMove` path. The authored order and primary-storyline
change stay in one domain transaction. No preview movement writes intermediate
coordinates.

## Pinch, pan, and menus

Background movement remains a horizontal/vertical Timeline scroll. Two-touch
input remains Timeline pinch, not card drag. Pinch records the content point
under the starting midpoint and corrects `scrollLeft` after each scale update,
so a moving midpoint remains anchored while scale is clamped to the shared
limits.

Placed cards and the narrative unplaced drawer share the pointer controller.
Touch menu timing is also shared by chapter, storyline, Act, and marker
surfaces. Desktop mouse thresholds and ordinary click/right-click behavior are
unchanged when the mobile touch option is absent.

## Complete normalized Plot Grid

The mobile Plot subtab edits the current ordinary node through the existing
normalized Plot Grid writer. It retains contenteditable headers and cells,
row/column add and delete, sparse cell values, bottom-right resize, and TSV
paste with automatic grid growth.

Mobile controls expose semantic labels and at least 44px targets. Editable
text uses a 16px minimum so the WebView does not zoom the host page. Resize is
pointer-id scoped: pointer-up commits one size mutation, while
`pointercancel` restores the last committed CSS dimensions and performs no
write. The 400ms coalescer serializes semantic mutations and materializes the
deterministic `plotGridJson` projection from normalized authority.

## Deterministic evidence

- `src/renderer/features/graph/mobile-planning-gesture.test.ts`
- `src/renderer/features/graph/chapter-lane-drag.test.ts`
- `src/renderer/features/graph/chapter-lane-drag.pointer.test.ts`
- `src/renderer/components/BottomTimeline/useTimelineExpandedScale.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-v2-planning.acceptance.test.ts`
- `src/renderer/shells/desktop/views/DesktopBottomTimeline.pointer-drag.acceptance.test.ts`
- `src/renderer/app/mobile-standalone-routes.acceptance.test.ts`

The focused M5 set covers tap, arm, drag, menu, early pan, background pan,
pinch cancellation, `pointercancel`, explicit cancellation, invalid targets,
edge autoscroll, midpoint anchoring, exactly one valid write, zero writes on
every cancellation path, complete shared-surface wiring, and paper-swipe
exclusions.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m5-planning-simulator-2026-08-23.md`](../qa/mobile-v2-m5-planning-simulator-2026-08-23.md)
records the reused iPhone 16e Simulator and `Persimmon_API_35` Android Emulator
runs. iOS device pixels showed book/narrative controls, Act, marker, two
storylines, a cross-storyline connection, unaffiliated/unplaced controls, and
the Plot Grid. DEV-only synthetic DOM input moved one chapter after the arm
window, opened the shared long-press menu, and persisted normalized Plot
row/column/TSV changes. Android device pixels showed the full portrait Planning
surface over an app-created ordinary chapter, and real Android hardware Back
reduced full Planning to docked Planning through the shared resolver.

The bridge evidence declares `nativeInput=false`; it is not real-finger touch.
Physical iOS and Android completion remains open for continuous drag feel,
multi-touch pinch, edge autoscroll, long-press ergonomics, cancellation during
OS interruption, accessibility, low-memory/lifecycle behavior, and
representative large-project performance.
