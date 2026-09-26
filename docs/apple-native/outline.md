# Native whole-book outline navigation

This batch connects the five-level outline to the existing native writing
workspace. It follows selection and heading formatting (`be701d92`). It provides
act separators, chapter navigation, lazy chapter-heading expansion and jumps to
scene/beat/note headings. The later [act boundary batch](act-boundaries.md)
adds creation, rename and removal; [tabs/split panes](tabs-and-split.md) are
recorded separately. Full outline density, folding parity and general remote
synchronization remain outside this navigation batch.

## Authoritative data and ownership

`WorkspaceStore::outline(project_id)` returns an ordered read projection of
`book_act` and current chapters in one deferred SQLite transaction. Act separators
use the existing continuous `bookOrder` axis: a nullable boundary anchors the
book head, finite boundaries apply at `chapter.bookOrder >= startOrder`, and
equal boundaries use UTF-8 ID order. Empty acts remain visible; chapters before
the first finite boundary stay unassigned. A tied chapter belongs to the last
applicable act. Current generation, lifecycle and purge rules apply. Reading
the outline writes no rows and changes no order, boundary or journal.

Each document projection contains `outline` items with `blockId`, `level`,
`text`, `parentId` and the current global UTF-16 `range`. The document core derives
them from live Yrs headings: H1 is scene, H2 beat, H3 note. Empty trimmed headings
are omitted. Stable unique IDs identify targets; a missing or duplicate identity
is not repaired by inventing a navigation ID. Nesting uses the nearest preceding
lower-level heading and does not create missing levels.

`workspaceOutline` exposes the ordered book rows. `workspaceChapterOutline`
reads any open chapter through its existing live owner, including a hidden tab;
an unopened chapter uses a temporary owner through the existing scoped, read-only
snapshot/tail loader.
The temporary read never replaces the active handle, persists, compacts or changes
history. Unsupported or corrupt prose retains its existing recovery refusal.
`contentJson` and `outline_json` remain caches, never outline truth.

## Native workflow

The AppKit window and UIKit chapter/editor screens expose an “整书大纲” panel.
It keeps the existing project and chapter lists available. The panel presents
act separators and chapters in core order, expands chapters on demand, and labels
headings as 场／拍／注. Swift owns disclosure and presentation state; it does not
reimplement act membership or heading hierarchy.

Clicking a chapter opens it through the existing workspace transition. Clicking
a heading in another chapter first completes that same transition, then resolves
its block ID in the loaded projection. A current-chapter jump retains the owner
and undo stack. `NativeDocumentView.reveal(blockId:)` looks up the current range,
moves only that view's caret and scrolls its heading into view. Old cached offsets
are never used as navigation authority. Missing targets, pending edits, marked
composition and failed saves cannot silently navigate away from the current work.
An idle notification during mounting is not document readiness: the target stays
pending until an editable projection has been rendered. Attended Mac navigation
exposed and fixed this distinction before accepting the batch.

## Bounded acceptance

The declared local navigation batch passed source/file-backed checks, 65
programmatic AppKit cases, attended Mac interaction, and 15 hosted UIKit cases
plus 2 writing workflows on each of the iPhone and iPad simulators. macOS,
iOS simulator and unsigned device-target builds passed. These outcomes do not
close the physical-device, synchronization or release gates below.

- Core tests cover null/finite boundaries, empty acts, tied UTF-8 identities,
  current scope/lifecycle, project isolation and unchanged SQLite contents.
  Actual query results are compared with production `deriveActSegments`.
- Document tests and the Yjs runner cover stable heading identity, scene/beat/note
  hierarchy, blank/repeated titles, Unicode ranges, formatting changes, local
  history and cold reopening. The renderer's actual extraction and nesting
  functions provide the comparison.
- Bridge tests distinguish live-current from stored-other chapter outlines,
  preserve the current handle/history and verify reads do not mutate SQLite.
- Programmatic AppKit/UIKit tests edit a prefix, navigate using the new range,
  retain history and test reopening and composition guards. AppKit also checks
  the passive view is not moved.
- Simulator UI workflows expand the current chapter, jump to a heading after
  restart, and navigate to a stored heading in a different chapter while
  preserving the project's order and independent prose. A jump must also dismiss
  the outline panel; an updated chapter label alone does not count as completion.
- Attended Mac interaction on the fresh source build verified cross-chapter
  dismissal/focus and heading-start input, current-chapter undo/redo preservation,
  and stored-heading navigation after quit/relaunch. The ignored observation
  records the runtime fingerprint and binary hash; it is separate from XCTest
  and physical IME evidence.

Generated outcomes and source identities live in the [document](acceptance/p2a-document.json),
[workspace](acceptance/p3a-workspace.json), [binding](acceptance/p2b-binding.json)
and [native](acceptance/p2b-native.json) reports. Physical device/IME, accounts,
desktop XCTest and signed distribution remain independent gates. No performance
matrix or extra historical migration path is introduced by this read/navigation
batch. Known old-peer alias-delete failures remain open before affected sync is
enabled.
