# Mobile V2 single-handle and shared-Stats repair — iOS Simulator acceptance — 2026-08-24

Status: **iOS Simulator acceptance passed**

## Checkout and evidence boundary

- Baseline commit: `d10f5617d80d2246dbca91dc23772ff439e32b40`.
- Source under test: that baseline plus this single-handle/shared-Stats repair.
- The existing iPhone 16e / iOS 26.1 Simulator and native build caches will be
  reused; no runtime or device will be created.
- Renderer inspection and deterministic drags use the DEV-only bridge labelled
  `inputPath=synthetic-dom` and `nativeInput=false`.

This record does not claim native multi-touch or physical-device continuous
touch. The unfinished M8 Google Drive work in the checkout is outside this
repair and its commit scope.

## Required visible matrix

1. Pulling the bottom entry hides the floating accessory for the live drag;
   only the bottom panel boundary handle moves. On release the accessory
   returns above the settled panel without its own second handle.
2. Pulling the top entry replaces it with the structure panel boundary handle;
   the original safe-top entry is no longer visible or interactive.
3. A full bottom panel hides the safe-top entry and the floating accessory. A
   full top panel likewise hides competing bottom chrome. Each full surface
   exposes only its own closing boundary handle.
4. A slow release above 50% preserves that exact partial height. Full screen
   requires the physical edge or a deliberate opening fling with meaningful
   travel. A deliberate closing fling or the closed edge collapses the panel.
5. Tapping the current entity opens a draggable Stats Sheet using the shared
   `EntityStatsContent`. Pulling the Sheet grabber downward closes it. Stats is
   absent from the bottom tool rail.

## Deterministic checks

- Reused device: iPhone 16e / iOS 26.1,
  `7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`. The native iOS target built,
  installed, and launched successfully; the renderer bridge reported
  `connected=true`.
- Bottom panel ordinary release: a slow 260 px upward drag settled at
  `0.6407601572739188` and remained `bottom-docked`; crossing 50% did not
  promote it to full screen.
- Bottom panel fling: a fast 180 px opening drag produced `bottom-full` with
  extent `1`. The floating accessory and safe-top entry were hidden and
  non-interactive; only the visible bottom boundary handle accepted input.
- Top panel replacement: after a slow pull, the panel settled at
  `0.28833551769331583`. The safe-top entry and bottom accessory entry handle
  were hidden and non-interactive; only the structure-panel boundary handle
  accepted input.
- Top panel fling: a fast 180 px opening drag produced `top-full` with extent
  `1`. The bottom accessory was hidden and the hidden bottom panel boundary
  had `visibility=hidden` and `pointer-events=none`; the visible top boundary
  was the only handle owner.
- Current-entity action: tapping `mobile-open-paper-stats` set the transient to
  `paper-stats` and rendered the shared `EntityStatsContent` inside the
  draggable Sheet. The bottom tool rail contained no Stats tab.
- Stats dismissal: a 150 px downward drag on
  `.m-paper-stats-sheet__grab` removed the Sheet and returned the transient to
  `none`.
- Device screenshots were visually inspected for settled partial panels, both
  full-panel directions, and the Stats Sheet. Temporary screenshots are not
  retained as repository artifacts.

## Isolated repository gates

The staged repair was applied to a detached worktree at the baseline commit so
the unfinished M8 checkout did not affect these results:

- focused mobile repair suite: 6 files / 32 tests passed;
- `pnpm public:check`: passed for 1500 publish candidates;
- `pnpm lint`: passed with 0 errors and 41 existing warnings;
- `pnpm typecheck`: passed;
- `pnpm test`: 316 files passed, 1 skipped; 1826 tests passed, 1 skipped;
- `pnpm agent:capabilities:check`: capability evidence current and 18 tests
  passed;
- `pnpm exec vite build`: 3684 modules transformed and production build
  completed.

## Storage and cleanup

The disposable app data/debug artifacts are removed after the final gates;
existing native caches are retained.

## Remaining boundary

The physical-device continuous touch remains open, including fling calibration,
gesture interruption, accessibility, safe-area ergonomics, lifecycle, and
memory pressure.
