# Mobile V2 M7 independent Super Views iOS Simulator and Android Emulator acceptance — 2026-08-23

Status: **M7 Simulator/Emulator acceptance passed; physical multi-touch acceptance remains open**

## Checkout and evidence boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that baseline plus the M0-M7 milestone series
- Build mode: local-only native debug; no Drifting account or hosted service
- iOS transport: DEV-only renderer bridge reporting
  `inputPath=synthetic-dom` and `nativeInput=false`
- Android transport: Android CDP reporting `inputPath=cdp-webview` and
  `nativeInput=false`; Android hardware Back was sent through `adb`

Device screenshots were pixels from the installed native shells and were
visually inspected before cleanup. WebView pointer synthesis and CDP actions are
not described as finger input. The run used disposable empty Projects and did
not use a Google account, private manuscript, or private service data.

## Reused devices and storage policy

The run reused the existing `iPhone 16e / iOS 26.1` Simulator, UDID
`7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`, and the existing Android AVD
`Persimmon_API_35` as `emulator-5554`. No Simulator, Emulator, runtime, Android
system image, NDK, package tree, or duplicate AVD was created or downloaded.

The existing native and package build caches were retained for M8-M9. The
temporary evidence occupied about 264 KiB on iOS and 588 KiB on Android. Free
disk space remained about 33 GiB before and after cleanup.

## iOS Simulator matrix

The app-created disposable Project was named `M7 iOS 验收`. In a 390×763
CSS-pixel portrait viewport, the installed native shell verified:

1. Element Panorama opened as a 390×763 full-screen modal host while the sole
   Dashboard paper remained mounted, inert, and hidden from the accessibility
   tree. `data-gesture-owner=super-view` and a captured return point were
   present; body width remained exactly 390px.
2. The shared header switched Element Panorama → Story Graph → Memo and
   Material without changing the paper key, active paper, route, or return
   point. Final Back, switch, relation, and header controls measured at least
   44px.
3. A synthetic two-pointer Element pinch changed the world transform to
   `translate(195px, 96px) scale(2)` while `visualViewport.scale` remained `1`.
   It therefore exercised midpoint-preserving canvas math and page-zoom
   exclusion through the declared synthetic input path, not native multi-touch.
4. Story Graph Create relation mode became active. Tapping Back cleared that
   sub-layer while the graph host stayed open, proving that one Back action did
   not close two levels.
5. Memo and Material used a vertical split in the portrait host; its document
   width remained 390px and the visible surface had no horizontal overflow.
6. Closing the host restored the Dashboard paper with the same one-key order,
   active key, scroll position `0`, and route. Debug state reported
   `lastSuperViewRestoreStatus=preserved`; the paper was no longer inert.

The first synthetic pointer attempt exposed a WebKit `setPointerCapture`
`NotFoundError` under an interrupted synthetic stream. The pointer-capture path
was made defensive, the native build hot-reloaded, and the complete final
interaction was repeated with no product error in the final console interval.

## Android Emulator matrix

The app-created disposable Project was named `M7 Android 验收`. In a 412×915
CSS-pixel portrait viewport, the installed native shell verified:

1. Runtime state reported compact Mobile Shell on Android. Story Graph opened
   in the independent host, the ordinary paper became inert, and
   `document.body.scrollWidth === innerWidth === 412`.
2. Create relation mode became active. One real Android hardware Back event
   cleared relation mode while Story Graph remained open. A second hardware
   Back closed the host.
3. Close restored the same single Dashboard paper, active key, route, and
   scroll position with `lastSuperViewRestoreStatus=preserved`; the paper was
   interactive again.
4. The reopened Story Graph remained usable below its safe-area-aware three-row
   header. After the acceptance correction, all nine visible header controls
   measured 44px high and the canvas retained usable portrait space.
5. The compiled shell reported Google Drive transport and OAuth capabilities as
   present. No account/configuration lifecycle was attempted in M7.

The Android run is native-shell presentation and genuine system-Back evidence.
It does not claim native touch input, a physical two-finger gesture, or
populated-graph drag/relation completion.

## Console and build observations

- The final iOS console interval contained only expected Vite hot-reload debug
  messages after the pointer-capture correction; no product/runtime error
  remained.
- The final Android console interval contained only Vite hot-reload debug
  messages; no product/runtime error was recorded.
- Both native debug builds installed and launched successfully from existing
  caches; no runtime or SDK was downloaded.

## Deterministic and repository gates

The final source/docs state passed:

- focused M7 return-point, pinch, controller, Back, swipe, source, and design
  acceptance tests;
- complete Vitest suite;
- Agent capability evidence;
- `pnpm public:check`;
- `pnpm lint`;
- `pnpm typecheck`;
- `pnpm exec vite build`;
- `git diff --check`.

Exact suite counts and pre-existing warning counts are intentionally omitted
from this durable record; the commands are the reproducible authority and can
change as later milestones add tests.

## Storage and cleanup

- The exact iOS and Android debug app installations and their app-owned
  disposable data were removed after acceptance.
- The exact screenshots, console captures, and debug result directories were
  moved to macOS Trash after the durable observations above were recorded; they
  are not committed. The user's broader Trash was not emptied.
- The reused Simulator and Emulator were shut down. Their existing runtimes,
  AVD definition, system images, and reusable build caches remain.

## M7 conclusion and remaining boundary

M7 passes its Simulator/Emulator-specific gate: all three views are independent
full-screen mobile surfaces, switch within one header, block interaction with
the mounted paper, expose explicit touch-reachable relation and Library actions,
and restore the ordinary paper workspace exactly. Android system Back unwinds
relation mode before the host.

Real continuous finger drag, two-finger pinch, populated-node relation and drag
flows, VoiceOver/TalkBack, lifecycle/low-memory stress, representative large
Projects, M8 real-account Google Drive, signing, and M9 RC acceptance remain
open.
