# Mobile UI foundation

> This document describes the current implemented mobile shell — the only
> mobile frontend Drifting has. The staged "Mobile V2" delivery documents and
> their dated Simulator run reports were retired after delivery completed; they
> remain recoverable from Git history. Current behavior is documented here and
> enforced by the acceptance tests referenced below.

## Current verdict

Drifting has a distinct mobile product path. Authentication, project shelf,
global settings, Project Home, and the paper workspace are composed by
mobile-owned routes and shell components over the shared project runtime,
domain model, use cases, Yjs, sync, authentication, and Agent runtime.

The presentation path is selected by an immutable `shellMode` separate from the
native platform target. Phones and compact tablets use the mobile shell; native
tablets at least 1000 portrait CSS pixels wide reuse Desktop Shell while
retaining mobile native capabilities, safe areas, and portrait-only policy
(`src/renderer/lib/ui-shell-mode.ts`).

One reducer (`mobile-workspace-controller.ts`) owns the workspace surface —
`project-home`, `paper`, `overview`, or `super-view` — plus paper mode, panel,
transient, and keyboard state. Visible Back, Escape, the Super View stack, and
Android native Back share one typed request and unwind one owned layer at a
time. Back resolution order is: dialog, then transient (popover/sheet), then
search, then formatting, then edit mode, then Agent input, then the surface
stack. Search opened from edit keeps the editor's input-method session
(`keyboard: 'open'`) and hands focus back to the editor when Back resolves; the
exact focus-handoff contract is recorded in
[`qa/mobile-search-focus-regression.md`](qa/mobile-search-focus-regression.md).
Back at the read-paper root returns to Project Home; Back at Project Home
leaves the project for the shelf.

The workspace chrome is one 56px controller-owned unified bar plus top and
bottom panels with 56px one-level vertical rails. Panels crop a 1:1 paper, and
read-state horizontal paper swipe has explicit nested-interaction arbitration.
The bar is keyboard-aware on both native targets, real outline and comment
rails portal into one shared sheet, paper/Project search are read-only, All
Chapters promotes exactly one live editor, and an empty Project can create its
first chapter. Complete shared Planning is reachable in the vertical tool
workspace with delayed-ownership chapter touch drag. A compact Agent
presentation runs over the shared runtime with the same read-write tool access
as desktop, with Working Memory, Library/TODO, and Stats given a portrait
information architecture. The source contains an unaccepted voice surface
(Project Home mic entry → fullscreen voice-Agent face, collapsing to a floating
pill above every surface) and BYOK transcription wiring into the same runtime;
the maintainer has not tested that chain and it is not a claimed mobile
capability. See [`voice-authored-capture.md`](voice-authored-capture.md). The three Super Views (Elements, Story Graph, Library/Memo) are
independent controller surfaces with preserved per-view state
(`MobileSuperViewHost.tsx`), and Settings exposes a compact Google Drive
surface over the shared sync product commands. The mobile Editor Settings
surface reuses the desktop preference authority and live `--editor-*` preview,
but replaces the desktop rail breakout with a readable phone-width miniature:
font, size, line height, paragraph spacing/indent, Tab indent, and the scaled
paper-width model update immediately while range and segmented controls retain
full-width touch targets.

This is an implemented foundation with static, build, state-machine, and dated
Simulator evidence. It is not a claim that current interactions have passed
complete iOS and Android physical-device acceptance.

## Shell and dependency model

```text
AppRoutes
├── DesktopAppShell (desktop target or expanded native tablet)
└── MobileAppShell (phone or compact native tablet)
    ├── Project Home (project-level surface, not a paper)
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
  project runtime merely to show settings. The shelf defaults to one immersive
  horizontally paged project per viewport; one persistent grid Toggle opens a
  compact all-project overview and closes it again. The overview owns search,
  filters, edit/delete actions, and a responsive cover grid. Its view, query,
  filter, scroll position, and focused project survive the trip into Project
  Home, while the pager always retains the complete unfiltered project set.
- Opening a project mounts `MobileAppShell` and the shared
  `ProjectRuntimeProvider`; it does not enter `DesktopAppShell` or the former
  deferred workspace page.
- A project always opens at Project Home, a project-level surface outside the
  paper rail (`MobileProjectHome.tsx`). The former Dashboard paper is retired;
  the mobile session storage migrates v1 dashboard papers out of the v2 content
  session. The paper session resumes from Home.
- A mobile paper session owns open targets, activation, close, reorder,
  adjacent switching, URL synchronization, and per-paper scroll restoration.
- Only the active paper mounts a full editor. When focus moves, its current live
  Yjs prose is frozen into a read-only static body snapshot; inactive prose
  papers therefore retain their full body without mounting extra editor/Yjs
  sessions. A manually arbitrated horizontal flex row exposes adjacent static
  papers during read-state swipe, then activates exactly one neighboring paper
  through the canonical session and URL path after settlement.
- Mobile manuscript prose uses normal line wrapping within its symmetric page
  gutters. It overrides desktop `text-wrap: pretty`, which can shorten every
  CJK line on narrow WebKit pages and resemble an empty right rail. See
  `qa/mobile-prose-wrapping-2026-09-05.md` for measured acceptance.
- Top structure and bottom tool workspaces reuse shared feature content but use
  mobile-owned panels, sheets, reveal state, and safe-area geometry.
- The bottom tool workspace on phones mounts `MobileVerticalTimeline`: the
  desktop coordinate system turned vertical, not the horizontal
  `BottomTimeline` (which stays the desktop and large-screen surface). Book and
  narrative views keep the desktop model and writes. `useBottomTimelineSelectors`
  supplies `orderToPosition` / `positionToOrder`, acts derive from
  `deriveActSegments`, markers come from `useTimelineMarkers`, spread runs
  `spreadTimelineNodes`, chapter moves commit through `commitChapterLaneDrop`
  and `moveChapterOnTimeline`, and the window-level pointer controller in
  `chapter-lane-drag.ts` drives the drag with a vertical edge-autoscroll axis
  and a lift-on-hold behavior. `bookOrder` and `narrativeOrder` remain the
  authored continuous coordinates with entity ID as the tie-break.
  Dots in the track gutter sit at exactly the mapped coordinate and own every
  gesture: a tap opens the chapter menu sheet; a still hold past 180ms followed
  by movement, or a 500ms hold, lifts the nearest dot by y within 22px and
  drags it; pointer-up persists the finger's continuous coordinate; a long
  press on empty track opens the create sheet; act boundary handles and marker
  heads drag with the same rule. The entries on the right are a pure projection
  (`vertical-timeline-projection.ts`): their level follows the free space below
  the dot (large ≥120px with summary, medium ≥64px, small ≥36px, minimal 24px),
  they never overlap, a crowded entry slides down and every entry keeps a
  hairline leader back to its dot, and three or more consecutive chapters that
  pile up collapse into one cluster entry whose tap raises the pinch scale until
  the run spreads out. Entries accept taps only. Pinch changes the vertical
  scale (0.5–3×, persisted separately from the desktop scale) anchored on the
  two-finger midpoint. Storyline pills filter by dimming; unaffiliated chapters
  ride a dashed track toggled from the ⋯ menu; narrative view keeps unplaced
  chapters in a bottom drawer whose chips act as their own dots and drag out to
  place. Chapter, act, marker and create menus are bottom sheets that ride the
  tool overlay as `popover` transients so Back closes them before the tool.
- The Plot paper tool and the desktop Plot Planner dock share one
  `PlotGridEditor` table that fills its host on both axes (mobile minimum
  84×72, desktop 120×64) and scrolls only the overflowing axis with the
  opposite header pinned. The mobile header carries the across / down switch
  (a transposed view, persisted per device) and the append row / column
  buttons; the desktop dock carries the same buttons in a slim header and edits
  inline. Cells on phones open an editing sheet above the keyboard with the
  row × column labels, the row's column strip and four-way navigation; headers
  open a menu sheet with rename, move, insert and delete. Moves persist as
  explicit `row.move` / `column.move` mutations through the normalized writer.
  Cells keep a size of their own, so adding rows or columns overflows (the
  overflowing axis scrolls) instead of squeezing the table. "Fit" is a header
  action, not a mode: it computes the size at which the whole table fills the
  host and stores it. Desktop stores that size in the synced `cellW` / `cellH`
  record (`size.set`) and also changes it by hand with the corner grip; the
  phone keeps a device-local size per grid, fits once on first open, and
  changes it by pinch. While the cell sheet is open the unified bar yields
  (`tool:plot-cell` popover), and Back closes any Plot sheet before the tool.
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
- A material Google Drive transfer appears in a compact, non-interactive status
  capsule below the top safe-area chrome on every project surface. It reuses the
  shared sanitized phase, object, and byte progress: remote discovery is
  indeterminate until its total is known, then pull and push are determinate.
  Empty background polls do not create the capsule, and sync status never moves
  into or captures input from the keyboard-aware unified bar.
- The top panel's one-level 56px rail contains Chapters, Elements, and
  Inspiration. The general `MobileRightSidebar` contains Stats, Review,
  Agent, and Library; comments and TODOs are filters of the one Review surface,
  not separate tool destinations. Stats reuses the shared desktop `EntityStatsContent` for the current entity;
  Timeline now opens above the persistent paper toolbar.
- Project Home exposes a project-options menu beside the project title:
  name/summary editing, device-local writing goals, project Trash, and a
  separated destructive project-deletion action. The Settings gear still
  opens the standalone app settings route. Deletion requires a second dialog
  with the project name and irreversible scope, initially focuses Cancel,
  retains errors for retry, and returns to the shelf only after the shared
  project deletion commits. Both readable mobile paper-session formats are
  then forgotten. See `qa/mobile-project-home-actions-2026-09-05.md`.
- The mobile right sidebar covers the full viewport height and reaches the
  right edge, leaving only an 8px reveal on the left. Its paper background
  extends behind the status bar and home indicator; only the 44px tab row and
  pane apply their respective safe-area insets. Agent subtabs use 12px text
  with 44px touch targets. It slides down from above the top-right corner and
  exits upward before unmounting, including controller Back dismissal; reduced
  motion removes the travel. Simulator evidence and geometry assertions are
  recorded in `qa/mobile-right-sidebar-2026-09-05.md`.
- Read-paper swipe starts on the full paper only when no editor, selection,
  composition, panel, transient, keyboard, TOC/sticky-note rail, Timeline, Plot
  Grid, canvas, interactive target, or nested horizontal scroller owns the
  pointer. It locks horizontally after 8px at a 1.2 axis ratio, commits one
  adjacent paper by a 72-96px distance or 0.45px/ms velocity threshold, and
  cancels undecided stationary holds after 180ms. Reduced motion settles
  immediately without changing the result.
- The 本纸 tab opens a small fixed, body-portaled popover with only the shared
  semantic TOC and sticky-note switches.
  Narrow screens show at most one rail at a time without reflowing prose. The
  TOC keeps canonical jumps, active ancestry, omission reveals, and all five
  structural levels, but uses a 34px touch pitch so density reduction happens
  before labels overlap. Sticky notes default to one stacked deck, expand
  vertically on demand, and retain the shared Review actions. Membership and
  ordering are session-only per editor; Review open/close, resolve, conversion,
  and paper switching do not remove notes. An open rail blocks paper swipe so
  it cannot compete for touch.
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
   gesture arbitration, Timeline/Plot continuous touch, and Super View canvas
   gestures still need complete iOS and Android physical-device validation. The
   dated 2026-08 Simulator/Emulator runs exercised these paths with explicitly
   `synthetic-dom` input, not native touch.
2. IME, selection/caret scrolling, `visualViewport`/Android IME inset behavior,
   password managers, OTP autofill, deep links, and keyboard avoidance need
   physical-device coverage. Simulator coverage exercised the stated
   English/Chinese/Gboard and native-selection paths only. The editor
   scroll/persistent-Back handoff that still awaits user-owned device runs is
   recorded in
   [`qa/mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md`](qa/mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md).
3. Rotation, safe areas, system bars, background/foreground, offline recovery,
   low-memory behavior, and representative device performance remain open.
4. Story Graph, Agent, entity editing, Google Drive settings, and other dense
   workflows require device-specific interaction checks. Simulator/Emulator
   evidence covers visible surfaces and synthetic input, but does not close
   live-provider, native clipboard, accessibility, or physical-touch gates. The
   Google Drive release gate additionally requires the real-account
   three-platform run in
   [`qa/google-drive-three-platform-physical-acceptance.md`](qa/google-drive-three-platform-physical-acceptance.md).

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

### Persistent paper toolbar and General Agent — 2026-09-05

The paper toolbar stacks above the bottom navigation row in reading mode. When
navigation recedes with scroll, the toolbar descends to the bottom safe area;
scrolling back restores the stack. Both rows share the same transition timing.
The paper scroll viewport fills the entire screen in reading mode, including
the status-bar and home-indicator areas. Navigation and the accessory overlay
that viewport. Visible top and bottom navigation have opaque backgrounds; each
background moves away with its own bar when hidden, leaving no reserved band.
Hiding navigation changes no paper height or clipping boundary.
The initial top safe-area spacer belongs to the scrolling content, including
whole-book rows and adjacent frozen papers. Existing document-end spacing lets
the last prose line clear the accessory. Only an open editing/search keyboard
reduces the paper viewport. Native geometry and hit-test evidence is recorded in
`docs/qa/mobile-fullscreen-flow-2026-09-06.json`.
During editing the toolbar follows native keyboard
geometry. Fresh edit entry opens formatting directly; returning from another
accessory preserves its saved level, including while the native keyboard reopens.
Undo and Redo appear independently only when their respective history stack has
an operation, in either editing accessory level. Formatting activates after a
stationary release; horizontal panning, leaving a button, and pointer cancellation
never apply a style. One input-preserving action boundary handles the editor,
Search, Agent controls and the Agent's portalled configuration menu. It cancels
the native touch-end focus default before buttons can disappear or be replaced.
Accessory background taps also leave the active input focused.
Plot and Timeline cover the originating prose mode without blurring its input
or closing its keyboard. Back returns directly to that editor and its saved
accessory level, including when a Plot field has taken focus. Keyboard visibility
does not insert another Back step inside an accessory destination.
Search, Plot and Timeline are toolbar destinations; the 本纸 popover only contains
display switches. Stats lives in the right panel alongside Review, Agent and Library.

Agent uses the paper accessory surface with shared provider/model configuration,
dictation and send controls. Back stays in the lower action row, below the input,
even after selecting a conversation. One Back exits Agent and returns directly
to the originating paper mode. An editing origin regains prose focus without
closing the keyboard; a reading origin returns to reading and closes the tool input. Recent sessions extend directly upward
from the accessory under one outer contour, without a gap or border between layers.
Three recent project sessions and searchable full history appear above the input.
First send creates the canonical conversation; selecting history creates no new row.
A selected conversation uses a flat, borderless plane above the raised accessory;
its header clears the status bar and switches sessions. Non-input actions such as
Latest preserve composer focus and the keyboard. The paper Agent configuration
menu neither autofocuses an option nor restores focus to its trigger. Startup makes the paper input
briefly read-only instead of disabling it. Leaving this surface never aborts its running turn.

The local paper-to-conversation association survives reload; drafts are renderer-local
and isolated by paper and conversation. Invalid/deleted conversation pointers reopen
a fresh composer. Hydration and rapid switching are guarded; a late load cannot restore
a stale draft. The right panel and shortcut use the same conversation store and runtime.
The association is **UI state only**: shortcut sends and retries contain only the
user's text, with no paper, selection, title, prose or added context instruction.
Reading does not summon the keyboard until the input is tapped.

Acceptance: `mobile-paper-agent-session.test.ts`, controller transition tests and
`docs/qa/mobile-paper-agent-2026-09-05.md`. The corrected navigation/toolbar stacking
is recorded in `docs/qa/mobile-toolbar-stack-2026-09-06.md`.
Input ownership and the revised Agent surface are recorded in
`docs/qa/mobile-toolbar-input-2026-09-06.md`.

Accessory activation and keyboard continuity are recorded in
`docs/qa/mobile-accessory-focus-2026-09-06.md` and its measured JSON record.


### Accessory navigation contract (2026-09-06 correction)

The author-visible level comes before keyboard dismissal. Input focus is an
execution detail of the active level, never an extra navigation level. Model
menus, history selection and dialogs close their own child layer first. Outside
those child layers, the accessory Back resolves the following table.

| Destination | Presentation and function | Entered from reading | Entered from editing | One accessory Back |
| --- | --- | --- | --- | --- |
| Format | Horizontal prose style buttons | Absent; entering prose editing opens it | Applies styles to the live editor while preserving focus | Returns to the entry list with the editor and keyboard active |
| Search | Search field, count, previous/next matches over live prose | Focuses Search; prose stays in reading mode | Transfers focus to Search and retains the originating editor state | Closes Search; restores reading, or the saved editor and open keyboard |
| Agent, no session | Composer with its action row; recent sessions extend directly above it | Shows the dock; keyboard opens only after tapping the input | Transfers focus to the composer without dismissing the keyboard | Exits Agent in one step; restores reading, or the saved editor and open keyboard |
| Agent, selected session | Flat conversation plane above the same composer; header switches sessions | Restores the paper's selected session without forcing input focus | Opens the same conversation plane with composer focus | Same as the unselected dock; selection/draft remain associated with the paper |
| Plot | Plot workspace above the accessory, with its own editable fields | Prose stays in reading mode; a tool field may open the keyboard | Covers the editor and retains its return state | Exits Plot directly, including when a tool field owns focus; restores the origin |
| Timeline | Timeline workspace above the accessory | Prose stays in reading mode | Covers the editor and retains its return state | Exits Timeline directly and restores the origin |

For ordinary editing entry-list navigation, the complete path is:
`editor + entry list + keyboard → tool → Back → editor + entry list + keyboard
→ Back → reading + entry list + no keyboard`.
The last step is the only accessory Back that dismisses an editor-owned keyboard.
A reading-origin tool never invents an editor state on return. Native keyboard
hide gestures can change keyboard visibility without replacing the saved origin.

While the unselected Agent dock is visible, prose remains a full-screen scroll
owner. Its scrolling content compensates WebKit viewport panning at the top and
the measured dock overlap at the bottom. This adds reachable scroll travel,
not another fixed background or clipping band. A selected conversation instead
owns its own scroll area; its underlying prose is covered by the conversation plane.

Acceptance distinguishes controller contract tests, source wiring checks and
native end-to-end observations. A passing wiring check is not interaction proof.
The corrected Back paths and scroll geometry are recorded in
`docs/qa/mobile-accessory-return-2026-09-06.md` and the adjacent measured JSON.

### Plot Grid and vertical Timeline — 2026-09-06

Design source: `docs/design/mobile-v2/plot-timeline-proto-v3.html` and the
v3 section of `docs/design/mobile-v2/README.md`. Acceptance:
`shells/mobile/workspace/mobile-v2-planning.acceptance.test.ts` (wiring),
`shells/mobile/workspace/timeline/vertical-timeline-projection.test.ts`
(levels, leaders, clusters), `vertical-timeline-gestures.test.ts` (hit-testing,
slots), `components/editor/plot-grid/plot-grid-layout.test.ts` (fill rules,
transposed view), `domain/plot-grid.test.ts` and
`usecase/plot-grid-write.integration.test.ts` (explicit moves), and
`mobile-workspace-controller-tool-sheets.test.ts` (sheet transients). Device
feel — long-press timing, pinch anchoring, drawer drag-out — is still to be
recorded from a physical device.
