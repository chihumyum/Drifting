# Mobile V2 format-toggle and 144 px panel-snap follow-up — device handoff — 2026-08-25

Status: **superseded by the persistent-Back device handoff**

The black Format-label toggle contract recorded below was replaced on
2026-08-25. Current behavior and the still-open physical-device boundary are
recorded in
[`mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md`](mobile-v2-editor-scroll-and-persistent-back-device-handoff-2026-08-25.md).

## Checkout and evidence boundary

- Follow-up baseline commit: `bc68e063325e91d50ca6c12ae61d027809fa12b2`.
- Source under test: that baseline plus the non-native Format target and 144 px
  close-zone follow-up.
- No Simulator, device runtime, native build, or renderer-bridge interaction was
  started for this follow-up.
- The user explicitly owns the current physical-device interaction acceptance;
  no new Simulator run is part of this follow-up.

The unrelated dirty checkout is outside this repair and its commit scope.

## Superseded required matrix

1. Entering prose editing opens the keyboard and the formatting accessory.
2. Tapping the Format label collapses only the horizontal formatting row. The
   editor remains focused, the caret/keyboard remain visible, and the complete
   navigation level appears.
3. The right-side down Chevron remains present after formatting collapses and
   dismisses the keyboard and accessory when explicitly tapped.
4. Tapping Format again restores the formatting row without inserting prose or
   changing the editor selection.
5. A slow top-panel release at 144 CSS pixels or less closes the panel; a release
   above that zone remains docked at the author-controlled height.
6. The same close-zone behavior applies to the bottom panel.

## Why the preceding Simulator evidence was insufficient

The previous implementation used a native `<button>` and attempted to prevent
its click default action. Although one Simulator click kept the keyboard open,
the user reproduced keyboard dismissal on a physical device. That evidence is
therefore retained only as a record of the inadequate test boundary; it does
not accept the current implementation.

The follow-up uses a non-native-focus `role=button` target, switches on
`pointerup`, consumes the later compatibility click, and calls
`EditorView.focus()` both inside the trusted activation and after React commits
the accessory-level change. The resulting navigation level must contain:

- the black Format entry;
- current paper identity;
- numbered open-paper entry;
- Search;
- hamburger menu;
- the right down Chevron.

No control except that Chevron owns explicit editor blur or keyboard dismissal.

## Superseded Simulator evidence

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

### Superseded deterministic 72 px close-zone interaction

The following slow synthetic pointer sequences were dispatched directly to the
live pull handles. Each release idled for more than 80 ms, so velocity resolved
to zero and could not trigger either fling rule.

| Panel | Release height in 763 px viewport | Result |
| --- | ---: | --- |
| Top | 61 px (`0.07995`) | `panel=none`, extent `0` |
| Top | 84 px (`0.11009`) | `panel=top-docked`, exact extent preserved |
| Bottom | 61 px (`0.07995`) | `panel=none`, extent `0` |
| Bottom | 84 px (`0.11009`) | `panel=bottom-docked`, exact extent preserved |

Dragging each 84 px docked boundary back by 30 px placed it inside the old 72 px
zone and closed it to `panel=none`, extent `0`.

The current close zone is 144 CSS pixels and is covered by pure resolver tests;
physical gesture acceptance is left to the user.

## Automated checks

- Focused Vitest: 5 files, 35 tests passed.
- Scoped ESLint for the changed TypeScript/TSX files: passed.
- `pnpm public:check`: passed for 1510 publish candidates.
- `pnpm lint`: passed with 0 errors and 41 pre-existing repository warnings.
- `pnpm typecheck`: passed.
- Repository-wide Vitest with `--maxWorkers=4`: 321 files passed, 1 skipped;
  1853 tests passed, 1 skipped.
- `pnpm agent:capabilities:check`: capability evidence current; 3 files and 18
  tests passed.
- Production Vite build: 3687 modules transformed and built in 7.11 s; only
  the repository's existing dependency/chunk-size warnings were reported.

## Storage and cleanup

No Simulator or native-build artifacts were created. Any detached source-only
validation worktree is removed after final gates; existing caches are untouched.

## Remaining boundary

The physical-device continuous touch remains open, including real-device IME
focus transfer, fling calibration, gesture interruption, accessibility,
safe-area ergonomics, lifecycle, and memory pressure.
