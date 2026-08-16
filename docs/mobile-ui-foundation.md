# Mobile UI foundation

## Current verdict

Drifting has a distinct mobile product path. Authentication, project shelf,
global settings, and the paper workspace are composed by mobile-owned routes
and shell components over the shared project runtime, domain model, use cases,
Yjs, sync, authentication, and Agent runtime.

This is an implemented foundation with static, build, state-machine, and an
older Simulator main-path record. It is not a claim that current interactions
have passed complete iOS and Android physical-device acceptance.

## Shell and dependency model

```text
AppRoutes
├── DesktopAppShell
└── MobileAppShell
    ├── mobile paper session and URL adapter
    ├── single active full editor
    ├── paper overview and reorder
    ├── top structure workspace
    ├── bottom tool workspace
    └── mobile Super View navigation

ProjectRuntimeProvider
└── SQLite / Yjs / sync / Agent / repositories / use cases
```

The shells may compose shared features and domain controllers. Shared features
must navigate through `WorkspaceNavigator` and must not import desktop or mobile
stores. Pointer-heavy desktop controllers remain under `shells/desktop`; mobile
owns its gesture arbitration, paper state, sheets, safe-area layout, and
navigation stack.

The complete dependency rules are in
[`renderer-ui-architecture.md`](renderer-ui-architecture.md).

## Current mobile product contract

The interaction direction is browser-inspired: paper navigation should share
the familiar intuition and fluidity of a good mobile browser. Safari is one
source of inspiration, not the product baseline, a behavior specification, or
a visual target. Drifting keeps that broadly understood navigation grammar
while its top and bottom workspaces introduce Drifting-owned structure,
editing, timeline, material, comment, and Agent capabilities.

- `/login` and `/register` use the mobile authentication presentation while
  retaining existing session, OTP, reset, OAuth callback, and adoption logic.
- `/` uses the mobile project shelf and global settings path without mounting a
  project runtime merely to show settings.
- Opening a project mounts `MobileAppShell` and the shared
  `ProjectRuntimeProvider`; it does not enter `DesktopAppShell` or the former
  deferred workspace page.
- If the restored mobile session has no open paper, the project opens a
  Dashboard paper instead of guessing and opening the first chapter.
- A mobile paper session owns open targets, activation, close, reorder,
  adjacent switching, URL synchronization, and per-paper scroll restoration.
- Only the active paper mounts a full editor. When focus moves, its current live
  Yjs prose is frozen into a read-only static body snapshot; inactive prose
  papers therefore retain their full body without mounting extra editor/Yjs
  sessions.
  The horizontal row uses native scrolling and `scroll-snap`.
- Top structure and bottom tool workspaces reuse shared feature content but use
  mobile-owned panels, sheets, reveal state, and safe-area geometry.
- The bottom tool workspace mounts the shared full `BottomTimeline` surface,
  not a mobile-only storyline/chapter list. Book and narrative views therefore
  retain the desktop model and writes: Act Rail, narrative markers, placed and
  unplaced chapters, the unaffiliated lane, spread and locate actions,
  cross-storyline links, marker/act drift binding, context actions, order and
  primary-storyline updates, persisted horizontal position, and timeline
  pinch scale. The mobile presentation fills the enclosing bottom panel rather
  than restoring the desktop dock height, uses a narrower sticky rail and
  touch-sized rows and controls, opens chapters as mobile papers, supports
  direct touch dragging, and maps long press to the same node, storyline, act,
  and marker menus used by desktop. Placed chapter cards use pointer-move and
  pointer-up delivery on both desktop and mobile, so their committed lane/order
  change does not depend on WebView HTML drag/drop delivery; the portaled
  unplaced-chapter drawer retains native drag data for cross-surface drops.
- Focusing a rich-text editor opens a keyboard accessory in its compact circular
  state. The same button expands or collapses a horizontally scrollable set of
  paragraph, heading, quote, and inline-mark controls. Commands preserve the
  live selection and keyboard; the accessory follows `visualViewport` above the
  software keyboard, and the paper cluster yields while editing. On iOS the
  WKWebView's generic previous / next / done form-navigation assistant is
  removed, leaving one Drifting-owned accessory above the native keyboard.
- A partially revealed panel owns its visible hit-test region, including its
  controls and resize handle. Panel extent and the bottom paper cluster follow
  vertical pointer distance one CSS pixel per CSS pixel while dragging.
- The bottom paper cluster stays above the Home indicator. Touch arms after
  160 ms, while a real mouse or trackpad arms immediately. A tap defers
  overview opening until the native tap has completed. An explicit
  `VITE_MOBILE_SIMULATOR_BOTTOM_PANEL_ACCEPTANCE=true` acceptance build instead
  routes that tap to the full-height bottom panel because the current macOS automation
  driver cannot synthesize a usable drag into Simulator's WKWebView. The flag
  is absent from normal builds and is only a navigation seam for inspecting
  bottom-panel interactions; it does not claim to validate the cluster drag.
  Pinch progress
  remains proportional to the actual distance between the two touches through
  the overview threshold, without a dead plateau after the ordinary dock point.
- After the cluster arms, its dominant axis is locked: vertical movement keeps
  controlling panel extent, while horizontal movement enters a compact
  44-pixel-per-paper quick switch. The live paper is frozen at horizontal
  gesture start, adjacent static bodies can be scanned without mounting an
  editor, and only pointer release activates and thaws the selected paper.
- In a reduced-paper state, the active editor surface permits the outer native
  horizontal paper row to own `pan-x`, so a swipe can start anywhere on the
  current paper instead of only on exposed adjacent edges. Inactive papers also
  expose a semantic full-paper activation button, so tapping either neighbor
  switches directly to it without removing native `scroll-snap` dragging.
- Focused editor papers expose one 46px floating rail button. It portals to
  `body` and expands into a touch-sized menu that toggles the shared semantic
  TOC rail or the shared Comment Rail; the same button collapses the menu. Its
  fixed top position follows `visualViewport.offsetTop`, so opening the software
  keyboard cannot push the control outside the visible viewport. When comments
  are active it moves to the left, opposite the right-side comment cards; for
  TOC and the closed state it stays right, opposite the left semantic rail.
  Narrow screens show at most one rail at a time without reflowing prose. The
  TOC keeps canonical jumps, active ancestry, omission reveals, and all five
  structural levels, but uses a 34px touch pitch so density reduction happens
  before labels overlap. Comment papers reuse the complete unified rail:
  anchored and entity comments, creation composer, source snapshots, hover/tap
  highlights, Copilot decisions, resolve/reopen, TODO conversion, exceptions,
  and deletion. Comment visibility changes initiated inside the editor are
  broadcast to the mobile control, so a newly authored or Copilot comment
  cannot open behind a hidden rail. The bottom paper cluster yields while a
  rail is open so it cannot cover Comment Rail actions or compete for touch.
- Entity cells open a read-only preview sheet first; only an explicit action
  inserts a new paper. Backdrop events are consumed and cannot click through.
- Paper overview owns activation, close, close-all, grid reorder, Super View,
  settings, shelf, and all-chapters navigation.
- Host page zoom is disabled in the mobile WebView. Canvas-based Super Views own
  their own pointer/pinch transforms.

## Reused product core

| Layer         | Shared contract                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime       | Project lifecycle, SQLite, Yjs, sync, Agent, auth, and repositories                                          |
| Navigation    | `WorkspaceTarget` and `WorkspaceNavigator` ports                                                             |
| Features      | Settings panels, Agent content, library/TODO, comments, stats, entity panels, and pure graph/timeline models |
| UI primitives | Modal, menu, popover, buttons, tabs, icons, tokens, and semantic labels                                      |
| Domain truth  | The same project, prose, relations, storylines, `plotGridJson`, snapshots, and sync contracts as desktop     |

Reuse does not require identical presentation. Hover, right-click, keyboard
shortcuts, multi-column hosts, and desktop canvas controllers are not mobile UI
contracts.

## Remaining device acceptance

1. Pinch, cluster long-press/drag, panel handles, paper scrolling/snap, and
   canvas gestures still need complete iOS and Android manual validation. The
   2026-08-13 iOS Simulator run covered launch, project entry, Dashboard
   fallback, safe-area placement, cluster tap, and overview; Simulator UI
   automation could not synthesize the required two-touch pinch.
2. IME, selection/caret scrolling, `visualViewport`, password managers, OTP
   autofill, deep links, and keyboard avoidance need physical-device coverage.
3. Rotation, safe areas, system bars, background/foreground, offline recovery,
   low-memory behavior, and representative device performance remain open.
4. Story Graph, Timeline, Plot Grid, Agent, entity editing, TSV paste, and other
   dense workflows require device-specific interaction checks.

Use [`mobile-device-acceptance.md`](mobile-device-acceptance.md) for setup and
the current checklist. Build or Simulator success must not be reported as
mobile-ready, touch-ready, or complete native UX acceptance.

## Machine gates

```bash
pnpm typecheck
pnpm lint
pnpm test:renderer-architecture
pnpm exec vite build
pnpm agent:capabilities:check
```

Focused mobile reducer, route, gesture-state, overlay, paper-session, and import
boundary tests supplement this baseline. They prove deterministic contracts,
not physical-device appearance or feel.
