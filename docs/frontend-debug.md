# Mobile frontend Debug V1

This developer-only surface lets coding agents observe, operate, and collect
evidence from Drifting's mobile WebView without adding a second product or
business-data path. Android Emulator uses Chrome DevTools Protocol (CDP).
iOS Simulator uses a renderer-owned debug bridge because WKWebView does not
expose CDP. The command names are shared, but every result declares its real
transport and input fidelity.

V1 supports emulators and simulators only. It deliberately rejects Android
physical devices and only accepts simulator identifiers returned by `simctl`.
It never reads or writes SQLite, Yjs, CRUD resources, secure storage, or
product use cases.

## Start a debug build

Launch the one-command debug entry point from the repository root. The public
build defaults to local-only mode, so no hosted service is required:

```bash
pnpm mobile:ios:debug -- --device <simulator-udid>
pnpm mobile:android:debug -- --device <emulator-serial>
```

To debug an explicitly online build, configure a compatible service as
described in [`official-service.md`](official-service.md) before launching the
same commands.

The wrapper starts the loopback daemon on `127.0.0.1:4318`, creates an
ephemeral token, injects the explicit renderer Debug variables into the Tauri
dev build, and then delegates to the ordinary mobile development script. The
session descriptor is written with owner-only permissions to:

```text
.local-data/frontend-debug/session.json
```

Evidence is isolated under `.local-data/frontend-debug/<runId>/`. Stopping the
wrapper stops the daemon and removes the active session descriptor.

For separate terminals, run `pnpm drifting frontend serve --platform ios` or
`--platform android`, then launch the mobile dev process with the
`rendererEnv` values returned in the JSON envelope.

## Commands

```bash
pnpm drifting frontend status
pnpm drifting frontend snapshot
pnpm drifting frontend query --input '{"locator":{"kind":"debug-id","value":"mobile-workspace"}}'
pnpm drifting frontend wait --input '{"locator":{"kind":"role","role":"button","name":"纸张"},"state":"visible"}'
pnpm drifting frontend style --input '{"locator":{"kind":"css","value":".m-workspace"},"properties":["pointer-events","transform"]}'
pnpm drifting frontend hit-test --x 195 --y 780
pnpm drifting frontend tap --input '{"locator":{"kind":"debug-id","value":"mobile-open-overview"}}'
pnpm drifting frontend type --input '{"locator":{"kind":"role","role":"textbox"},"text":"test","replace":true}'
pnpm drifting frontend scroll --delta-y 400 --x 195 --y 420
pnpm drifting frontend drag --input '{"locator":{"kind":"debug-id","value":"mobile-paper-row"},"deltaX":-220,"deltaY":0,"durationMs":240}'
pnpm drifting frontend pinch --x 195 --y 300 --start-distance 180 --end-distance 80
pnpm drifting frontend evaluate --expression 'document.readyState'
pnpm drifting frontend console
pnpm drifting frontend network
pnpm drifting frontend screenshot
pnpm drifting frontend bundle
pnpm drifting frontend capabilities
```

`css`, `debug-id`, `role` with optional accessible name, and bounded leaf
`text` are the stable locator variants. Query results include geometry,
visibility, enabled state, selected computed styles, scroll metrics, and the
center-point hit stack. `console` and `network` also accept `--stream` and emit
NDJSON until interrupted.

All ordinary responses remain inside the developer CLI `CliEnvelope`. The
frontend payload adds `schemaVersion`, `runId`, `sessionId`, `transport`, and
an exact capability record. Android reports `inputPath: "cdp-webview"` and
full CDP network events. iOS reports `inputPath: "synthetic-dom"` and only
`PerformanceResourceTiming` summaries. Neither transport claims native input.

## Renderer state and safety

An explicitly opted-in Debug renderer installs the read-only
`window.__DRIFTING_FRONTEND_DEBUG_V1__` registry. It exposes runtime, route,
viewport, focus/selection, project boot, open/active papers, frozen-paper
flags, overview/Super View, controller state, unified-bar projection, panel
reveal/extent, paper-swipe phase, editing state, and active rail. It provides
no business-state mutation method. Interaction must still target visible DOM.

Normal production builds do not install the registry or connect to port 4318.
The daemon binds loopback only and requires its random bearer token. Password,
Cookie, Authorization, BYOK/API key and token fields are redacted; prose-shaped
state is omitted. Response bodies are not captured. Text and event buffers are
bounded and expose truncation markers. Evidence manifests replace the token
with `[REDACTED]` and record checkout SHA/dirty state, platform, target,
capabilities, transcript, logs, network summaries, and screenshots.

`evaluate` is intentionally powerful, but remains limited to the authenticated
local Debug session. It must not be enabled in a release build.

## CRUD integration contract

Frontend Debug does not call the CRUD CLI. A later scenario orchestrator may
use CRUD to prepare deterministic data, launch the App, operate the UI here,
and use CRUD again to verify persistence. The layers exchange only
`schemaVersion`, `requestId`, `runId`, `projectId`, resource handles, and
artifact paths. Canonical prose and business mutations remain owned by the
existing Yjs/product use cases.

## Acceptance boundary

This tool can prove WebView DOM state, renderer state, WebView input dispatch,
console/network evidence, and Simulator device pixels. It cannot prove the
native keyboard accessory, safe-area/Home-indicator ergonomics, system
dialogs, background lifecycle, native accessibility, physical-device behavior,
or real multi-touch fidelity. Those remain Simulator/XCUITest/manual acceptance
items in [`mobile-device-acceptance.md`](mobile-device-acceptance.md).

Run the machine checks with:

```bash
pnpm frontend:debug:check
```

## Recorded simulator smoke

On 2026-08-13, the iOS transport was exercised against the booted `iPhone 17
Pro` Simulator (`iOS 26.1`, UDID
`98116A26-F080-4363-AA6B-57F6C7010A9B`). The run attached at
`tauri://localhost` and completed `status`, `snapshot`, `query`, `wait`,
`style`, `hit-test`, `tap`, `type`, `scroll`, `drag`, `pinch`, `evaluate`,
`console`, `network`, `screenshot`, and `bundle`. Every input response declared
`inputPath: "synthetic-dom"`; the device screenshot and manifest were emitted
under the run-scoped evidence directory. A renderer reload re-established the
bridge, and the resource buffer excluded the bridge's own `/renderer/*` and
`/stream` traffic without truncation.

Android parser, forwarding, CDP reconnection, fake-CDP integration, and input
contracts are machine-tested. A real Android CDP smoke was not recorded in
this checkout because no Android Emulator was connected; the only attached
Android target was a physical device and was correctly rejected by the V1
emulator-only gate. This is an explicit remaining acceptance item, not an
inference from the iOS run.
