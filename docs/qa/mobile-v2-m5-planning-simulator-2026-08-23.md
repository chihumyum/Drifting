# Mobile V2 M5 Planning iOS Simulator and Android Emulator acceptance — 2026-08-23

Status: **M5 Simulator/Emulator acceptance passed; physical touch acceptance remains open**

## Checkout and evidence boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that baseline plus the M0-M5 milestone series
- Build mode: local-only native debug; no official account or hosted service
- iOS transport: DEV-only renderer bridge, reporting
  `inputPath=synthetic-dom` and `nativeInput=false`
- Android transport: Android CDP, reporting `inputPath=cdp-webview` and
  `nativeInput=false`; Android hardware Back was sent with `adb`

Device screenshots are device-pixel evidence of the running native shells.
The recorded pointer sequences are WebView/renderer input and are not described
as native finger input. This run does not close physical touch, real
multi-touch, native accessibility, signed-build, provider, account, background,
or release gates.

## Reused devices and storage policy

The run reused the existing `iPhone 16e / iOS 26.1` Simulator, UDID
`7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`, and the existing Android AVD
`Persimmon_API_35` as `emulator-5554`. No Simulator, Emulator, runtime, Android
system image, NDK, or dependency tree was created or downloaded.

The existing repository Rust target, Apple generated build, Android Gradle
build, and package cache were reused. The iOS database was 2.1 MiB before the
fixture. A SQLite backup was created before inserting synthetic planning data.
No account, credential, Drive state, private manuscript, or user Project was
read or copied.

## iOS Simulator matrix

The disposable local Project contained four synthetic chapters, two synthetic
storylines, one cross-storyline membership, one unaffiliated chapter, one
narrative-unplaced chapter, one Act, one marker, and a 2×2 Plot Grid.

The running iPhone Simulator verified:

1. A bottom-panel drag promoted Planning from docked to full without scaling
   the underlying paper. The 56px tool rail and Timeline/Plot subtabs stayed
   reachable in portrait.
2. Device pixels showed book/narrative switching, `显示未归属 1`, one Act,
   primary and secondary lanes, the dashed cross-storyline connection, spread,
   locate, and the ordinary mobile unified bar.
3. Narrative mode showed `未放置 1` and the unplaced popover; the marker label
   `转折点` was present on the narrative axis.
4. A synthetic touch pointer held for 220ms and then moved. One compositor
   ghost completed and the selected chapter moved from `book_order=1` to
   `book_order=8.8`; its primary storyline remained singular. SQLite integrity
   remained `ok`.
5. A separate stationary synthetic touch opened the shared chapter context
   menu after 500ms. The menu exposed writing status, storyline editing,
   deletion, and transfer-to-unaffiliated actions without a chapter write.
6. The Plot subtab displayed the normalized authored labels and values. Its
   add-row, add-column, delete, and resize controls measured 44px. Adding one
   row and column plus pasting `甲/乙/丙/丁` as a 2×2 TSV block produced a
   visible 3×3 grid.
7. After the 400ms coalescing boundary, the stopped database contained three
   normalized rows, three normalized columns, the four pasted cell values,
   and a materialized `plotGridJson` containing both `甲` and `丁`.
   `PRAGMA integrity_check` returned `ok`.

The first disposable Plot fixture used `b0` as an order key. The production
writer correctly rejected it as an invalid fractional-indexing key. The
fixture was corrected to repository-valid `a0/a1`; the repeated accepted run
produced no new console error. This was fixture correction, not a product-code
workaround.

## Android Emulator matrix

The Android app created a disposable local Project and then used the visible
global `新章节` action. That canonical app action created and opened `New
Chapter` as an ordinary paper.

The rebuilt app installed successfully and verified:

1. Runtime state reported `platform=android`, `deviceClass=compact`,
   `shellMode=mobile`, and a 412×915 portrait viewport.
2. The full Planning panel showed the one-level tool rail, Timeline/Plot
   subtabs, book/narrative switch, Act creation track, spread, locate, a
   synthetic book lane, and the app-created chapter card.
3. Device pixels confirmed the panel filled the cropped portrait workspace and
   kept the unified bar above the Android navigation area.
4. A real Android hardware Back event reduced `panelExtent` from `1` to `0.3`
   and changed controller state from `bottom-full` to `bottom-docked` without
   leaving the chapter route or removing the active ordinary paper.

The Android run was a cross-platform layout/controller acceptance, not a
duplicate full-data fixture or a native drag claim. The iOS run and deterministic
tests carry the full Planning/gesture/Plot data matrix.

## Deterministic and repository gates

The final focused M5 set passed 8 files and 30 tests. The final M5 checkout also
passed:

- `pnpm public:check`: 1,479 publish candidates validated.
- `pnpm lint`: zero errors; 41 pre-existing repository warnings remain.
- `pnpm typecheck`: passed.
- `pnpm test`: 308 files and 1,787 tests passed; one file and one test skipped.
- `pnpm agent:capabilities:check`: 3 files and 18 tests passed; generated
  capability evidence remained current.
- `pnpm exec vite build`: production renderer build passed; existing bundle
  size and mixed static/dynamic import warnings remain.

## Storage and cleanup

- Free disk space remained approximately 33 GiB during the run.
- Existing multi-gigabyte Rust/Apple/Android build caches were retained for
  later milestones.
- Task-created synthetic app data, temporary SQLite backup/fixture files, and
  M5 Debug evidence are removed after durable results are recorded.
- The reused Simulator and Emulator are shut down after acceptance; their
  runtimes, system images, AVD definitions, and reusable build caches remain.

## M5 conclusion and remaining boundary

M5 passes its Simulator/Emulator-specific gate: complete Planning is reachable
in the vertical mobile workspace; the shared Timeline retains its authored
model and actions; delayed touch drag has deterministic exactly-once writes and
zero-write cancellation; midpoint pinch and edge scroll are wired; and Plot
Grid structure, TSV input, cancellation, and normalized persistence are
available on mobile.

Real continuous touch, real pinch, long-press feel, edge-autoscroll feel, OS
interruption, accessibility, lifecycle/low-memory stress, large-project
performance, M6-M9, provider flows, and Google Drive remain open.
