# Mobile V2 format-toggle and panel-snap correction — iOS Simulator acceptance — 2026-08-25

Status: **iOS Simulator acceptance passed; physical-device touch remains open**

## Checkout and evidence boundary

- Baseline commit: `d030b494e1fb81a898e8c9bbae1eb558c3b1d8e5` (including
  the preceding `08fef5920215468e6d398c47b6c226d0d3b9ca18` mobile
  single-handle milestone).
- Source under test: that baseline plus this format-toggle/panel-snap repair.
- Reuse the existing iPhone 16e / iOS 26.1 Simulator and native build caches;
  do not create another runtime or device.
- Renderer inspection and deterministic edge drags use the DEV-only bridge
  labelled `inputPath=synthetic-dom` and `nativeInput=false`.
- Native interaction evidence uses Computer Use against the Simulator window;
  its clicks are not renderer-bridge DOM taps.

The unrelated dirty checkout is outside this repair and its commit scope.

## Required matrix

1. Entering prose editing opens the keyboard and the formatting accessory.
2. Tapping the Format label collapses only the horizontal formatting row. The
   editor remains focused, the caret/keyboard remain visible, and the complete
   navigation level appears.
3. The right-side down Chevron remains present after formatting collapses and
   dismisses the keyboard and accessory when explicitly tapped.
4. Tapping Format again restores the formatting row without inserting prose or
   changing the editor selection.
5. A slow top-panel release at 72 CSS pixels or less closes the panel; a release
   above that zone remains docked at the author-controlled height.
6. The same close-zone behavior applies to the bottom panel.

## Simulator evidence

- Reused device: iPhone 16e, iOS 26.1,
  `7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`.
- Debug run: `run-2026-08-24T16-05-38-274Z-6be006c8`.
- The native Xcode build completed and deployed the development app to that
  existing Simulator. No new Simulator device or runtime was created.
- Disposable project: `Format Snap Fixture`; active paper: `New Chapter`.

### Native focus and accessory interaction

1. A native Simulator click focused the empty ProseMirror surface. Toggling the
   iOS software keyboard during WebKit's focus-opening window produced a real
   caret and system keyboard. The renderer then reported `paperMode=edit`,
   `accessory=formatting`, `keyboard=open`, an editable focused ProseMirror, and
   a 227 px visual-viewport offset.
2. A native click on the left Format label collapsed only the formatting row.
   The screenshot showed the chapter/search/menu navigation level and the
   right Chevron while the iOS keyboard and caret remained visible.
3. The post-click renderer snapshot still reported an editable focused
   ProseMirror, a collapsed selection at offset 0, `paperMode=edit`,
   `accessory=navigation`, and `keyboard=open`. The formatting-actions query
   returned zero rows, while both `mobile-toggle-formatting` and
   `mobile-dismiss-keyboard` remained visible.
4. A second native Format click restored the formatting row without moving the
   caret or adding prose. A native click on the right Chevron then removed the
   system keyboard and returned the controller to `paperMode=read` and
   `keyboard=closed`.

### Deterministic close-zone interaction

The following slow synthetic pointer sequences were dispatched directly to the
live pull handles. Each release idled for more than 80 ms, so velocity resolved
to zero and could not trigger either fling rule.

| Panel | Release height in 763 px viewport | Result |
| --- | ---: | --- |
| Top | 61 px (`0.07995`) | `panel=none`, extent `0` |
| Top | 84 px (`0.11009`) | `panel=top-docked`, exact extent preserved |
| Bottom | 61 px (`0.07995`) | `panel=none`, extent `0` |
| Bottom | 84 px (`0.11009`) | `panel=bottom-docked`, exact extent preserved |

Dragging each 84 px docked boundary back by 30 px placed it inside the 72 px
zone and closed it to `panel=none`, extent `0`.

## Automated checks

- Focused Vitest: 5 files, 23 tests passed.
- Scoped ESLint for the changed TypeScript/TSX files: passed.
- `pnpm public:check`: passed for 1510 publish candidates.
- `pnpm lint`: passed with 0 errors and 41 pre-existing repository warnings.
- `pnpm typecheck`: passed.
- Repository-wide Vitest with `--maxWorkers=4`: 321 files passed, 1 skipped;
  1852 tests passed, 1 skipped. The default worker count twice timed out the
  unrelated 1000-fragment Agent Runtime stress case at its 20 s ceiling; that
  exact case passed alone in 3.30 s before the bounded-worker full run passed.
- `pnpm agent:capabilities:check`: capability evidence current; 3 files and 18
  tests passed.
- Production Vite build: 3687 modules transformed and built in 12.45 s; only
  the repository's existing dependency/chunk-size warnings were reported.

## Storage and cleanup

The disposable app data, debug artifacts, and any detached validation worktree
will be removed after final gates. Existing native caches remain reused.

## Remaining boundary

The physical-device continuous touch remains open, including real-device IME
focus transfer, fling calibration, gesture interruption, accessibility,
safe-area ergonomics, lifecycle, and memory pressure.
