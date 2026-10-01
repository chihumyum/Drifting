# iOS Hosted integration

The 2026-10-01 scope is the existing Tauri iOS client and an iPhone Simulator.
The separate Apple-native migration stays paused. Android, physical-device IME,
distribution signing and guaranteed background execution are separate gates.

## Operator commands

Set `DRIFTING_HOSTED_ORIGIN` to the operator's exact HTTPS origin in the shell or
ignored `.env.local`. Explicit shell configuration wins over local settings.
Paths, credentials, query strings and wildcard origins are rejected.

```sh
pnpm mobile:ios:online
pnpm mobile:ios:device:debug -- --device <paired-device> --online
DRIFTING_HOSTED_LAB_INSTANCE=ios-test pnpm hosted:client ios dev <simulator-name> --no-watch
DRIFTING_HOSTED_LAB_INSTANCE=ios-test pnpm hosted:client ios build --debug --target aarch64-sim --archive-only
pnpm dev:worktree --online --instance ios-peer --no-watch
```

The ordinary mobile commands remain local by default. `--online` explicitly
overrides an old local-only flag and aligns renderer URL, compiled native origin
and CSP. The standalone device installer packages the renderer and does not need
Vite; its physical installation is not covered by the simulator gate.

Named Hosted labs have separate identities, libraries and Vite dependency caches.
Do not run two builds against one lab library. A service preflight waits up to
10 seconds so a remote HTTPS handshake is not mistaken for an unavailable local
server. If Tauri misidentifies a booted simulator as a physical device, use the
explicit `aarch64-sim` build and install its simulator `.app` with `simctl`.
Never change provisioning or reset an existing simulator to work around this.
Keep the simulator app's development signature and Keychain entitlements:
`--no-sign` archives can render the UI but failed Hosted session-token persistence
in this acceptance environment. Distribution signing is not required by this gate.

The simulator run exposed intermittent module-import failures after cold-starting
the Vite-served development renderer. Independent dependency caches prevent
cross-instance invalidation, but do not fully resolve this development-only gate.
Use the bundled simulator archive for cold-start acceptance. Do not reset SQLite
or re-register an account to repair development asset loading.

## Cross-client acceptance

[Generated evidence](acceptance/ios-desktop.json) records real native desktop and
iOS clients, independent SQLite/Yjs libraries and the configured VPS over HTTPS.
A new synthetic account is registered and verified using the service's ordinary
OTP endpoint. Acceptance mail uses the SMTP provider's delivery simulator; only
that account's OTP is read administratively. No personal manuscripts are fixtures.

Prepare the synthetic project `托管同步 iOS 验收 1001` and its `New Chapter` in an
isolated desktop client. Its initial prose is
`桌面首段：海风吹过码头，这是跨设备同步的合成测试稿。`.
Sign into the same account on iOS, connect, and open the restored chapter. The
collector requires authenticated loopback DOM-debug descriptors for each client.

The iOS acceptance build embeds a development renderer with private debug
instrumentation; its token and bundle remain ignored lab output. The collector
requires bundled asset URLs. Stop the iOS asset server before the final run so
the native app must load its embedded renderer. No release build enables this
instrumentation.

```sh
pnpm hosted:ios:acceptance --desktop-session <private-desktop-descriptor> --ios-session <private-ios-descriptor> --simulator <udid> --ios-bundle <isolated-lab-id>
pnpm hosted:ios:acceptance --check
```

The collector verifies initial restoration, edits in each direction, an actual
iOS process termination/relaunch, retained authentication/prose and catch-up of
desktop edits made while iOS was stopped. It records final text equality by hash.
The automatic receive path has a 30-second warm / 60-second idle foreground poll;
the collector allows that interval and HTTPS transfer time without pressing Sync now.
Inputs use the browser's contenteditable editing operation through ProseMirror;
it does not write SQLite, call business mutations or seed a replacement Y.Doc.
Foreground wake is a synthetic DOM focus event. This is simulator/network/storage
acceptance, not physical touch or Chinese IME acceptance. Background execution and
an actual network outage are not claimed. Debug descriptors, accounts, passwords,
raw logs, simulator identifiers and screenshots stay in ignored local output.

The source-default release build still excludes the frontend debug bridge. The
ordinary HTTP/SQLite integration report remains a separate regression gate:
`pnpm hosted:acceptance` and `pnpm hosted:acceptance --check`.

The 2026-10-01 run passed all five native cross-client cases and 89 HTTP/SQLite
cases. The simulator used a signed archive with its renderer embedded; the asset
server was stopped. A separate ordinary archive built without debug instrumentation.
Launcher coverage passed 49 cases. The final full regression passed 467 files /
3,326 tests (2 files / 4 tests skipped), using four workers after the initial
parallel build run exceeded two timing gates. Typecheck, CI contract, public
boundaries and Agent capability checks passed; lint had no errors and 70 warnings.
