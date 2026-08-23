# Mobile V2 M6 Agent, Library/TODO, and Stats iOS Simulator and Android Emulator acceptance — 2026-08-23

Status: **M6 Simulator/Emulator acceptance passed; live-provider and physical-device acceptance remain open**

## Checkout and evidence boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that baseline plus the M0-M6 milestone series
- Build mode: local-only native debug; no Drifting account or hosted service
- iOS transport: DEV-only renderer bridge reporting
  `inputPath=synthetic-dom` and `nativeInput=false`
- Android transport: Android CDP reporting `inputPath=cdp-webview` and
  `nativeInput=false`; Android hardware Back was sent through `adb`

Device screenshots are pixels from the installed native shells. WebView taps,
typing, and drag commands are not described as native finger input. The test
did not use a live model provider, Google account, private manuscript, or user
Project. Clipboard confirmation was not claimed because Simulator pasteboard
permission is a separate native boundary.

## Reused devices and storage policy

The run reused the existing `iPhone 16e / iOS 26.1` Simulator, UDID
`7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`, and existing Android AVD
`Persimmon_API_35` as `emulator-5554`. No Simulator, Emulator, runtime, Android
system image, NDK, package tree, or duplicate AVD was created or downloaded.

The existing Rust, Apple, Android, and package build caches were retained. The
iPhone fixture database was about 1.6 MiB and was backed up before one synthetic
Agent conversation was inserted. Debug evidence stayed below 10 MiB. Free disk
space remained about 33 GiB.

## iOS Simulator matrix

The app-created disposable Project contained one ordinary chapter and only
synthetic prose, TODO, Library, and Agent data.

The running iPhone Simulator verified:

1. A bottom-handle drag promoted the tool workspace to `bottom-full` while the
   paper remained 1:1. Agent, Library, and Stats stayed reachable through the
   one-level 56px rail in a 390×763 CSS-pixel portrait viewport.
2. The Agent empty/error state showed the current Project and paragraph chips,
   the answer-only safety notice, unconfigured-provider state, and a 44px
   Settings action without horizontal overflow.
3. One persisted synthetic conversation loaded through visible History. New,
   close, conversation-row, and delete targets measured at least 44px. The
   loaded user message retained its Project/entity/block context after restart.
4. The transcript showed thinking, one successful read tool, a completed answer,
   token usage, one stable evidence chip, and 44px Copy / Save as inspiration /
   Add TODO author actions. No write tool was available to the mobile turn;
   answer-only turns also cannot arm or expose executable task continuation.
5. Tapping the evidence chip opened the ordinary chapter route and produced one
   target-block flash animation for stable block
   `01a02eca-6577-742f-80a4-19727ccdd4d8`.
6. Tapping Add TODO created a durable TODO containing the full synthetic answer
   and a visible block relation. The manual TODO path also created, related,
   resolved, archived, and reopened an item through visible UI. Archive reopen
   and delete actions measured 44px after the acceptance correction.
7. Tapping Save as inspiration created and opened free-floating node
   `01a02ece-8dd2-751b-b744-a76ebcdeaa9d`. SQLite confirmed `kind=drift`, a
   70-word Yjs-backed projection, and no parent or storyline requirement. This
   was an explicit author action, not an automatic Agent prose write.
8. A text Library item was created, related to the chapter, edited, and deleted.
   The acceptance run exposed that delete was only reachable by right-click;
   M6 added an explicit 44×44 More button and a body-portaled fixed menu whose
   actions measured 44px high.
9. Current-paper and whole-book Stats both rendered. Their mode controls were
   44px, `data-mobile-stats=ready` was visible for whole-book state, and document
   width remained 390px at a 390px viewport.
10. The app switched to dark mode through the visible mobile Settings flow.
    Agent, TODO/Library, Stats, panel chrome, and the unified bar remained
    readable with no white root flash.

The synthetic Agent fixture was inserted only after the app was stopped and a
SQLite backup was made. It exercised conversation rendering and author actions;
it is not a claim that a live provider streamed that output. One earlier debug
typing command targeted an obscured ProseMirror while the Agent panel was full;
that text was treated only as synthetic fixture content and is not counted as
visible writing acceptance.

## Android Emulator matrix

The Android app created a disposable local Project named `M6 安卓验收` through
visible shelf UI. The running Emulator verified:

1. Runtime state reported `platform=android`, `deviceClass=compact`,
   `shellMode=mobile`, and a 412×915 portrait viewport. Google Drive transport
   and OAuth capabilities were compiled as available, but no account flow was
   attempted in M6.
2. The full Agent panel showed the current Project chip, localized answer-only
   safety notice, honest unconfigured-provider error, and explicit text saying
   it can only read the Project and cannot rewrite prose. All visible Agent
   header/provider/composer buttons measured at least 44px.
3. TODO and Library internal modes were reachable without a second rail. Empty
   states, current-item filters, relation visibility, add actions, and archive
   header fit the same panel; visible controls measured at least 44px.
4. Current-paper Stats showed the deliberate Project Home empty state. Whole
   book showed the no-chapters state with `data-mobile-stats=ready`. Both mode
   buttons measured 44px and `document.body.scrollWidth === innerWidth === 412`.
5. A WebView drag promoted the tool panel to `bottom-full`. A real Android
   hardware Back event changed controller state from `bottom-full` to
   `bottom-docked` and extent `1` to `0.3`. A second real hardware Back changed
   it from `bottom-docked` to closed/`none`, extent `0`, without leaving the
   Project route.

The Android run is cross-platform presentation and system-Back evidence. It
does not duplicate the iOS CRUD fixture and does not claim native touch input.

## Console and build observations

- The iOS evidence bundle contained no console errors.
- Android recorded the expected failed first Vite HMR WebSocket attempt to
  `tauri.localhost`, immediately followed by the documented direct-loopback
  fallback and `[vite] connected.`. No product/runtime exception was recorded.
- iOS and Android native debug builds installed and launched successfully.
  Cached Rust work completed in under two seconds; no new SDK/runtime was
  downloaded.

## Deterministic and repository gates

The final source/docs state passed:

- focused M6 logic/acceptance: 8 files and 58 tests;
- complete Vitest suite: 311 files and 1,798 tests passed, with 1 existing file
  and 1 existing test skipped;
- Agent capability evidence: current, with 3 files and 18 tests passed;
- `pnpm public:check`: 1,487 tracked/untracked publish candidates passed;
- `pnpm lint`: passed with 0 errors and 41 pre-existing repository warnings;
- `pnpm typecheck`: passed;
- `pnpm exec vite build`: 3,680 modules built successfully. Existing bundle
  size and mixed static/dynamic import notices remain warnings, not failures;
- `git diff --check`: passed.

These gates cover mobile turn-context and Agent model logic; runtime read-only
tool filtering, inactive automatic continuation, and system-prompt contracts;
generated Agent capability drift; Mobile Agent/Library/TODO/Stats wiring;
desktop menu-contract preservation; and design-document markers.

## Storage and cleanup

- The task reused existing multi-gigabyte build caches so M7-M9 do not need to
  rebuild them from scratch.
- The exact synthetic iOS/Android app installations and their app-owned data
  were removed after acceptance.
- The three exact Debug bundles (about 6.5 MiB total) and the 1.6 MiB temporary
  SQLite backup were moved to macOS Trash after durable results were recorded;
  none remains in the workspace or is committed. The user's broader Trash was
  not emptied.
- The reused Simulator and Emulator are shut down. Their runtime, system image,
  AVD definition, and reusable caches remain.

## M6 conclusion and remaining boundary

M6 passes its Simulator/Emulator-specific gate: compact Mobile Shell now owns a
usable Agent presentation with persisted context/evidence and a hard answer-only
runtime boundary; output changes require author taps; complete Library/TODO
semantics remain reachable without desktop-only hover/right-click; and current
and whole-book Stats fit the portrait vertical workspace.

Live-provider streaming/billing/retention, native clipboard permission,
physical touch and accessibility, lifecycle/low-memory stress, representative
large-Project performance, M7 independent Super Views, M8 real-account Google
Drive, signing, and M9 RC acceptance remain open.
