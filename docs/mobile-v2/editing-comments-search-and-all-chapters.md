# Mobile V2 editing, comments, search, and all-chapters

Status: **M4 implementation and Simulator/Emulator acceptance complete**

Updated: 2026-08-23

This document records the implemented M4 writing boundary. It is current
checkout truth for Mobile Shell editing, shared writing sheets, paper/Project
search, and the all-chapters paper. M5 still owns Planning touch drag and does
not inherit editor gestures.

## Writing-first unified bar

There is still one 56px `MobileUnifiedBar`. Focusing a live editor changes that
bar from read navigation to editing controls; it does not mount a second
floating accessory. The compact formatting trigger expands a shared mobile
sheet with paragraph, heading, quotation, and inline mark commands. Pointer
down is consumed before command dispatch so an existing ProseMirror selection
is not collapsed before the command runs.

Keyboard placement is derived from the greatest reliable inset:

- iOS and conforming WebViews use layout-versus-`visualViewport` geometry;
- Android's edge-to-edge WebView can retain a full-height `visualViewport`
  while Gboard overlays it, so `MainActivity` publishes the native
  `WindowInsetsCompat.Type.ime()` inset as CSS pixels and dispatches
  `drifting:native-keyboard-geometry`;
- the unified bar and editor accessory subscribe to both sources and use the
  larger inset.

Android hardware Back follows the M2 resolver. In edit mode its first action
blurs the active editor and dismisses IME; the next action unwinds the next
workspace layer. It does not leave a focused ProseMirror under read-state
chrome.

## One shared mobile-sheet boundary

`MobileBarSheet` owns the transient presentation for formatting, outline,
comments, and entity preview. It consumes its backdrop and keeps touch targets
at least 44px high. This is presentation reuse, not a second implementation of
editor semantics:

- the outline portal renders the real `EditorOutlineRail`, including the
  act/chapter/scene/beat/note hierarchy, current ancestry, omitted ancestors,
  and canonical scroll jumps;
- the comments portal renders the real `CommentRail`, including anchored and
  entity comments, creation, source snapshots, resolve/reopen, TODO conversion,
  review actions, and deletion;
- entity cells first open a read-only sheet; only an explicit open action adds
  an ordinary paper.

The rails use `EditorRailPresentationContext` to select the mobile portal host.
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
