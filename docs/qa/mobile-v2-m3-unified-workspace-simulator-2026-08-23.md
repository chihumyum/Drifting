# Mobile V2 M3 unified workspace iOS Simulator acceptance — 2026-08-23

Status: **M3 iOS Simulator acceptance passed; physical-device and Android presentation acceptance remain open**

## Checkout and implementation boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that HEAD plus the current uncommitted M0-M3 working-tree
  change
- Build: local-only iOS debug, arm64 Simulator archive and development build
- Native result: Xcode `BUILD SUCCEEDED`
- Visible input: Simulator UI through Computer Use
- Renderer input: developer-only iOS bridge, explicitly reporting
  `inputPath=synthetic-dom` and `nativeInput=false`

This is checkout-specific development evidence. It is not a signed artifact,
physical-device touch acceptance, Android presentation acceptance, real
Project acceptance, Google-account acceptance, or release approval.

## Reused device and fixture

The run reused the already-installed iOS 26.1 runtime and the existing
`iPhone 16e` Simulator, UDID
`7EC4E9EA-07BF-4BDE-A1BB-672BF8F7A0EA`. No Simulator, runtime, or duplicate
DerivedData tree was created.

One disposable local-only Simulator Project named `M3 Synthetic Project` was
inserted into the stopped app's Simulator library after first taking a SQLite
backup. It contained no chapters or prose. The project ID, names, and paper
session were synthetic; no user Project, account, credential, Drive state, or
private text was used. The fixture and backup were removed during cleanup.

## Visible Simulator matrix

On the 390 x 763 CSS-pixel viewport, visible Simulator interaction verified:

1. The read paper had one bottom unified bar spanning the full viewport. Its
   56px control row plus the 34px bottom safe area produced a 90px visible
   footer; there was no paper cluster, pinch affordance, or floating rail
   button.
2. The structure action opened a docked top panel. The run exposed an erroneous
   Project/Dashboard rail item alongside Chapters, Elements, and Inspiration.
   The M4 contract audit removed that item so the current 56px rail contains
   only Chapters, Elements, and Inspiration; the correction is machine-tested
   and awaits the M4 native rerun. The paper retained 1:1 width and height and
   was cropped from the top instead of scaled.
3. Repeating the structure action promoted the same panel to full height and
   made the then-visible rail destinations reachable. A third activation closed it and
   restored the full paper.
4. The tool action opened a docked bottom panel and moved the unified bar to
   the panel boundary. Its 56px left rail exposed Planning, Agent, Library, and
   Stats; Planning exposed Timeline/Plot as internal choices rather than a
   second workspace rail.
5. Repeating the tool action promoted the panel to full height, where all four
   tool destinations remained reachable. A third activation closed it.
6. The unified-bar paper identity opened the separate Overview surface. From
   Overview, All Chapters was inserted as a second ordinary paper and the bar
   count became two. Overview itself did not enter the paper list.

These observations verify only the visible paths listed above. Dense Timeline,
Plot Grid, Agent, Library, Stats, editor accessory, comments, and real content
were not accepted by this synthetic empty Project and remain later milestones.

## Paper swipe and controller evidence

The running iOS debug bridge reported two ordered papers:
`dashboard:self` and `all-chapters:self`. A horizontal drag on
`mobile-paper-row` performed these settled transitions:

| Input | Before | After | URL result |
| --- | --- | --- | --- |
| `deltaX=+220`, 240ms | `all-chapters:self` | `dashboard:self` | `/home` |
| `deltaX=-220`, 240ms | `dashboard:self` | `all-chapters:self` | `/editor/all` |

After both gestures, `paperSwipePhase=idle`, the paper count/order was
unchanged, and the active controller/session key matched the URL. The DOM
contained one active `m-paper-deck__content`; the neighbor remained a static
paper snapshot.

The same +220px drag beginning on the visible `回到首页` button did not switch
papers: `all-chapters:self`, `/editor/all`, and `paperSwipePhase=idle` remained
unchanged. This proves the production event path's interactive-target
exclusion in the running WebView. It remains synthetic DOM input, not a claim
about physical-finger continuity.

The macOS host's ordinary Simulator drag merged the WKWebView pointer sequence
and did not switch papers. That failed host-mouse attempt was not reported as
touch evidence; the bridge result is labelled with its lower input fidelity.

## Reduced-motion evidence

The Simulator's existing `com.apple.Accessibility` Reduce Motion preference
started at `0`. It was temporarily set to `1`, the app was relaunched, and the
running WKWebView reported:

- `matchMedia('(prefers-reduced-motion: reduce)').matches === true`;
- unified-bar transition duration `0.00001s` instead of
  `0.22s, 0.14s, 0.22s`;
- the deterministic swipe code selected immediate `auto` settlement.

The preference was restored to `0` after the check.

## Repository gates

M3 completion runs the repository-required gates after documentation and
cleanup. The final checkout passed:

- `pnpm public:check` — 1,462 tracked and untracked publish candidates passed;
- `pnpm lint` — exited successfully with zero errors and 39 existing warnings;
- `pnpm typecheck` — passed;
- `pnpm test` — 300 files passed, 1 skipped; 1,756 tests passed, 1 skipped;
- `pnpm agent:capabilities:check` — generated evidence current and 18 focused
  capability tests passed;
- `git diff --check` — passed.

The final focused M3 set passed 6 files and 31 tests. The renderer production
build also passed before native acceptance with existing chunk-size warnings.

## Storage and cleanup

- Free disk space remained approximately 32 GiB during the debug acceptance
  and returned to approximately 34-36 GiB after cleanup.
- The existing repository Rust target remained approximately 42 GiB, Apple
  generated build approximately 2.0 GiB, and Android app build approximately
  6.7 GiB. They were retained as reusable milestone caches.
- The task-created debug run, disposable Simulator app/data, and SQLite backup
  were removed. Drifting was uninstalled and the reused iPhone was shut down.
  One older unrelated debug run was preserved.
- No existing device, runtime, Android system image, shared Rust target, or
  generated native build cache is deleted.

## M3 conclusion and remaining boundary

M3 passes its Simulator-specific interaction gate: the old pinch/cluster
workspace is gone; one controlled bar and two one-level vertical rails own the
visible workspace; panels crop rather than scale paper; Overview remains
independent; and read-paper swipe settles through the canonical session and
URL path with explicit nested-interaction exclusions and reduced-motion
behavior.

M4-M9, Android visible presentation, physical iOS/Android touch, native IME,
selection, accessibility, lifecycle, low-memory behavior, signed builds, and
real Google Drive acceptance remain open.
