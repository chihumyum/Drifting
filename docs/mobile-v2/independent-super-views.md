# Mobile V2 independent Super Views

Status: **M7 implementation and Simulator/Emulator acceptance complete**

Updated: 2026-08-23

M7 completes Story Graph, Element Panorama, and Memo and Material as three
independent full-screen surfaces in compact Mobile Shell. They reuse the shared
desktop domain views and relation use cases, but their mobile host, return-point
contract, gesture boundary, focus ownership, safe areas, and touch affordances
are explicit. They are never inserted into the ordinary paper session.

## Independent-surface contract

Opening the first Super View captures one immutable return point containing:

- the ordered ordinary-paper keys;
- the active paper key;
- each paper's scroll position, including the live active-paper value that may
  not yet have reached debounced persistence;
- the route pathname, search string, and hash.

Switching Story Graph ↔ Element Panorama ↔ Memo and Material stays inside the
same `MobileSuperViewHost` and does not recapture that point. The paper deck
remains mounted but becomes inert and hidden from the accessibility tree. The
full-screen modal host owns focus and gestures; entry focuses Back and ordinary
close restores the prior paper focus. Close compares the live workspace with
the captured point and exposes a development acceptance status of `preserved`
or `changed`.

The ordinary lifecycle therefore does not add, activate, close, reorder, or
navigate a paper. An explicit entity action such as Open in editor is different:
it is an author-requested navigation out of the Super View and may deliberately
open an ordinary paper.

## Shared view and header ownership

The mobile host renders the existing `SuperElementView`, `StoryGraphView`, and
`SuperMemoMaterialView` under the shared `SuperViewNavigationProvider`. Their
header keeps all three switches in one full-screen surface and provides a 44px
Back target. Header actions, relation-mode controls, library menus, and nested
controls are also at least 44px in compact Mobile Shell.

The overlay uses fixed viewport geometry, top and bottom safe-area padding,
contained overscroll, and no horizontal document overflow. It is isolated from
paper swipe and panel drag through the workspace surface state and
`data-gesture-owner=super-view`. No Super View is represented as a paper, tab,
or route change.

## Touch interaction boundary

Element Panorama owns pointer pan and two-pointer pinch. The pinch helper keeps
the same authored world point beneath the moving two-finger midpoint while it
clamps zoom; `touch-action: none` prevents browser page zoom and scroll takeover.
Cards are excluded from canvas pan so their own actions remain reachable.

Story Graph retains the shared pointer-driven chapter drag path for mouse,
pen, and touch. Its large graph surface owns native two-axis scrolling rather
than leaking the gesture into paper navigation. Element cards continue to use
their canonical structured authority; M7 does not invent an unrelated freeform
position or ordering model merely to create a drag animation.

Both Story Graph and Element Panorama expose an explicit mobile Create relation
mode. The first card/node tap selects the source and the second opens the
existing typed-relation workflow. Back clears the selected source first, then
leaves relation mode, then closes the full-screen surface. Existing nested
menus/dialogs continue to unwind through their shared escape stacks before the
host closes.

Memo and Material reflows its memo and Library regions vertically and exposes
the Library card's explicit mobile More action. The fixed body-portaled menu
keeps relation, external-open, and delete operations reachable without hover or
right-click.

## Deterministic evidence

- `src/renderer/shells/mobile/workspace/mobile-super-view-state.test.ts`
- `src/renderer/features/graph/super-view-canvas-gesture.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-v2-super-views.acceptance.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-workspace-controller.test.ts`
- `src/renderer/hooks/useSuperViewEscapeStack.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-paper-swipe.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-v2-design.acceptance.test.ts`

The pure tests cover immutable capture, live-scroll capture, exact mismatch
detection, midpoint-preserving zoom, moving midpoints, clamping, and zero-length
input. Source acceptance prevents paper-navigation wiring, requires one shared
host and header, verifies the inert paper boundary, and records touch/relation
ownership.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m7-independent-super-views-simulator-2026-08-23.md`](../qa/mobile-v2-m7-independent-super-views-simulator-2026-08-23.md)
records the reused iPhone 16e Simulator and `Persimmon_API_35` Android Emulator
runs. The iPhone run visibly switched all three surfaces, exercised a simulated
two-pointer Element pinch without page zoom, unwound relation mode, and closed
back to the exact paper return point. Android device pixels covered Story Graph
geometry and real Android hardware Back first cleared relation mode and then
closed the host without changing the paper workspace.

Both frontend transports declare `nativeInput=false`. Physical two-finger
pinch, continuous node/card drag, edge cases with populated large graphs,
accessibility, lifecycle/low-memory behavior, and real-device performance remain
open release work. Google Drive capability was present in the native builds,
but real-account acceptance remains the M8 hard gate.
