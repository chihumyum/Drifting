# Mobile V2 platform and appearance foundation

Status: **M1 implementation and iOS Simulator acceptance complete**

Updated: 2026-08-23

This document records the implemented platform boundary that later Mobile V2
surfaces must consume. It is current implementation truth, not a claim that the
M2-M9 interaction work has shipped.

## Native capability and UI shell are separate

`PlatformRuntimeSnapshot` now owns two immutable axes resolved before React
mounts:

| Axis | Values | Authority |
| --- | --- | --- |
| Native target | `desktop`, `mobile`, `unknown` | Tauri capabilities |
| Device class | `desktop`, `compact`, `expanded` | target plus startup screen geometry |
| UI shell | `desktop`, `mobile` | pure device-class resolver |

`isMobile` continues to mean iOS/Android native capability ownership. It
controls native WebView behavior, safe areas, lifecycle, provider seams, and
other platform behavior. `isMobileShell` controls only presentation routing and
mobile layout rules.

An expanded iPad therefore has this valid combination:

```text
target=mobile
deviceClass=expanded
shellMode=desktop
isMobile=true
desktopWindowControls=false
```

It reuses the Desktop Shell information architecture without claiming macOS or
Windows window controls, desktop OAuth, desktop filesystem semantics, or any
other desktop-only capability.

## Device policy

- Native desktop targets always use `deviceClass=desktop` and Desktop Shell.
- A native mobile target whose shortest screen edge is below 1000 CSS px uses
  `deviceClass=compact` and Mobile Shell.
- A native mobile target whose shortest screen edge is at least 1000 CSS px
  uses `deviceClass=expanded` and Desktop Shell.
- Missing or invalid mobile geometry fails safe to compact Mobile Shell.
- The shortest edge is used so a stale landscape geometry cannot change the
  classification.
- Classification is performed once during platform hydration. Runtime resize
  and rotation cannot switch shells or remount Project authority.

The intended reference cases are a phone and iPad mini on Mobile Shell, and a
12.9/13-inch iPad on Desktop Shell. The threshold is a product boundary, not a
device-name allowlist or user-agent guess.

## Routing and CSS ownership

Auth, Project shelf, global settings, and Project workspace all select their
presentation from `isMobileShell`. Native safe-area/dynamic-viewport ownership
remains selected by `data-platform-target='mobile'`.

Mobile overlays, temporary drawers, modal sheets, search layout, settings
stacking, and Super View presentation select
`data-shell-mode='mobile'`. This prevents an expanded iPad from receiving a
mixture of Desktop Shell React routes and compact-phone CSS.

The root publishes `data-platform-target`, `data-native-platform`,
`data-device-class`, and `data-shell-mode` before React mounts.

## Portrait policy

- iPhone declares only `UIInterfaceOrientationPortrait`.
- iPad declares portrait and portrait-upside-down; no landscape orientation is
  supported.
- Android `MainActivity` declares `screenOrientation=portrait`.

Both Mobile Shell and expanded-tablet Desktop Shell are portrait-only in native
mobile builds. Desktop builds keep their existing resizable-window behavior.

## Theme bootstrap and semantic roles

Before session/platform hydration and before React mounts, the bootstrap reads
the persisted `light`, `dark`, or `system` preference, resolves the system
media query when needed, and applies all of the following to the document root:

- the existing `dark` class;
- `data-color-scheme`;
- native CSS `color-scheme`.

`AppearanceEffects` reuses the same application function for live preference
and system changes. Invalid or inaccessible persisted state fails safe to the
public light default.

Mobile V2 components use semantic roles such as `--mobile-v2-desk`,
`--mobile-v2-page`, `--mobile-v2-panel`, `--mobile-v2-bar`,
`--mobile-v2-search-current`, `--mobile-v2-agent-message`,
`--mobile-v2-drag-ghost`, and `--mobile-v2-backdrop`. They resolve through the
existing light/dark palette instead of assuming a fixed white surface.

## Deterministic evidence

- `src/renderer/platform/ui-shell-mode.test.ts`
- `src/renderer/lib/initial-theme.test.ts`
- `src/renderer/platform/mobile-ui-platform-foundation.acceptance.test.ts`
- `src/renderer/app/mobile-standalone-routes.acceptance.test.ts`

The machine checks cover threshold boundaries, landscape-shaped startup
geometry, invalid geometry, native-capability versus presentation routing,
safe-area versus shell CSS ownership, both native orientation manifests, and
pre-React theme restoration.

## Native evidence and remaining boundary

The dated
[`../qa/mobile-v2-m1-platform-simulator-2026-08-23.md`](../qa/mobile-v2-m1-platform-simulator-2026-08-23.md)
verifies this checkout on an existing phone, compact iPad, and expanded iPad,
including shell selection, portrait behavior, light/dark/follow-system root
appearance, and storage cleanup.

Android manifest behavior is machine-checked in M1; Android Emulator
interaction remains part of the Android-specific milestone matrix and does not
substitute for physical-device acceptance.
