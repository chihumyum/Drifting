# macOS app icon

The Dock uses the canonical `src/assets/icon.icon` design: a sand-filled
iceberg with a glass outline. Default has a warm white background and blue
artwork; Dark uses dark paper and lighter blue. The system derives Clear and
Tinted light/dark from the mono appearance. This change preserves the artwork
and its existing material settings; no app-side theme observer swaps bitmaps.

## Packaging contract

`src-tauri/tauri.macos.conf.json` adds a macOS-only `beforeBundleCommand`.
`scripts/compile-macos-icon.mjs` compiles the layered document with Xcode
`actool` into the ignored `out/macos-icon/Assets.car` before Tauri signs the
bundle. Both `pnpm tauri:build` and `pnpm exec tauri bundle` run the hook. A
compiler failure stops packaging and never reuses a previous catalog.

Tauri consumes that `.car` through `bundle.icon`, writes `CFBundleIconName`
from its asset name (`icon`), and ships it in `Contents/Resources/Assets.car`.
The checked-in `src/assets/icon.icns` remains byte-for-byte intact and supplies
`CFBundleIconFile` for older macOS. The app still supports macOS 13+.
Windows/Linux icons and the iOS Icon Composer integration are unaffected.

Build with Xcode 26 or later. The separate compilation also avoids the pinned
Tauri 2.11.4 `.icon` compilation path, which renames the document and hard-codes
a macOS 26 deployment target. Xcode 27's persistent `ibtoold` can fail with
`Bad file descriptor` in that path; see
[Tauri #16386](https://github.com/tauri-apps/tauri/issues/16386).
The compiler invocation sets `IBToolNeverDeque=YES` and closes stdin, avoiding
the pooled process without terminating other builds' shared daemons. This was
validated locally with Xcode 27.2. Revisit the workaround when upgrading Tauri.

Apple describes the layered icon and its Default/Dark/Mono appearance model in
[Creating your app icon using Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer)
and [Create icons with Icon Composer](https://developer.apple.com/videos/play/wwdc2025/361/).

## Acceptance

```sh
# Inspect a freshly built app; fails if the catalog or any appearance is absent.
node scripts/check-macos-icon.mjs --bundle path/to/Drifting.app
# Record native packaging evidence after changing icon sources or configuration.
node scripts/check-macos-icon.mjs --record path/to/Drifting.app
# Portable source-fingerprint and recorded-metadata check, also run in CI.
node scripts/check-macos-icon.mjs --check
```

The generated `docs/qa/macos-app-icon.json` records actual Tauri package
metadata and source hashes. The `tauri.conf.json` fingerprint leaves out the
release version, so bumping the version for a release does not need a new
recording. The checker requires matching `Info.plist` keys,
the original `.icns` bytes, a 1024px icon, both design groups in each
Default/Dark/Mono appearance, and the macOS 13 minimum. Release verification
also inspects the built app and the app mounted from the signed DMG, so a
missing asset catalog cannot silently ship as a static-only icon.

The recorded run packages an existing client executable, without launching the
app or accessing any library. Icon Composer exports of Default, Dark,
ClearLight, ClearDark, TintedLight and TintedDark are visual preview checks;
they do not prove live Dock switching. A release smoke check must still select
the system's light/dark/clear/tinted icon styles and inspect the Dock and
Finder. Testing an older macOS remains native release acceptance.

Installing a newly built app is required to update an already installed copy;
changing source files does not alter `/Applications/Drifting.app`.
