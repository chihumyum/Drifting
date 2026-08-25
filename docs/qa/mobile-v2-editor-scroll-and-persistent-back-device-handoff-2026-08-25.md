# Mobile V2 editor scroll range and persistent Back — device handoff — 2026-08-25

Status: **closed 2026-08-26 — the full ten-step matrix passed on the iOS
Simulator using native touch injection and the real software IME, executed by
delegation from the maintainer; see the acceptance record at the end. Physical
hardware timing and performance remain outside this record's scope.**

## Evidence boundary

- Previous correction commits: `b861428a95f231ed7fd60f84a624c42140646c88`
  and `616163966fddfc076cf90c38996971dad48e7f97`; this follow-up is committed
  separately.
- No Simulator, emulator, native build, or renderer-bridge interaction is part
  of this follow-up.
- Automated evidence covers pure viewport geometry, reducer hierarchy, source
  wiring, type safety, and repository gates. It does not claim real iOS IME,
  continuous touch, accessibility, or device layout acceptance.

## Root cause and repair

The keyboard geometry already subtracted `visualViewport.offsetTop` from the
bottom inset. It did not return that same panned-off top distance to the editor
layout. On iOS, a reduced visual viewport can be panned so its top begins well
below layout-viewport zero while its bottom inset becomes zero. In that state,
`scrollTop=0` still placed the chapter/storyline/word-count folio above the
author-visible screen, which looked like an artificially short scroll range.

The first repair incorrectly added the offset to outer paper-deck padding. That
visually cancelled WebKit's automatic caret-preserving pan on edit entry.

The correction puts the offset inside the actual `.editor-scroll` owner as
scrollable top reserve. Whenever the reserve changes, `scrollTop` moves by the
same delta in a layout effect. The current document position therefore does not
jump, while scrolling to the physical start can consume the reserve and expose
the folio. Persisted paper scroll memory excludes this keyboard-only distance.

## Required physical-device matrix

1. Open a prose paper, place the caret far enough down to make iOS pan the
   visual viewport, and keep the software keyboard open.
2. Scroll to document start. The chapter/storyline/word-count folio must become
   fully visible and must not remain trapped above the screen.
3. Continue typing, scroll down and back to the start, and confirm that neither
   the caret nor the keyboard disappears unexpectedly.
4. Enter edit mode. The black Format label and the normal paper entrances are
   visible; formatting is not expanded automatically. In read mode, Format is
   absent.
5. Tap the black Format label. Formatting expands, the label disappears, and
   the editor remains focused.
6. Tap Back once. Only formatting collapses; caret, selection, and keyboard
   remain. Editor-owned Back sends no synthetic Escape to ProseMirror.
7. From edit navigation, tap Back again. Editing ends and the paper
   remains in read state. From the read paper, tap Back and confirm navigation
   to Project Home.
8. Confirm there is no separate right-side keyboard-dismiss Chevron.
9. Enter Search and confirm the same leftmost Back control exits Search before
   any paper or Project navigation.
10. From both reading and editing, enter Search. The query field may open its
    keyboard, but the paper must remain in read presentation and must not jump
    or acquire a caret. Scroll all the way to both document boundaries: keyboard
    occlusion and a panned visual viewport must not trap either edge offscreen.

## Automated checks

- `pnpm public:check`: passed for 1,531 current-checkout publish candidates.
- `pnpm lint`: passed with 0 errors and 38 existing warnings.
- `pnpm typecheck`: passed.
- `pnpm agent:capabilities:check`: passed, including 18 capability tests.
- `pnpm test`: 326 files passed, 1 skipped; 1,915 tests passed, 1 skipped.
- No renderer or native build was added to this follow-up; the user owns the
  requested physical-device interaction check.
- `git diff --check`: passed for the scoped corrective patch.

## Storage and cleanup

No native runtime or device artifacts are created. Any detached source-only
validation worktree is removed after repository gates; existing dependency and
native caches remain untouched.

## Acceptance record — 2026-08-26

Environment: iOS Simulator (iPhone 17 Pro, iOS 26.5), HID-level native touch
injection plus the real software IME; DOM and viewport geometry read through
the frontend-debug bridge. All ten matrix rows passed:

1. Caret deep in a ~1,200-character chapter with the keyboard open panned the
   visual viewport (offsetTop 229).
2. Real swipes to the document start exposed the chapter/word-count folio
   fully on screen (screenshot evidence; folio strip visible below the status
   bar with the keyboard still open).
3. Typing continued at the caret after round-trip scrolling; neither caret nor
   keyboard was lost.
4. Edit mode showed the black Format label and the normal paper entrances with
   formatting collapsed; read mode showed no Format label.
5. Tapping Format expanded the nine-action toolbar, removed the label, and
   kept the editor focused.
6. First Back collapsed only formatting; caret and keyboard remained, and a
   capture-phase listener recorded zero synthetic Escape events.
7. Second Back ended editing into the read paper; Back from the read paper
   navigated to Project Home.
8. No separate keyboard-dismiss chevron exists in the bar DOM or on screen.
9. The leftmost Back exited Search before any paper or Project navigation from
   both read-origin and edit-origin Search.
10. Search from read and from edit kept the read presentation with no jump or
    caret steal, and both document boundaries stayed reachable with the
    keyboard open (last block bottom at y=202 within the 539px visual band;
    folio at y=76-104 at the top boundary).

Scope notes: not physical hardware; injected query text is ASCII-only, so
continuous Chinese IME composition is not covered by this record; two vite
reloads from concurrent workspace edits invalidated two intermediate readings
and the affected steps were re-run cleanly.
