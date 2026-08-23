# Mobile V2 M1 platform iOS Simulator acceptance — 2026-08-23

Status: **M1 iOS Simulator acceptance passed; physical-device and Android interaction remain open**

## Checkout and build boundary

- Baseline HEAD: `60df1bab98bbafea693a476cca7778956832cb16`
- Source under test: that HEAD plus the current M0 and M1 working-tree change
- Build: local-only iOS debug
- Native build result: `BUILD SUCCEEDED`
- Renderer input evidence: developer-only iOS renderer bridge, explicitly
  reporting `inputPath=synthetic-dom` and `nativeInput=false`
- Native rotation evidence: visible Simulator toolbar operation through
  Computer Use

This is checkout-specific development evidence. It is not a signed artifact,
physical-device acceptance, Android acceptance, or release approval.

## Reused device matrix

No device or runtime was created for this run. One incrementally built app was
installed sequentially on three already-existing iOS 26.1 Simulators.

| Existing Simulator | Observed viewport | Native target | Device class | Shell | Visible presentation |
| --- | ---: | --- | --- | --- | --- |
| iPhone 16e | 390 x 763 CSS px | mobile | compact | mobile | mobile local-first shelf |
| iPad mini (A17 Pro) | 744 x 1076 CSS px | mobile | compact | mobile | mobile local-first shelf |
| iPad Pro 13-inch (M5) | 1032 x 1319 CSS px | mobile | expanded | desktop | desktop Project shelf |

Every runtime retained `isMobile=true`. The expanded iPad additionally reported
`isMobileShell=false`, `isExpandedTablet=true`, and
`desktopWindowControls=false`. It therefore reused Desktop Shell presentation
without claiming a desktop native capability.

The iPad mini stayed below the 1000 CSS-pixel threshold. The 13-inch iPad's
actual WebView width was 1032 CSS px and crossed it without a model-name or
user-agent allowlist.

## Observed paths

1. The iPhone launched in portrait, rendered the local-first Public Alpha
   disclosure within safe areas, and reached the mobile shelf after the
   explicit local-mode action.
2. The iPad mini rendered the same mobile-owned shelf at 744 CSS px. Its modal
   and shelf used mobile presentation rules rather than desktop routes.
3. The iPad Pro rendered the desktop Project shelf and desktop modal geometry.
   The DOM contained the desktop shelf and no `pp--mobile` shelf.
4. The iPhone and iPad Pro were rotated from the visible Simulator toolbar.
   The Simulator device frame rotated, but the application retained its
   portrait coordinate space instead of reflowing to a landscape shell. After
   restoring portrait, the same shelf and shell classification remained.
5. The built application's processed `Info.plist` contained only portrait for
   iPhone and portrait plus portrait-upside-down for iPad; it contained no
   landscape declaration.

## Appearance acceptance

The clean iPhone started with `data-color-scheme=light`. The following paths
then passed in the running native WebView:

- a persisted explicit dark preference survived reload, set the root `dark`
  class and CSS `color-scheme=dark`, and produced a dark shelf with readable
  foreground and controls;
- persisted `system` mode resolved dark while the Simulator system appearance
  was dark;
- changing the Simulator system appearance to light updated the mounted app to
  light without a reload through the existing media-query listener.

The renderer bootstrap applied the resolved scheme before React mounted. The
visible dark screenshot and root computed background confirmed that the result
was not only a settings-store value.

## Storage handling

- No Simulator device, iOS runtime, or duplicate DerivedData tree was created.
- The same built `.app` and the same existing DerivedData directory were reused
  for all three devices.
- Repository Rust targets were approximately 41 GiB before and after the run;
  the single DerivedData directory was approximately 1.4 GiB before and after.
- Reported free disk space was approximately 28 GiB before the build and 36 GiB
  after cleanup. APFS/purgeable-space reporting can fluctuate, so this is not a
  claim that the run itself recovered 8 GiB.
- The task-created screenshots and current frontend-debug run directory were
  deleted after inspection. An older unrelated debug run was preserved.
- Drifting was uninstalled from all three test devices and all three were shut
  down. No existing Project container or migration-recovery data was modified.

## M1 conclusion and remaining boundary

M1 passes its iOS Simulator gate: native capability and presentation shell are
separate, phone/compact-tablet and expanded-tablet routing are visible, mobile
builds do not expose a landscape layout, and light/dark/follow-system root
appearance works.

Android portrait is machine-checked from the generated manifest in M1 but was
not run in an Emulator to avoid creating or downloading an Android device or
runtime. Physical iOS/Android touch, IME, lifecycle, accessibility, secure
storage, and real Google account behavior remain release gates in later
milestones.
