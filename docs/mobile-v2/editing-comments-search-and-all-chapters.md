# Mobile V2 editing, comments, search, and all-chapters

Status: **M4 implementation and Simulator/Emulator acceptance complete; current physical-device follow-up pending**

Updated: 2026-08-25

This document records the implemented M4 writing boundary. It is current
checkout truth for Mobile Shell editing, shared writing sheets, paper/Project
search, and the all-chapters paper. M5 still owns Planning touch drag and does
not inherit editor gestures.

## Writing-first unified bar

There is still one 56px `MobileUnifiedBar`, now presented as a floating pill and
owned independently from the top and bottom panels. A live editor enters edit
mode only when it is focused and the software keyboard is visibly open. Focus
without a keyboard is read mode; paper activation blurs the outgoing editor.
There is no supported caret-less pseudo-edit state.

Edit entry defaults directly to a horizontally scrollable single-row format
level with paragraph, heading, quotation, and inline mark commands. Formatting
never opens a Sheet. The unified Back control is always the leftmost control.
While formatting is expanded, the black Format label is absent and Back
collapses only the formatting row, preserving editor focus, caret, keyboard,
and selection. The collapsed navigation level then shows the black Format
label plus entity/status, numbered paper count, Search, and hamburger
entrances. Pressing that non-native-focus label restores formatting and removes
the label again. A second Back from the collapsed edit level exits editing;
Back on a read paper returns to Project Home. The right-side down Chevron stays
available at both edit levels and directly dismisses the keyboard without
changing the meaning of Back.

Keyboard placement is derived from the greatest reliable inset:

- iOS and conforming WebViews use layout-versus-`visualViewport` geometry;
- Android's edge-to-edge WebView can retain a full-height `visualViewport`
  while Gboard overlays it, so `MainActivity` publishes the native
  `WindowInsetsCompat.Type.ime()` inset as CSS pixels and dispatches
  `drifting:native-keyboard-geometry`;
- the keyboard accessory subscribes to both sources and uses the
  larger inset;
- when iOS pans the reduced `visualViewport`, its `offsetTop` becomes leading
  editor layout space while the keyboard is visible. Therefore `scrollTop=0`
  can still bring the chapter/storyline/word-count folio into the visible
  viewport instead of leaving it trapped above the screen.

The keyboard accessory may appear above the IME while a top or bottom panel
retains its own reducer state. Opening a panel no longer rewrites edit state;
closing the keyboard returns edit and keyboard ownership to read atomically.

Android hardware Back follows the M2 resolver. With formatting expanded, its
first action collapses that accessory level without touching the IME. The next
action blurs the active editor and returns to read mode; the following action
unwinds the next workspace layer. It does not leave a focused ProseMirror under
read-state chrome.

## Shared Sheet boundary without formatting

`MobileBarSheet` owns the transient presentation for outline and comments;
entity preview and current-paper status use their dedicated read-only Sheets.
They consume their backdrops and keep touch targets at least 44px high. This is
presentation reuse, not a second implementation of editor semantics:

- the outline portal renders the real `EditorOutlineRail`, including the
  act/chapter/scene/beat/note hierarchy, current ancestry, omitted ancestors,
  and canonical scroll jumps;
- the comments portal renders the real `CommentRail`, including anchored and
  entity comments, creation, source snapshots, resolve/reopen, TODO conversion,
  review actions, and deletion;
- entity cells first open a read-only sheet; only an explicit open action adds
  an ordinary paper.

Formatting is intentionally absent from this Sheet boundary. The rails use
`EditorRailPresentationContext` to select the mobile portal host.
Domain ownership, SQLite comment durability, live Yjs prose, and editor event
handling remain shared with desktop.

## Read-only search controllers

Current-paper search and Project search are separate, headless owners:

- current-paper search scans the active editor state and highlights matches
  with ProseMirror decorations. Previous/next navigation moves among matches
  without calling `setContent` or any prose write command;
- Project search performs read-only repository selects, groups results by
  paper in Overview, and exposes an ordinary `WorkspaceTarget` for activation;
- entering Project search first flushes the active editor, so the query observes
  committed local state without adding a search-specific write path;
- opening a Project result adds or activates the corresponding ordinary paper.

Search state is transient workspace state. It never creates a paper, mutates
Yjs, or changes paper order merely because a query ran.

## All Chapters is an editable ordinary paper

The all-chapters route stays inside the normal paper session. It is not a Super
View, panel, or independent editor stack.

Read rows load content through a deduplicating queue capped at six concurrent
reads. A 100- or 300-chapter document can therefore render progressively
without connecting hundreds of live editors. `mobileAllChaptersLivePlan`
permits exactly one live chapter, even if input contains a duplicate id.

A pointer sequence is a promotion tap only when it moves no more than 8px and
ends within 450ms. Promotion then:

1. flushes the previously active editor;
2. stores outline, focused chapter, and restore-selection intent;
3. mounts one live `VirtualChapterRow` at the touched chapter;
4. restores the caret/selection intent through the shared editor selection
   key and brings the row into view.

The All Chapters search owner indexes every loaded row and navigates matches
across chapters without making additional rows live. The shared outline sheet
targets the all-chapters scroll container. Scroll, focused chapter, outline
target, and caret-restoration intent survive route restoration and app restart.
The exact non-collapsed selection range is still subject to native WebView
lifecycle behavior and remains a physical-device acceptance item.

## Empty Project creation

The mobile Chapters panel exposes a sticky 44px `new chapter` action even when
the Project has no storyline or chapter. It invokes the existing `useBookNode`
create use case, including the canonical SQLite/Yjs seed boundary. A newly
created chapter opens as an ordinary node paper directly; it does not first
enter the entity-preview sheet.

## Deterministic evidence

- `src/renderer/shells/mobile/workspace/mobile-v2-editing.acceptance.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-paper-search.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-project-search.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-all-chapters.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-keyboard-geometry.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-workspace-controller.test.ts`
- `src/renderer/shells/mobile/workspace/mobile-interaction-repair.acceptance.test.ts`
- `src/renderer/app/mobile-standalone-routes.acceptance.test.ts`

The 100- and 300-chapter fixtures are synthetic. The tests cover bounded load
concurrency, exactly one live row, tap-versus-scroll classification, durable
position parsing, search grouping/navigation, no-write search wiring, shared
sheet portals, Android native IME geometry, edit-mode blur, and zero-chapter
creation wiring.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m4-editing-simulator-2026-08-23.md`](../qa/mobile-v2-m4-editing-simulator-2026-08-23.md)
records the reused iPhone 16e Simulator and existing Android Emulator runs.
iOS visibly covered English and Chinese input, native selection formatting,
paper and Project search, All Chapters promotion/search/TOC, comment creation,
and restart restoration. Android visibly covered Gboard inset placement, native
long-press selection, one-live All Chapters, hardware Back, and empty-Project
chapter creation.

This evidence is not physical-device acceptance. Real-finger ergonomics,
assistive technology, selection-range restoration across low-memory process
death, representative 300-chapter performance, lifecycle stress, release
signing, Planning touch drag, provider flows, and Google Drive remain open
milestone or final-device gates.
