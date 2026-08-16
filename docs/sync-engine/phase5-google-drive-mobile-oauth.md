# Phase 5 Google Drive mobile OAuth

Status: official iOS and Android clients are implemented and machine-built;
real-account and physical-device acceptance remain open.

This milestone keeps the renderer contract unchanged:
`platform.googleDrive.connectAccount`, `reauthorizeAccount` and
`revokeAccount` still exchange only an opaque native credential ref and a
Google account subject. Mobile OAuth is a native Tauri plugin; no bearer token,
refresh token, authorization code, SDK session, or email enters renderer IPC.

## Platform clients

- iOS uses `GoogleSignIn` 9.2.0. Interactive authorization is presented by the
  SDK, `GIDGoogleUser.userID` is the account subject, and
  `refreshTokensIfNeeded` supplies a fresh token immediately before a Drive
  request. `GIDSignIn.disconnect` is the revoke operation.
- Android uses `play-services-auth` 21.6.0 and
  `Identity.getAuthorizationClient`. It requests an
  `AuthorizationRequest` for `drive.appdata`, completes any required
  `PendingIntent` through Tauri's Activity Result bridge, reads the subject
  from `AuthorizationResult.toGoogleSignInAccount().id`, and uses
  `RevokeAccessRequest` for the same account and scope.
- The only Google data scope requested by either mobile adapter is
  `https://www.googleapis.com/auth/drive.appdata`. Google Sign-In's intrinsic
  identity state is not widened into Drive, Drive File, profile, email, or any
  other application data scope.

Drifting's mobile secure-storage record contains only
`{ platform, clientId }`, the SDK account subject, and the App-wide
`provisional | claimed` ownership state. The Google SDK owns its account/token
lifecycle. An access token crosses only the private Swift/Kotlin-to-Rust plugin
bridge, is consumed for the immediate native request, and is never persisted by
Drifting. The Rust response is zeroized on drop and is not debug-printable.

Connect reuses the singleton record after a crash. Reauthorization passes the
existing subject as a hint and replaces the record only after an exact subject
match. Revoke removes the record only after the SDK reports success. Missing
SDK account state is treated as `needs-reauth`, not as proof of remote
revocation, so cancellation, account mismatch, SDK failure, or lost SDK state
preserves ownership.

## Configuration and callback boundary

Release builds provide three separate OAuth clients from one Google Cloud
project:

- `DRIFTING_GOOGLE_DESKTOP_CLIENT_ID`
- `DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET`
- `DRIFTING_GOOGLE_IOS_CLIENT_ID` plus its exact
  `DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID`
- `DRIFTING_GOOGLE_ANDROID_CLIENT_ID`

The checked-in values are empty. A missing/malformed client, an iOS reversed
scheme that is not the exact reversal of its client ID, or an unavailable
native plugin makes `googleDriveOAuth=false` and operations fail with
`configuration-required`. Android's OAuth client must additionally be bound in
Google Cloud to `cc.drifting.client` and each release signing certificate.

`pnpm mobile:ios:dev` and `pnpm mobile:android:dev` load the ignored root
`.env.local` before spawning Tauri; an explicit shell or CI value wins. The iOS
launcher validates the exact reversed pair and writes an ignored, mode `0600`
`GoogleOAuth.local.xcconfig`, which the checked-in empty-default xcconfig
optionally includes. Android inherits the merged environment through Gradle to
Cargo. Launcher diagnostics expose only a configured/missing boolean and never
the values. Missing or invalid material remains empty/invalid all the way to
the native capability check and cannot enable OAuth.

The iOS project expands the client and reversed scheme from
`GoogleOAuth.xcconfig`; `tauri.ios.conf.json` preserves that private callback
scheme when Tauri regenerates mobile deep-link configuration. Google callback
URLs are consumed by `GIDSignIn.handle` before the ordinary renderer deep-link
queue. A callback with another Google client scheme is swallowed and rejected
natively rather than exposed to JavaScript. Android uses the SDK
`PendingIntent` result and has no custom URL or WebView flow.

GoogleSignIn's AppAuth iOS presentation entry points are Objective-C categories
inside a static package. Tauri combines mobile plugin archives, so a global
`-ObjC` flag would also force-load duplicate Swift support objects. The iOS app
target therefore owns a narrow category bridge for the two AppAuth presentation
selectors. This keeps interactive sign-in available without widening linkage
for every object in the merged archive.

Separate platform client IDs being present is machine-checkable; their actual
membership in one Google Cloud project is not. Google's cross-client approval
model and the exact desktop/iOS/Android account-subject equality therefore stay
behind the real-account gate.

The implementation follows Google's official
[iOS integration](https://developers.google.com/identity/sign-in/ios/start-integrating),
[iOS API access](https://developers.google.com/identity/sign-in/ios/api-access),
[iOS disconnect](https://developers.google.com/identity/sign-in/ios/disconnect),
[Android AuthorizationClient](https://developers.google.com/identity/authorization/android),
[AuthorizationResult](https://developers.google.com/android/reference/com/google/android/gms/auth/api/identity/AuthorizationResult),
and [cross-client identity](https://developers.google.com/identity/protocols/oauth2/cross-client-identity)
contracts.

## Machine acceptance

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib google_drive_sync::tests
pnpm exec vitest run \
  src/renderer/platform/mobile-tauri-launcher.acceptance.test.ts \
  src/renderer/sync/providers/google-drive/mobile-oauth.architecture.test.ts \
  --reporter=verbose
pnpm typecheck
pnpm exec cross-env \
  VITE_LOCAL_ONLY_MODE=true VITE_REQUIRE_AUTH=false VITE_AI_TRANSPORT=direct \
  VITE_API_BASE_URL=http://localhost:3000 API_BASE_URL=http://localhost:3000 \
  tauri ios build --debug --target aarch64-sim --ci
pnpm exec cross-env \
  VITE_LOCAL_ONLY_MODE=true VITE_REQUIRE_AUTH=false VITE_AI_TRANSPORT=direct \
  VITE_API_BASE_URL=http://localhost:3000 API_BASE_URL=http://localhost:3000 \
  tauri android build --debug --apk
```

The iOS command compiles the Swift package and produces an arm64-simulator app.
The Android command compiles Kotlin plus all four Rust ABIs and produces a
universal debug APK. These are build checks only.

The current machine report is
[`acceptance/phase5-google-drive-mobile-oauth.json`](acceptance/phase5-google-drive-mobile-oauth.json).

## Open production gates

- No real Google account or production client ID was used.
- No physical iOS or Android device completed connect, refresh, reauthorize,
  revoke, restart, force-stop, or offline recovery.
- The desktop/iOS/Android clients have not proved same-project consent reuse or
  the same account subject against one committed Project.
- A fresh device has not completed automatic same-account Project discovery.

Simulator, APK, fake-provider, and static architecture results must not be
reported as real-account or physical-device acceptance.
