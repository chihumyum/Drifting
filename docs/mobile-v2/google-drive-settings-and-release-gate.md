# Mobile V2 Google Drive Settings and release gate

Status: **M8 Settings implementation and Simulator/Emulator acceptance complete;
real-account physical-device release gate open**

Updated: 2026-08-23

This document records the implemented compact-shell Google Drive control
surface without weakening the product rule that Google Drive is a Mobile V2
release gate. Simulator pixels and deterministic fakes prove presentation and
state wiring only. They do not prove Google account, SDK, Keychain/Keystore,
background, cross-device, quota, or revocation behavior on signed hardware.

## Authority and capability gate

Mobile Settings reuses the provider-neutral `SyncPanel` and
`productSyncCommands`; it does not create a mobile-only sync authority or mount
a Project runtime. Product connection stays disabled until all three native
seams advertise `available`:

1. official Google OAuth;
2. native Google Drive transport;
3. opaque local sync object staging.

The compact Settings surface reports that complete readiness projection, not
OAuth availability alone. Missing OAuth, transport, or object staging fails
closed with a local configuration action instead of starting a partial
connection.

## Lifecycle controls

The shared product surface exposes the states and explicit author actions that
already own desktop sync:

- connect and cancel a durable pending connection;
- automatic same-account Project discovery and provisioning retry;
- manual sync, app-wide pause, and resume;
- same-subject reauthorization;
- confirmed disconnect and native revoke.

One synchronous in-flight owner closes the same-frame double-tap window before
React state paints the busy state, so a rapid touch cannot launch two native
OAuth, reauthorization, pause, or revoke operations. Unmount aborts the owned
operation and does not publish a late busy-state update.

The standalone compact route passes `projectImportEnabled={false}` because it
does not own a mounted Project or import-dialog host. Local relational Markdown
export remains independent of Google Drive.

## Safe, actionable issue projection

Settings maps native and runtime reason codes to localized recovery categories:
configuration, offline, reauthorization, account mismatch, permission,
rate-limit, quota, cancellation, required update, data integrity, and safe
retry. A rendered diagnostic code must be on the product allowlist, is
restricted to 64 characters and `A-Z a-z 0-9 _ . -`, and otherwise becomes
`unexpected`; arbitrary exception messages are never placed in the Google
Drive UI.

The native-code projection is a compile-time exhaustive
`GoogleDriveNativeErrorCode` map. That includes recoverable expired cursor and
page-token results; adding a native contract code without assigning a safe
localized category now fails typecheck instead of silently degrading at
runtime.

Durable authority attention and the last runtime-cycle failure remain separate.
Settings does not receive an access token, refresh token, authorization code,
resumable session, absolute path, or raw provider response. Sanitized diagnostic
export remains owned by Settings > Privacy.

## Compact-shell interaction boundary

- The page is portrait-only, safe-area padded, vertically scrollable, and
  horizontally contained.
- Buttons remain at least 44 CSS px high and inputs retain mobile-safe sizing.
- One app-wide Tauri AppPlugin Android Back subscription serves the newest
  mounted compact-shell consumer. In standalone Settings it unwinds sync detail
  to the Settings index, then returns to the exact source route.
- Listener-registration or unregister failure cannot become an unhandled
  Promise rejection during compact-shell unmount.
- The Settings surface never starts OAuth as part of configuration/status/error
  acceptance. Account selection is a separate real-account gate.

## Configuration and credential boundary

Desktop, iOS, and Android client configuration is injected from an ignored
root `.env.local` or explicit CI/shell environment. The generated iOS local
xcconfig is ignored and owner-only. Status output reports only configured or
missing; values are not durable evidence.

Official mobile SDKs request only `drive.appdata`. Drifting persists one opaque
app-wide Google credential reference and SDK binding metadata; the renderer
receives only the opaque reference and stable account subject. Same-subject
reauthorization and fail-closed revoke ownership remain native responsibilities.
Android SDK failures use official `CommonStatusCodes`; cancellation, network,
configuration, account state, and missing-scope permission categories cannot be
confused by stale numeric status assumptions.
iOS uses GoogleSignIn 9.2.0's imported `GIDSignInError` cases, so Keychain and
JSON failures are not mislabeled as an invalid production OAuth build.
Native Drive 408/425 responses remain retryable and retain a bounded
`Retry-After`, so a transient server boundary cannot be surfaced as a permanent
invalid request or strand the durable outbox.

The first physical iOS revoke attempt repeatedly failed with the former coarse
`transient` code. The updated format-v2 privacy summary therefore includes a
bounded, persistent disconnect call chain from Settings through the Rust/native
Google SDK layer. Native details are restricted to allowlisted domain families,
numeric codes, normalized reasons, phase names, and elapsed time; raw error
text, `NSError.userInfo`, URLs, tokens, accounts, paths, and trace identifiers
remain excluded.

The physical retry resumed the same durable attempt and classified the failure:
iOS Google Sign-In reached `resolve-sdk-user`, where AppAuth returned OAuth token
error `-10` over HTTP 400. That pair is `invalid_grant`, meaning the saved Google
grant can no longer refresh and ordinary retry cannot repair it. Local
`persist-blocked-attempt` passed, so SQLite/Yjs/assets and the disconnect owner
remain intact.

The repair maps that exact bounded AppAuth error chain to `needs-reauth`. Settings
then offers **Reauthorize and disconnect**: native OAuth accepts only the already
connected account subject and existing opaque secret reference; after the match,
the product command immediately resumes the same owned disconnect attempt. It
does not mark paused bindings ready while a disconnect owns authority. The
physical row remains open until the repaired build completes that interaction on
the device.

## Accepted evidence and remaining hard gate

Deterministic native, provider, credential, discovery, restore, disconnect,
durable runtime, and multi-Project projection suites pass. The reused iPhone
16e Simulator and `Persimmon_API_35` Android Emulator passed configured-ready,
localized injected-error, safe-code, 44px, portrait, overflow, and Back checks.
Both debug transports report `nativeInput=false`; neither used a Google account.

M8 is not complete and must not be committed as complete until signed physical
iOS and Android devices plus Desktop pass the real-account lifecycle and
cross-device matrix in `delivery-and-acceptance.md`. The executable procedure,
strict JSON template, and privacy/completeness validator are indexed by
[`../qa/google-drive-three-platform-physical-acceptance.md`](../qa/google-drive-three-platform-physical-acceptance.md).
That evidence must use only
synthetic or explicitly authorized Projects and must never record a secret,
token, account identifier, signing material, or private manuscript data.
