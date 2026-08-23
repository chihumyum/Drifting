# Mobile V2 M2 workspace Back Simulator acceptance — 2026-08-23

Status: **M2 iOS Simulator and Android Emulator acceptance passed; physical-device acceptance remains open**

## Checkout and implementation boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that HEAD plus the current uncommitted M0-M2 working-tree
  change
- iOS build: local-only debug, `BUILD SUCCEEDED`
- Android build: local-only debug, installed on the existing API 35 AVD
- Deterministic focused result: 5 test files, 38 tests passed

This is checkout-specific development evidence. It is not a signed artifact,
physical-device acceptance, real-project acceptance, Google-account
acceptance, or release approval.

## Reused device matrix

No Simulator, Emulator, iOS runtime, Android system image, or duplicate Xcode
DerivedData tree was created.

| Existing device | Native evidence used | Renderer evidence used |
| --- | --- | --- |
| iPhone 16e, iOS 26.1 | visible Simulator interaction through Computer Use | iOS renderer bridge, `inputPath=synthetic-dom`, `nativeInput=false` |
| `Persimmon_API_35`, Android API 35 arm64 | `adb shell input keyevent KEYCODE_BACK` | Android CDP, `inputPath=cdp-webview`, `nativeInput=false` |

The synthetic project contained only generated names and one generated
storyline. No personal Project, prose, account, credential, or provider state
was used.

## Android hardware Back matrix

The installed app initially exposed one native capability defect:
`app.registerListener not allowed`. Adding only
`core:app:allow-register-listener` and
`core:app:allow-remove-listener` to the mobile capability enabled Tauri's
existing App-plugin Back event. No `MainActivity` override or WebView-history
fallback was added.

After the fix, real native `KEYCODE_BACK` events produced these one-step
transitions:

| Before | One hardware Back | Recheck |
| --- | --- | --- |
| bottom full panel | bottom docked panel | stayed docked after two seconds; no duplicate callback |
| bottom docked panel | read paper | stayed in the Project |
| entity preview above top docked panel | top docked panel | preview alone closed |
| top docked panel | read paper | active paper/session remained valid |
| Overview | read paper | Overview alone closed |
| Story Graph Super View | read paper | paper session remained unchanged |
| read root | Project shelf | Project-root effect fired only for hardware Back |

React StrictMode had briefly made duplicate listener registration a plausible
risk. A module-singleton, reference-counted native registration was installed,
and the delayed full-to-docked recheck plus the next Back confirmed one layer
per hardware event.

## iPhone visible and controller paths

The iPhone was booted explicitly before the incremental build after the first
deployment attempt found the existing device shut down. The second build
succeeded and installed on that same iPhone.

Visible Simulator clicks performed through Computer Use verified:

1. Public Alpha disclosure to local mode, synthetic Project creation, and the
   read-paper root.
2. Overview's visible header Back returned to the read paper.
3. The Overview Story Graph card opened a separate full-screen Super View;
   the Super View's visible header Back restored the same paper session.
4. A generated storyline opened as a paper. Its top structure panel opened,
   an entity preview sheet opened above it, and the sheet's visible close
   control removed only the preview while preserving the top docked panel.

The iOS renderer bridge then supplied two explicitly synthetic checks:

- synthetic Escape changed `top-docked` to `none` without changing the active
  paper;
- executing the checked-in resolver in the running iOS renderer changed
  `search + keyboard open` to layer `input`, transient `none`, keyboard
  `closed`, and no external effect.

M4 owns the production mobile Search UI. This M2 run verifies the Search state
and Back contract only; it does not claim a visible Search workflow has
shipped.

No renderer error event was observed after the completed iOS matrix. The iOS
26.1 Simulator emitted its existing duplicate UIKit/WebKit accessibility and
keyboard-class runtime warnings; they were not renderer Back failures.

## Current V1 geometry discovered during acceptance

The current Android V1 paper cluster is positioned in the lower system gesture
region. A coordinate intended for the cluster was consumed as system Back.
Synthetic WebView pinch was therefore used only to arrange Overview/panel
preconditions; it was not reported as a native touch success. M3 removes this
pinch/cluster chrome and replaces it with the stable unified bar and vertical
rails, so this is a known cutover input rather than an M2 controller regression.

## Repository gates

The checkout passed all repository-required completion commands after native
cleanup:

- `pnpm public:check` — 1,453 tracked and untracked publish candidates passed;
- `pnpm lint` — exited successfully with zero errors and 39 existing warnings;
- `pnpm typecheck` — passed;
- `pnpm test` — 299 files passed, 1 skipped; 1,753 tests passed, 1 skipped;
- `pnpm agent:capabilities:check` — generated evidence current and 18 focused
  capability tests passed;
- `git diff --check` — passed.

## Storage and cleanup

- Free disk space was approximately 35 GiB before and after the final iOS run.
- The existing repository Rust target was approximately 42 GiB, the reused
  Apple generated build approximately 2.0 GiB, and the Android app build
  approximately 6.7 GiB after the Android debug build.
- The Android generated build grew from approximately 3.7 GiB to 6.7 GiB while
  producing arm64 and universal debug intermediates. It was retained as a
  reusable build cache for later mobile milestones rather than forcing the
  next Emulator run to regenerate the same large native libraries.
- All five task-created frontend-debug run directories and temporary M2
  screenshots were deleted. One older unrelated debug run was preserved.
- Drifting was uninstalled from the iPhone and Android AVD. Both devices were
  shut down. No existing device or shared runtime was deleted.

## M2 conclusion and remaining boundary

M2 passes its staged gate. One reducer owns the five workspace axes; visible,
keyboard, Super View, and Android native Back inputs converge on one request;
each request removes exactly one owned layer; Overview and Super Views do not
enter the paper session.

The M3 bar/rail/paper cutover, M4 visible Search and IME paths, physical-device
touch, Android predictive-Back presentation, accessibility, lifecycle, and
release builds remain open.
