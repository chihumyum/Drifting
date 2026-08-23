# Mobile UI foundation

> This document describes the current implemented mobile shell. The frozen
> replacement target and staged M0-M9 delivery gates are indexed at
> [`mobile-v2/README.md`](mobile-v2/README.md). M1-M4 implementation records are
> current boundaries; later milestone prose remains target behavior only.

## Current verdict

Drifting has a distinct mobile product path. Authentication, project shelf,
global settings, and the paper workspace are composed by mobile-owned routes
and shell components over the shared project runtime, domain model, use cases,
Yjs, sync, authentication, and Agent runtime.

Since Mobile V2 M1, that presentation path is selected by an immutable
`shellMode` separate from the native platform target. Phones and compact
tablets use the current mobile shell; native tablets at least 1000 portrait CSS
pixels wide reuse Desktop Shell while retaining mobile native capabilities,
safe areas, and portrait-only policy. The exact implemented boundary is in
[`mobile-v2/platform-and-appearance-foundation.md`](mobile-v2/platform-and-appearance-foundation.md).

Since M2, one reducer owns workspace surface, paper mode, panel, transient, and
keyboard state. Visible Back, Escape, the Super View stack, and Android native
Back share one typed request and unwind one owned layer at a time. Overview and
Super Views are controller surfaces rather than paper-session entries. The
implemented boundary is in
[`mobile-v2/workspace-controller-and-back.md`](mobile-v2/workspace-controller-and-back.md).
Since M3, one 56px controller-owned unified bar replaces the paper cluster and
paper pinch chrome, top and bottom panels use 56px one-level vertical rails,
panels crop a 1:1 paper, and read-state horizontal paper swipe has explicit
nested-interaction arbitration. The implemented boundary is in
[`mobile-v2/unified-bar-rails-and-paper-swipe.md`](mobile-v2/unified-bar-rails-and-paper-swipe.md).
Since M4, the bar is keyboard-aware on both native targets, real outline and
comment rails portal into one shared sheet, paper/Project search are read-only,
All Chapters promotes exactly one live editor, and an empty Project can create
its first chapter. The implemented boundary is in
[`mobile-v2/editing-comments-search-and-all-chapters.md`](mobile-v2/editing-comments-search-and-all-chapters.md).

This is an implemented foundation with static, build, state-machine, and dated
Simulator evidence. It is not a claim that current interactions have passed
complete iOS and Android physical-device acceptance.

## Shell and dependency model

```text
AppRoutes
├── DesktopAppShell (desktop target or expanded native tablet)
└── MobileAppShell (phone or compact native tablet)
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
  sessions. A manually arbitrated horizontal flex row exposes adjacent static
  papers during read-state swipe, then activates exactly one neighboring paper
  through the canonical session and URL path after settlement.
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
  and marker menus used by desktop. Bottom Timeline and Storyline Graph use the
  same window-level pointer controller for placed cards and portaled unplaced
  chips, so their committed lane/order change does not depend on WebView HTML
  drag/drop delivery. The controller hides the source card and moves one
  full-style compositor ghost with `requestAnimationFrame` instead of updating
  React state on every pointer event; it also locks document selection for the
  active drag. Both book and narrative views preserve the card's grabbed point,
  including when the source is a narrow unplaced chip, and preview the card
  continuously under the pointer. Chapter dragging has no separate center-line
  drop indicator: the ghost itself is the placement preview. The exact finite
  axis coordinate is persisted on pointer-up. `bookOrder` and `narrativeOrder`
  are the authored coordinates: their numeric order determines chapter sequence
  and narrative time, with entity ID as the deterministic tie-break for equal
  coordinates.
  Empty marker and act tracks keep their creation menus. The act-head `+`
  creates one first act at the left edge; every act, including the first, can
  then move to a finite coordinate, leaving earlier chapters outside all acts.
- Focusing a rich-text editor opens a keyboard accessory in its compact circular
  state. The same button expands or collapses a horizontally scrollable set of
  paragraph, heading, quote, and inline-mark controls. Commands preserve the
  live selection and keyboard; the unified bar follows `visualViewport` or the
  Android native IME inset above the software keyboard and owns the accessory
  inline. On iOS the
  WKWebView's generic previous / next / done form-navigation assistant is
  removed, leaving one Drifting-owned accessory above the native keyboard.
- A partially revealed panel owns its visible hit-test region, including its
  controls and resize handle. Panel extent follows vertical pointer distance
  one CSS pixel per CSS pixel while dragging. The corresponding paper-deck edge
  moves while the paper remains 100dvw by 100dvh, so the panel crops prose
  instead of scaling it. Release closes at or below 8%, stays docked below 50%,
  and promotes to full at or above 50%.
- One 56px unified bar stays at the safe bottom, moves above a docked bottom
  panel, overlays a full panel, and follows the keyboard inset. Its center paper
  identity opens Overview; its structure/tool buttons cycle
  `none -> docked -> full -> none` through the workspace controller.
- The top panel's one-level 56px rail contains Chapters, Elements, and
  Inspiration; Dashboard remains an ordinary paper. The bottom panel's one-level 56px rail contains Planning, Agent,
  Library, and Stats. Timeline/Plot and TODO/Library are internal panel choices,
  not a second rail.
- Read-paper swipe starts on the full paper only when no editor, selection,
  composition, panel, transient, keyboard, TOC/comment rail, Timeline, Plot
  Grid, canvas, interactive target, or nested horizontal scroller owns the
  pointer. It locks horizontally after 8px at a 1.2 axis ratio, commits one
  adjacent paper by a 72-96px distance or 0.45px/ms velocity threshold, and
  cancels undecided stationary holds after 180ms. Reduced motion settles
  immediately without changing the result.
- In edit state the unified bar exposes the shared semantic TOC and Comment
  action instead of a floating rail control. Narrow screens show at most one
  rail at a time without reflowing prose. The
  TOC keeps canonical jumps, active ancestry, omission reveals, and all five
  structural levels, but uses a 34px touch pitch so density reduction happens
  before labels overlap. Comment papers reuse the complete unified rail:
  anchored and entity comments, creation composer, source snapshots, hover/tap
  highlights, Copilot decisions, resolve/reopen, TODO conversion, exceptions,
  and deletion. Comment visibility changes initiated inside the editor are
  broadcast to the mobile control, so a newly authored or Copilot comment
  cannot open behind a hidden rail. An open rail blocks paper swipe so it cannot
  compete for touch.
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

1. Unified-bar ergonomics, panel handles, real-finger paper swipe, nested
   gesture arbitration, Timeline/Plot touch, and Super View canvas gestures
   still need complete iOS and Android physical-device validation. The
   2026-08-23 iPhone Simulator run covered the M3 visible bar/rail/panel paths;
   its paper drags were explicitly `synthetic-dom`, not native touch.
2. IME, selection/caret scrolling, `visualViewport`/Android IME inset behavior,
   password managers, OTP autofill, deep links, and keyboard avoidance need
   physical-device coverage. The M4 Simulator/Emulator run covered the stated
   English/Chinese/Gboard and native-selection paths only.
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
