# Animated desktop tab reordering

The Tauri top strip previews the destination while dragging. The native tab
image follows the pointer; neighbouring slots slide out of its way over 160 ms.
On release, the tab settles into its destination. A cancelled drag restores the
original order. This does not add window detaching or change tab activation.

`TopTimeline/tab-reorder.ts` owns temporary DOM transforms, native drag events
and edge scrolling. It measures untransformed slot widths once per gesture;
animated neighbours do not become moving hit targets. A leading edge crossing
half the next slot moves the preview, including a wide split passing a narrow
tab. Both `dragenter` and `dragover` accept the gesture, so fast movement across
label/icon/close descendants still permits dropping.

The UI store is unchanged during preview and receives one reorder on a changed
drop. The store's active tab remains unchanged. Ordinary and split tabs can
move; Create stays last and cannot start a drag. Native
`application/x-drifting-tab` data continues to the editor's split-drop handler.
The strip scrolls near its left/right edge while the pointer remains inside.
Escape, outside drop, window blur, tab/width changes and unmount cancel the
pending reorder. Reduced-motion preference keeps the preview but removes the
slide/settle animation. No new library or persisted state is introduced.

## Native drag delivery

The main window sets `dragDropEnabled: false` in **both** `tauri.conf.json` and
`tauri.macos.conf.json`; the macOS override replaces the base windows array.
The isolated development launcher inherits this setting. This disables Tauri's
native file-drop handler, leaving HTML drag/drop available to tabs and the
editor. There are no app consumers of Tauri's native file-drop events.

The original browser-only checks missed this boundary. With the default
enabled setting, the locked `tauri-runtime-wry 2.11.4` handler unconditionally
returns `true`. `wry 0.55.1` on macOS then returns `NSDragOperation::Copy` and
consumes enter/update/drop instead of forwarding them to `WKWebView`. This
explains a native drag image with a green copy badge while frontend reorder
does not receive the destination events. The current Tauri window-drag script
already excludes `role="tab"` from the titlebar's `deep` drag region.

This native setting is built into the executable: **HMR or reopening an old
executable is insufficient**. Stop and restart the development command and
allow Tauri to rebuild; packaged versions need a rebuilt package. The source
and configuration checks establish this delivery fix; physical Tauri dragging
remains a separate acceptance gate below.

## Reproducible evidence

```sh
pnpm exec vitest run src/renderer/components/topBars/TopTimeline
pnpm exec vitest run src/renderer/platform/worktree-dev-launcher.acceptance.test.ts
node scripts/run-tab-reorder-acceptance.mjs
node scripts/run-tab-reorder-acceptance.mjs --check
```

`acceptance/tab-reorder.json` is generated from the production React component
and real UI store in Chromium with synthetic workspace data and drag events.
Each of the ordinary/reduced-motion profiles checks 24 behaviors: unequal
widths, payload, preview before commit, animation policy, single commit,
cleanup, active-tab preservation, reverse/cancel, wide split, fast entry,
Escape, outside drop, Create/close guards, stationary-pointer scrolling,
layout invalidation, blur and unmount. The checker verifies its source hash and
the explicit native-drop setting in both main-window configurations.
This focused report is the current drag-animation evidence; the older F2
presentation report retains its historical baseline comparison.

For mouse inspection, start `pnpm dev:worktree --no-watch` and open
`/scripts/renderer-tab-reorder.html?manual` at its isolated frontend origin.
The page mounts synthetic A/B/C tabs plus a D/E split and records drag start,
drop and end beside the resulting order. Forward and reverse mouse drags were
verified in the in-app browser on 2026-10-05. This is browser acceptance, not
physical Tauri/WKWebView acceptance. The isolated Tauri debug executable was
rebuilt and launched, but the desktop automation service could not resolve its
application identifier, so physical desktop acceptance remains unverified.
