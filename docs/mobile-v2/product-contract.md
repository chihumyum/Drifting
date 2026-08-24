# Mobile V2 product contract

Status: **normative target; staged implementation in progress**

Updated: 2026-08-23

## 1. Product promise

Mobile V2 is a complete writing workspace expressed through mobile-native
interaction. It includes every current Drifting capability that can remain
highly usable with touch, a portrait viewport, and a software keyboard. It does
not copy desktop hover, right-click, multi-column, or keyboard-centric chrome
into a smaller screen.

The primary loop is:

1. open or create a Project from the local-first shelf;
2. find or create structure from the top workspace;
3. read and edit one live paper without layout scaling;
4. switch ordered papers through an intentional read-state horizontal swipe;
5. use planning, Agent, Library/TODO, and Stats from the bottom workspace;
6. search, follow evidence, and return to a stable prose location;
7. survive offline work, backgrounding, process death, and later Google Drive
   convergence without losing authored state.

## 2. Authority and reuse

- Live Yjs remains prose truth. `contentJson` remains seed/cache only.
- SQLite remains durable authority for domain records, Agent history/effects,
  sync state, and review decisions.
- Mobile reuses shared repositories, use cases, provider drivers, sync,
  comments, entity semantics, Timeline writes, Plot Grid data, and Agent
  runtime.
- Mobile owns its shell, navigation state, gestures, sheets, safe areas,
  keyboard geometry, rails, paper session, and presentation density.
- Only one live prose editor may be mounted for an active paper context. Static
  snapshots or virtual rows represent inactive prose.
- Presentation state such as open-paper order and restored scroll positions may
  remain project-scoped rebuildable client state.

## 3. Product surfaces

```text
App
|-- Project shelf
|-- Global settings
`-- Project workspace
    |-- Paper workspace
    |   |-- Dashboard
    |   |-- chapter or inspiration
    |   |-- storyline
    |   |-- element or category
    |   `-- all chapters
    |-- Top structure workspace
    |   |-- Chapters
    |   |-- Elements
    |   `-- Inspirations
    |-- Bottom tool workspace
    |   |-- Planning: Timeline and Plot Grid
    |   |-- General Agent
    |   `-- Library and TODO
    |-- Current-entity Stats Sheet: shared desktop right-sidebar content
    |-- Paper overview and search results
    `-- Independent Super Views
        |-- Story Graph
        |-- Element Panorama
        `-- Memo and Material
```

Project Home is a separate project-level surface; all-chapters remains an ordinary paper. Super Views are independent
full-screen surfaces and must never become papers, tabs, paper cards, paper
counts, or paper-session entries.

## 4. Paper workspace

### 4.1 Session semantics

- Opening a new target inserts it immediately to the right of the active paper.
- Opening an already-open target activates its existing paper without a
  duplicate.
- Dashboard-class utility papers may default to the end when no contextual
  insertion cause exists.
- The Project Dashboard is ensured into the ordinary paper rail on workspace
  restoration without stealing activation from a deep-linked or restored
  editor paper. Its cards arbitrate horizontal paper swipes after the axis lock;
  form controls and nested horizontal scrollers remain excluded.
- Closing selects the nearest surviving neighbor.
- Overview reorders, activates, closes, and closes all papers.
- Project-scoped paper order, active key, and per-paper scroll position restore
  after restart.
- The opening cause controls transient animation only and is not persisted.

### 4.2 Stable geometry

- A live editor must never be inside `transform: scale(...)`.
- Paper text and hit targets remain 1:1 while a panel opens.
- Panels reveal depth by cropping the paper viewport from the top or bottom.
- The paper strip may expose a 6px neighbor cue, derived from the real viewport
  instead of a fixed 402x874 production geometry.
- Safe-area and `visualViewport` geometry are authoritative for placement.
- A closed workspace exposes one entry grabber per edge. Once a panel moves,
  its own boundary grabber becomes the only visible and interactive handle;
  the initiating accessory hides during the drag and returns after settlement.
- Ordinary panel release preserves the author's exact height. Crossing an
  arbitrary percentage never forces full screen; only reaching the full edge
  or a deliberate opening fling may commit full screen. The exception is the
  final 144 CSS pixels next to the closed edge, which snap fully closed instead
  of preserving a non-useful panel sliver.

### 4.3 Paper swipe

Paper switching is available only in a read state. It is disabled while:

- a live editor is focused;
- text selection or an IME composition is active;
- search or Agent input owns the bar;
- a panel or Super View owns the gesture;
- an interactive nested surface can consume the same axis;
- a button, link, input, slider, canvas, Timeline, Plot Grid, image/PDF viewer,
  or horizontally scrollable descendant owns the pointer sequence.

The initial production configuration uses an 8px axis-lock distance, a 1.2
dominant-axis ratio, and a distance threshold derived from
`clamp(72px, 22vw, 96px)`. Velocity remains a separately tested commit path.
All values live in one mobile gesture configuration module and remain subject
to physical-device calibration.

## 5. State topology and back behavior

The shell stores orthogonal state rather than one flat bar enum:

```text
surface: paper | overview | super-view
paperMode: read | edit
panel: none | top-docked | top-full | bottom-docked | bottom-full
transient: none | search | agent-input | bar-sheet | paper-stats | entity-preview | dialog
keyboard: closed | open
```

The unified bar is a pure controlled projection of these states.

Back resolves one visible layer at a time in this order:

1. destructive/native dialog;
2. popover, current-paper Stats, entity preview, or bar sheet;
3. edit mode and its software keyboard atomically return to read mode;
4. search or Agent input, including its keyboard;
5. full panel to docked panel;
6. docked panel to read paper;
7. Super View child layer, then the Super View;
8. Overview;
9. Android system Back at read root leaves the Project for the shelf.

The unified bar's left slot only exits the current visual layer. It never
switches papers or leaves the Project. At read root it is visibly disabled.
Overview owns its own header and hides the unified bar.

## 6. Floating key bar and keyboard accessory

- The base bar is a floating horizontal 56px pill, never a full-width footer.
- Read state always shows the current editor entity, a separate paper-count
  button, Search, and the hamburger menu. The entity opens a current-paper
  Stats Sheet using shared desktop-right-sidebar content; only the count button
  opens paper Overview.
- The pill contains no top-panel or bottom-panel buttons. A safe-top grabber
  pulls down the structure panel; the pill's own grabber pulls up the tool
  panel. During either drag the pill hides, and the moving panel owns the only
  visible boundary handle. Full panels hide the opposite entry and the pill.
- Edit state exists only while the live editor is focused and a software
  keyboard is visibly open. Caret-less, keyboard-less pseudo-edit states are
  illegal.
- Edit entry starts at the navigation accessory level, which shows the black
  Format label alongside the complete paper-context/count/Search/menu
  presentation. Read mode keeps the paper entrances but never shows Format.
  Pressing Format opens one horizontally scrollable icon row and hides the
  label; it never opens a Sheet. Editor-owned Back never sends a synthetic
  Escape. Persistent leftmost Back collapses the formatting level without
  moving focus or closing the keyboard. Back from the
  edit navigation level exits editing and closes the keyboard; Back at the
  read-paper root returns to Project Home. There is no separate right-side
  keyboard-dismiss control.
- When the software keyboard pans an iOS `visualViewport`, its positive
  `offsetTop` becomes scrollable leading reserve inside `.editor-scroll`.
  Applying or removing it shifts `scrollTop` by the same delta before paint,
  preserving WebKit's automatic caret pan while making the document-start folio
  reachable. It must never become outer paper-deck padding.
- The keyboard accessory, structure panel, and tool panel have independent
  ownership. An already-open panel does not suppress the accessory above the
  software keyboard.
- Search state owns query scope, current match, and previous/next actions.
- Agent input shows explicit context chips and send/cancel state.
- A docked bottom panel places the bar immediately above the panel; a full
  panel returns it to the safe bottom edge.
- TOC and comments retain their shared Sheet/portal boundary; formatting does
  not share it.

## 7. Vertical panel rails

Both structure and tool workspaces use one 56px left vertical rail.

- Each item is at least 48px tall with a minimum 44x44 hit target.
- The rail has one navigation level only. Submodes stay in the content area.
- The rail is clipped, not compressed or restyled, while a panel is dragged.
- Active state uses wash, spacing, typography, and foreground contrast; inset
  left accent bars are forbidden.
- Chinese uses concise text labels. English uses an icon plus a short complete
  label without changing the rail orientation or width. Full accessible names
  remain available to assistive technology.
- Dashboard is not a structure-rail destination because it is an ordinary
  paper.
- Search and creation actions may occupy the rail tail.

The top rail contains Chapters, Elements, and Inspirations. The bottom rail
contains Planning, Agent, Library, and Stats. TODO is part of Library. Timeline
and Plot Grid are Planning submodes.

## 8. Editing and all-chapters

### 8.1 Single paper

- Focusing prose enters edit mode only after the software keyboard becomes
  visible and disables paper swipe. Losing the keyboard returns to read mode.
- Formatting must preserve the live selection and keyboard.
- The unified bar follows `visualViewport` above the software keyboard.
- Settled paper activation blurs the outgoing editor before mounting the next
  live paper, so horizontal switching cannot transfer a hidden edit state.
- TOC preserves the five-level outline and active ancestry.
- Comments preserve anchored/entity comments, creation, evidence navigation,
  resolve/reopen, TODO conversion, exception, Agent decisions, snapshots, and
  deletion.
- Entity links open a read-only preview first; an explicit action opens a
  paper. Backdrops consume their event and cannot click through.

### 8.2 All chapters

All-chapters remains an editable ordinary paper, not a reduced index.

- Chapters are one continuous vertical read-through with Act separators.
- Offscreen rows remain virtual/static; at most one chapter row promotes to a
  live editor.
- Touching static prose promotes that chapter at the touch/caret point.
- Changing the focused chapter flushes the previous live Yjs document before
  promotion completes.
- The unified bar exposes all-chapters, Act, chapter, search, and formatting
  context without covering prose.
- Search covers every chapter and can focus a hit without mounting all chapter
  editors.
- Leaving and returning restores read position, active outline entry, focused
  chapter, and caret intent.
- Synthetic 100- and 300-chapter projects are performance acceptance cases.

## 9. Planning and complete touch drag

Mobile Planning retains the full current Timeline and Plot Grid product
capability rather than a read-only projection.

Timeline must support:

- book/narrative modes, Act rail, narrative markers, placed and unplaced
  chapters, unaffiliated lane, spread, locate, cross-storyline links, persisted
  scale/position, and all shared context actions;
- continuous chapter coordinate drag in both modes;
- cross-storyline, default, unaffiliated, and holding-drawer drops;
- Act, boundary, and marker drag/binding behavior;
- edge autoscroll, cancellation, visual rollback, and exactly one atomic write
  on a valid drop;
- one full-style compositor ghost that preserves the grabbed point;
- background one-finger pan and Timeline-owned two-finger zoom.

Touch arbitration uses:

- tap to open;
- approximately 180ms stationary hold to arm a card drag;
- movement after arming to drag;
- approximately 500ms stationary hold to open the shared context menu;
- background movement to pan;
- two fingers to cancel pending single-pointer ownership and enter zoom;
- `pointercancel` or system interruption to cancel without a write.

Plot Grid retains cell input, row/column operations, mobile drag handles, and
TSV paste. Paper swipe is disabled anywhere inside the full Planning surface.

## 10. Agent, Library, TODO, Stats, and search

### Agent

- Mobile owns a dedicated presentation over the shared renderer Agent runtime.
- Conversations remain independent and durable within the mounted Project.
- Current paper, selection, element, or explicit author context appears as
  visible removable chips.
- An answer never writes prose automatically.
- Explicit outputs include copy, save as inspiration, create TODO, and existing
  approved write/review flows.
- Evidence navigation stores target plus stable block id; paragraph ordinals
  are display-only.

### Library and TODO

- Preserve create/edit/filter/complete/reopen and relation semantics.
- Preserve image/PDF native import and the existing 64 MiB boundary.
- Agent and Comment outputs can create TODOs through shared use cases.

### Stats

- Preserve current entity/project statistics in touch-sized, vertically
  scrollable presentation.
- Actionable statistics navigate to the exact paper or filtered result.

### Search

- Unified-bar search starts in the current paper.
- Current-paper search exposes previous, next, and `n/N`.
- Switching scope to the Project carries the query into Overview results.
- Project results group by paper, show match counts/context, and activate an
  existing paper or insert a new paper using ordinary session semantics.
- Editing, IME, selection, and search highlighting must not corrupt Yjs prose.

## 11. Super Views

Story Graph, Element Panorama, and Memo/Material are independent full-screen
surfaces matching desktop product semantics.

- They never enter paper session state or paper overview cards.
- Opening freezes the underlying paper workspace; closing restores it without
  route, paper-order, scroll, or editor-context loss.
- Their header switches directly among all three Super Views.
- Their own canvas owns pan, pinch-around-midpoint, node/card drag, relation
  creation, and nested menus.
- WebView page zoom, paper swipe, and panel drag remain disabled while active.
- Back closes the newest child layer before closing the Super View.

## 12. Local-first and Google Drive release gate

The mobile app remains usable without a Drifting hosted account. Local SQLite,
Yjs, assets, export, and BYOK are not contingent on hosted service access.

Google Drive is nevertheless a hard Mobile V2 release gate. Release requires:

- production desktop, iOS, and Android OAuth clients in one Google Cloud
  project, with exact iOS reversed scheme and Android package/signing binding;
- real-account connect, refresh, reauthorize, revoke, cancellation, mismatch,
  and lost-SDK-state acceptance on physical iOS and Android devices;
- Desktop/iOS/Android same-account automatic Project discovery and convergence;
- same- and different-chapter concurrent edits, relations, TODO, Plot Grid,
  Agent records, assets, deletion/recovery, and multi-project isolation;
- background, lock, force-stop, offline outbox, reconnect, credential expiry,
  low-storage, and low-memory recovery;
- no plaintext credentials or token exposure to renderer, logs, URLs, reports,
  screenshots, or committed files.

The native Drive SDK callback is distinct from Drifting hosted-account deep
links. Universal Links/App Links remain a public hosted-auth/deep-link gate but
are not incorrectly used as proof of native Drive SDK behavior.

## 13. Theme, accessibility, and motion

- Light, dark, and follow-system modes are release requirements.
- Mobile desk, page, rail, bar, panel, layer wash, search match, Agent message,
  drag ghost, canvas grid, sheet, and backdrop use semantic theme tokens.
- No layer or selection state relies on color alone.
- Every target is at least 44x44; ordinary UI labels are at least 12px.
- VoiceOver and TalkBack expose names, selected/expanded state, progress, match
  counts, and drag alternatives.
- System text scaling cannot hide primary actions or make prose uneditable.
- `prefers-reduced-motion` removes animation while retaining state and
  directional meaning.

## 14. Orientation and tablet shell policy

Mobile V2 has no landscape mobile layout.

- Phones and compact tablets are portrait-only and use Mobile Shell.
- Expanded tablets are also portrait-only but use Desktop Shell when the
  portrait logical viewport width is at least 1000 CSS px.
- Shell mode is resolved once during startup and does not switch during a
  resize or transient native viewport change.
- Native platform capabilities remain mobile on an expanded tablet; choosing
  Desktop Shell must not enable desktop-only window, MCP stdio, credential, or
  filesystem behavior.
- App routes, shelf, settings, and Project workspace all use the same resolved
  shell mode.

The 1000px threshold matches the current desktop minimum-width contract. It is
a product threshold, not UA guessing, and requires Simulator/device acceptance
on representative compact and expanded tablets.

## 15. MVP exclusions

Mobile V2 does not require:

- split editing on phone or compact tablet;
- desktop hover previews, right-click as the only action path, keyboard-only
  shortcuts, native window controls, or multi-column desktop chrome on Mobile
  Shell;
- a landscape Mobile Shell;
- multiple simultaneously live prose editors;
- hosted Drifting account, payment, or first-party hosted sync as a condition
  for local-first writing.

An excluded desktop input method never justifies removing the underlying
author capability when a usable touch interaction can be supplied.
