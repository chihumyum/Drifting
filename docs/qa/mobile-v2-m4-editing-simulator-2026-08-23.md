# Mobile V2 M4 editing iOS Simulator and Android Emulator acceptance — 2026-08-23

Status: **M4 Simulator/Emulator acceptance passed; physical-device acceptance remains open**

## Checkout and evidence boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that baseline plus the M0-M4 milestone series
- Build mode: local-only native debug; no official account or hosted service
- iOS visible input: Simulator UI through Computer Use
- iOS renderer setup/inspection: DEV-only bridge, explicitly reporting
  `inputPath=synthetic-dom` and `nativeInput=false`
- Android visible input: Emulator UI, Gboard, Android selection UI, and hardware
  Back through `adb`; renderer setup/inspection used Android CDP with
  `nativeInput=false`

The renderer bridges were used for deterministic fixture navigation and
inspection, not represented as native touch. The native input observations are
listed separately below. This is not a signed build, physical-device touch or
IME acceptance, Google-account/Drive acceptance, performance approval, or a
Mobile V2 release claim.

## Reused devices and synthetic fixtures

The run reused the existing `iPhone 16e / iOS 26.1` Simulator, UDID
`7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`, and the existing Android AVD
`Persimmon_API_35` as `emulator-5554`. No Simulator, Emulator, runtime, or
system image was created.

Two disposable local-only projects were used:

- iOS `M4 Mobile Fixture` contained three synthetic chapters and synthetic
  prose for English/Chinese input, headings, search, comments, and restart;
- Android `M4AndroidFixture` contained three synthetic chapters, then exercised
  the visible empty/global chapter-create action to create a fourth node.

The stopped apps' SQLite fixtures were backed up before controlled insertion.
No user project, account, credential, Drive state, or private manuscript text
was read or copied.

## iOS Simulator matrix

On the reused iPhone Simulator, native visible interaction verified:

1. Focusing the live editor opened the system keyboard and placed the unified
   bar directly above it. English input inserted `o`; switching the system
   keyboard to Simplified Chinese Pinyin inserted and selected `测试`.
2. Native selection selected the synthetic word `by`. Opening the formatting
   sheet and invoking Bold kept the editor path alive, and the resulting
   `strong` mark remained after restart.
3. Current-paper search found the synthetic query `by` as `1/1`. Project search
   displayed three paper-grouped cards in Overview; activating a result opened
   that chapter as an ordinary paper.
4. All Chapters rendered three rows with exactly one live editor. A touch
   promotion moved the live row, and search for `测试词` navigated from `1/3` to
   the third chapter at `3/3` without opening extra live editors.
5. The shared outline sheet showed the synthetic heading `Return` and navigated
   the all-chapters scroll owner. The real Comment Rail created the synthetic
   note `M4 simulator note`; its open SQLite row was inspected after creation.
6. After terminating and relaunching the app, All Chapters restored with one
   live row among three, scroll position `461`, the focused/outline/caret intent,
   and the persisted bold text. The run did not prove exact non-collapsed
   selection endpoints after restart and does not claim that boundary.

Renderer queries were also used to count live editor mounts, inspect controller
state, and read route/scroll geometry. Those observations are bridge evidence,
not native-touch evidence.

## Android Emulator matrix

The initial Android run exposed a platform defect: Gboard overlaid the
edge-to-edge WebView while `visualViewport` incorrectly remained 915 CSS px
high, leaving the bar under the keyboard. M4 added a native
`WindowInsetsCompat.Type.ime()` bridge. The rebuilt Kotlin/native app installed
successfully, then the same Emulator verified:

1. Gboard published a `336.381px` CSS keyboard inset. The 56px unified bar
   occupied `y=522.667..578.667`, immediately above the keyboard.
2. Native Gboard input inserted `q` in the synthetic heading. Native long press
   produced Android's non-collapsed selection UI while the unified bar remained
   visible above Gboard.
3. All Chapters rendered three rows with exactly one live editor.
4. The first Android hardware Back blurred the live ProseMirror and hid IME;
   the second left edit state without changing the All Chapters route. After
   that correction, the active element was `BODY` and there was no
   `.ProseMirror-focused` node.
5. The global Chapters surface exposed one visible, enabled `新章节` action with
   a measured height of 44px. Activating it entered
   `/editor/01a02e79-caa9-7026-bf7f-f284e1d83e7a`, and an in-app SQLite query
   confirmed that the synthetic Project's `book_node` count increased from
   three to four. The new node opened as an ordinary paper, not a preview.

The run did not claim an Android formatting-sheet tap: the Android acceptance
scope was native IME geometry, native selection, Back, one-live All Chapters,
and chapter creation. Two Tauri callback-id warnings seen after deliberate
manual page reloads were debug-tool side effects; no application error was
observed in the normal paths above.

## Deterministic and repository gates

The final checkout passed:

- `pnpm public:check` — 1,476 tracked and untracked publish candidates passed;
- `pnpm lint` — exited successfully with zero errors and 41 warnings;
- `pnpm typecheck` — passed;
- `pnpm test` — 304 files passed, 1 skipped; 1,775 tests passed, 1 skipped;
- `pnpm agent:capabilities:check` — generated evidence current and 18 focused
  capability tests passed;
- `pnpm exec vite build` — production renderer build passed with existing
  chunk-size/dynamic-import warnings;
- `git diff --check` — passed.

The final focused M4/controller set passed 9 files and 55 tests. It covers
read-only search, shared sheets, Android IME geometry, Back blur, All Chapters
100/300 fixtures, and zero-chapter creation.

## Storage and cleanup

- Free disk space was approximately 33 GiB after cleanup.
- The existing 42G repository Rust target, 2.0G Apple generated build, and 6.7G
  Android app build were retained as reusable caches; no duplicate build root
  was created.
- Four task-created debug runs, the temporary Android SQLite working copy, and
  installed synthetic app data were removed. The unrelated older debug run was
  preserved.
- The reused Simulator and Emulator were shut down. Existing runtimes, system
  images, shared targets, and native build caches were preserved.

## M4 conclusion and remaining boundary

M4 passes its Simulator/Emulator-specific gate: writing controls stay in one
keyboard-aware bar; real outline/comment semantics portal into one shared
sheet; current-paper and Project search remain read-only; All Chapters keeps
one live editor while supporting promotion, search, TOC, focus, scroll, and
restart; and an empty Project remains writable on mobile.

M5-M9, continuous physical touch, assistive technology, lifecycle/low-memory
stress, representative large-book performance, signed artifacts, live provider
flows, and real Google Drive account acceptance remain open.
