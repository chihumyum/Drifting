# Mobile UI foundation

> The phone's workspace as implemented: one raised paper over a desk. It was
> rebuilt on 2026-11-07 on the sand-and-glass design system and replaces the
> earlier "Mobile V2" shell (unified bar, top and bottom tool workspaces,
> paper overview, full-screen voice face), which is recoverable from Git
> history before that date. How a finger meets the design system is in
> [`design-system/touch.md`](design-system/touch.md).

## Verdict

Drifting has a distinct mobile product path. Phones and compact tablets get
the mobile shell; native tablets at least 1000
portrait CSS pixels wide reuse the desktop shell with mobile native
capabilities (`src/renderer/platform/ui-shell-mode.ts`). The mobile shell is
one presentation over the shared project runtime, domain model, use cases,
Yjs, sync, authentication and Agent runtime. It wears the same design system
as the desktop and reuses the desktop's panels, cards, editors, Project Home,
shelf, timeline, plot planner and Super Views; what it owns is the phone's
geometry, gestures, keyboard handling and navigation.

Opening a project mounts `MobileAppShell`: `ProjectRuntimeProvider`, then
`MobileDesk` (`src/renderer/shells/mobile/desk/MobileDesk.tsx`).
Only the active paper mounts a full editor.

This is verified in the iOS Simulator through the frontend debug bridge
(synthetic DOM input) and by source and unit tests. It is not a claim about
physical-device appearance or feel: native keyboard geometry (the keyboard bar
follows `visualViewport` and the host's native keyboard geometry event), real
multi-touch and the frame rate of moving glass remain device-acceptance items
([`mobile-device-acceptance.md`](mobile-device-acceptance.md)).

## The model: one paper over a desk

```text
MobileDesk
├── the desk, under the paper
│   ├── left desk   章节 / 要素 / 构想, the shelf and search at its corners, the account cell and the book's trash at its foot
│   ├── right desk  审阅 / 素材库 / 统计 / 帮手
│   └── Bottom Panel, under the paper's foot: the Bottom Timeline or the chapter's plot planner
├── the paper (raised; the only elevated surface)
│   ├── the active document's editor, or Project Home
│   ├── the paper's own toolbar in its lower-right corner (the desktop's .editor-corner)
│   ├── the fore-edge along its right side
│   └── the dock along its foot: ☾  open papers  +  ☽
├── the keyboard's bar, while writing
└── layers over everything: a Super View, global search, the project trash
```

- **Pushing the paper aside shows a desk.** A sideways pan on the paper (or a
  moon) carries the paper with the finger; the desk on that side shows
  beneath and the paper settles open or shut by distance or flick
  (`useDeskPan.ts`, `settleDrawer`). A 52px sliver of paper stays on screen,
  with its moon in it: tapping or pulling it brings the paper back. While
  writing only a pan from the very edge moves the paper.
- **Lifting the paper's foot shows the Bottom Panel.** A flick up the dock,
  the timeline toggle or the plot planner button in the paper's toolbar lifts
  the paper's bottom edge to 46% or 84% of the screen; a flick down lowers it.
  The planner belongs to a chapter or drift in front and lies down elsewhere.
- **Layers lie over the desk.** A Super View slides in from the right; a pan
  from the left edge, its back button or Back takes it away.
- **There is no page history.** Papers change through the dock; Back takes away
  one thing at a time (below).

The state is one reducer (`desk/mobile-desk-controller.ts`):
`stage` (`paper` or `home`), `drawer`, the left and right panel, `bottom`
(pane and detent), `superView`, `sheet` (search, trash), `popover` (a tool's
own sheet), `writing` and the keyboard bar's mode. Panels and the last Bottom
Panel pane are remembered per book in local storage.

## Papers and the dock

The paper session (`workspace/mobile-workspace-session.ts`,
`useMobileWorkspaceSession.ts`) holds the open papers, the active one, each
paper's scroll position and the URL. Opening a book at its root picks up the
paper the author left; Project Home is the stage with no pill.

The dock (`desk/MobileDock.tsx`) is the paper's foot under the thumb: the two
moons open the left and right desks; between them each open paper is its sand
mark (`KindMark`) and the one in front a glass pill with its name. Sliding the
thumb along the marks runs the selection across them and turns to the paper
under it on release; tapping a mark turns to it; tapping the pill in front
spreads every mark into its pill with its own close. The plus goes to Project
Home with its create row floating.

A paper turn dissolves the new page in over a still copy of the old one
(`usePageTurn`); each paper reopens where it was scrolled
(`usePaperScrollMemory`). Reading on down the page puts the paper's toolbar
away; scrolling back brings it (`useReadingAway`). The prose fades into the
page under the toolbar and the dock rather than showing through their glass;
with the toolbar away the fade drops to the dock.

A paper comes back at its caret, but only a tap starts writing: the editor
session restores the selection without restoring focus on the phone
(`restoreFocus: false` in `useEntityEditorSession`), so opening a chapter never
puts the desk into writing with no keyboard up. Project Home counts a section
as in view only above the page's scroll padding, so after the plus the create
row floats over the dock instead of hiding under it, and the phone shows no
⌘N beside 新建.

In the Bottom Timeline and the story graph the storyline rail is 104px wide on
the phone, its name kept to two lines with the chapter count under it. A Super
View covers the whole phone, its ground under the status bar too; its head has
two rows: back and the view switcher, then the view's own controls.

## Reading and writing

- **The fore-edge** (`desk/MobileForeEdge.tsx`). Along the paper's right side
  every chapter is a stretch as long as its share of the book's words, in
  reading order; the chapter in front is inked and a grain of sand marks where
  the page is. Running the thumb down it leafs through the book with the
  chapter under the thumb named beside it; lifting turns to that chapter, or,
  inside the chapter in front (or in 通览全书), scrolls to that place.
- **A name is a door** (`desk/MobileProseNameCard.tsx`). Reading, a tap on a
  linked name brings up that element's card with a row that opens it, without
  placing the caret. Writing, a tap on a name places the caret.
- **Writing** is the editor holding the caret (`desk/useMobileWriting.ts`); a
  hardware keyboard writes with no keyboard on screen. Everything laid over the
  paper is put away. The dock and toolbar step down and the keyboard's bar
  (`desk/MobileKeyboardBar.tsx`) rides the keyboard's top edge: 「格式」
  (unfolding ¶ H1 H2 H3 引用 | B I U S above it), the selection's own actions —
  a comment and a patch, the same the desktop floats over a selection — handing
  the passage to the Agent (it goes into the Agent's box as a quote, and the
  right desk opens on 帮手), and putting the keyboard away. The desktop's
  floating selection bar is docked while the phone shell is mounted
  (`setSelectionBarDocked`), so it never covers the system's own edit menu.

## The desks

The left desk (`MobileLeftDesk` in `desk/MobileDeskPanels.tsx`) mounts the
desktop's `LeftSidebarSubHeader` and `ChapterPanel` / `ElementPanel` /
`DriftPanel`, with the paper in front as the cell selection; its tab row
starts with the way back to the shelf (where the desktop keeps the window's
close button) and ends with search; `WorkspaceAccountCell` and the book's trash (`MobileProjectTrashView`) stand at its foot.
The right desk (`MobileRightSidebar`) mounts `ReviewPanel`, `LibraryPanel`,
`MobilePaperStats` and `DesktopAgentPanel`; the Agent panel is the pane the
desktop routes tasks into, so a Project Home card or a hand-off from Review
(`revealDesktopAgentView`, the `agent:reveal` event) opens the right desk on
the very conversation. Panels lie side by side on a band pushed like a block
of ice (`PanelBand`); a swipe along a tab row changes panel.

Shared controls that ask the desktop's UI store for the Bottom Panel, a Super
View or Project Home's arrival (the paper's toolbar, panel headers, Project
Home's buttons, the timeline's story-graph entry) are followed through
`components/workspaceChrome/workspace-intents.ts`, and the desk writes back
what it shows. `settings:open` routes to `/settings`.

## Holding a thing

A finger held still on a thing for 420ms brings up that thing's own card —
the desktop's hover card, with the same actions — under the finger
(`desk/mobile-touch-hold.ts`, which replays a pointer arriving inside
`openHoverCardsNow`). Sliding onto a row and lifting presses it; the click a
lifted finger would send is swallowed. Prose, fields and anything marked
`data-touch-hold="off"` keep the system's long press.

## Back

Escape, the visible back controls and Android's Back share one request
(`workspace/mobile-workspace-back.ts`, `desk/useMobileDeskBack.ts`). A DOM
dialog or popover answers Escape first; an open Super View answers through its
own stack. Then, in order: a tool's sheet, the format pill, a sheet, a Super
View, the keyboard, the Bottom Panel, a drawer. At the paper's root Back goes
to Project Home, and at Project Home Android's Back leaves the book. Escape on
a hardware keyboard stops at the paper.

## Standalone surfaces

- `/` — the desktop's shelf in one column (`MobileProjectShelfView`:
  `PreAlphaFirstRunGate` + `ProjectPickerView`, `mobile-project-shelf.css`),
  with the same first run and sea of characters.
- `/login`, `/register` — `MobileAuthPage` renders the shared `AuthFlow` as a
  page.
- `/settings` — `MobileSettingsView` renders the shared settings panels
  outside a project runtime, one section at a time from an index with the
  desktop rail's brush icons (no shortcut section on a phone); it returns to
  the page it came from. The mobile Editor Settings section is the desktop's
  panel with its live `--editor-*` preview, its rows stacked and its preview
  scaled to the phone's width.

## Styles

`src/styles/mobile-foundation.css` sets the phone's type and touch scale under
`html[data-shell-mode='mobile']` (body 16px, rows 44px, no tap highlight or
focus ring, chrome not selectable); `mobile-desk.css` lays out the desk;
`materials.css` gives round glass 40px with a 20px icon on the phone and
answers glass hover only on a pointer that can hover.

## Legacy kept for tooling

`workspace/MobileAgentPanel.tsx`, `MobileAgentTranscript.tsx` and their
helpers and `mobile-workspace.css` are no longer mounted by the app. They stay because the renderer performance
harness and the transcript scripts read them; retiring them
means updating those scripts and their evidence.
