# Mobile V2 editor scroll range and persistent Back — device handoff — 2026-08-25

Status: **implementation complete; physical-device acceptance is user-owned and pending**

## Evidence boundary

- Baseline commit: `24eb1b7e00df8e4dbfe678eeddce6cddcbef44f5`.
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

The repair publishes the keyboard-visible visual-viewport top offset as a
separate CSS variable and adds it to the paper deck's leading padding. It is
zero when no software keyboard is visible and is independent from the bottom
keyboard inset used by the floating bar.

## Required physical-device matrix

1. Open a prose paper, place the caret far enough down to make iOS pan the
   visual viewport, and keep the software keyboard open.
2. Scroll to document start. The chapter/storyline/word-count folio must become
   fully visible and must not remain trapped above the screen.
3. Continue typing, scroll down and back to the start, and confirm that neither
   the caret nor the keyboard disappears unexpectedly.
4. Enter edit mode. The leftmost Back control is visible, the full horizontal
   formatting row is expanded, and no black Format label is present.
5. Tap Back once. Only formatting collapses; caret, selection, and keyboard
   remain. The black Format label and paper-context/count/Search/menu entries
   appear.
6. Tap the black Format label. Formatting expands, the label disappears, and
   the editor remains focused.
7. From collapsed edit navigation, tap Back again. Editing ends and the paper
   remains in read state. From the read paper, tap Back and confirm navigation
   to Project Home.
8. At either edit level, the right Chevron directly dismisses the keyboard.
9. Enter Search and confirm the same leftmost Back control exits Search before
   any paper or Project navigation.

## Automated checks

- `pnpm public:check`: passed for 1,511 publish candidates.
- `pnpm lint`: passed with 0 errors and the existing 41 warnings.
- `pnpm typecheck`: passed.
- `pnpm agent:capabilities:check`: passed, including 18 capability tests.
- `pnpm exec vitest run --maxWorkers=4`: 321 files passed, 1 skipped;
  1,857 tests passed, 1 skipped.
- `pnpm exec vite build`: passed with 3,687 modules transformed.
- `git diff --check`: passed for the isolated milestone patch.

## Storage and cleanup

No native runtime or device artifacts are created. Any detached source-only
validation worktree is removed after repository gates; existing dependency and
native caches remain untouched.
