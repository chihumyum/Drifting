# Phase 5 Google Drive credential revoke

Status: desktop, iOS and Android native revoke paths implemented; real-account
and physical-device verification remain open.

Drifting disconnects Google Drive through
`platform.googleDrive.revokeAccount(credentialSecretRef, signal?)`. The renderer
passes only the opaque native credential reference. Tokens, SDK account state,
the revoke request and secure-storage deletion remain native-only.

## Failure and idempotency boundary

On desktop, native code reads `GoogleCredentialV1` from secure storage and
sends its refresh token to Google's
[`https://oauth2.googleapis.com/revoke`](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke)
endpoint as an `application/x-www-form-urlencoded` `POST`.

On iOS, the official Google Sign-In client verifies the bound `userID` and
calls `GIDSignIn.disconnect`. On Android, the official `AuthorizationClient`
resolves the same SDK account subject and calls `revokeAccess` for only
`drive.appdata`. Drifting's mobile singleton contains no raw access or refresh
token. Missing/ambiguous SDK account state returns `needs-reauth`; it is not
treated as successful revocation and therefore cannot delete ownership.

| Remote/local result | Native result | Delete local secret |
| --- | --- | --- |
| HTTP `2xx` | `revoked` | yes |
| HTTP `400` with exact `invalid_token` | `already-revoked` | yes |
| Secret already absent on durable retry | `already-missing` | already absent |
| `invalid_request` or malformed `400` | `invalid-request` | no |
| offline, timeout, `429`, or `5xx` | retryable sanitized error | no |
| cancellation before deletion | `cancelled` | no |

This ordering closes both crash windows. If the remote grant is revoked but the
process stops before local deletion, the next attempt receives `invalid_token`
and deletes the secret. If local deletion succeeded but the renderer did not
observe completion, the next attempt receives `already-missing` without making
another network request.

Google Drive uses one native-generated, App-wide singleton reference in the
`sync.google-drive.credentials.<48 lowercase hex>` namespace. Native validation
accepts only that exact opaque slot; Generic renderer Keychain commands cannot
read or delete it. Its provisional/claimed crash ownership is specified in
[`phase5-google-drive-credential-ownership.md`](phase5-google-drive-credential-ownership.md).

The revoke operation uses the existing native transfer cancellation registry.
The public API does not expose a transfer ID; the Tauri adapter generates it and
maps `AbortSignal` to `google_drive_cancel_transfer`.

`CloudDisconnectOrchestrator` injects the platform method as its
`revokeCredential` dependency. The current Settings path requires a second
confirmation and routes through that product composition; the control-plane
evidence is recorded in
[`phase6-product-controls.md`](phase6-product-controls.md).

Google documents that revoking either token removes the OAuth scopes granted to
the Google Cloud project and invalidates related tokens across clients in that
project. Disconnect UX must therefore explain that another device can enter
`needs-reauth`; this behavior still requires a real same-account Project test.

## Machine acceptance

```bash
cargo test google_drive_sync --lib --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm exec vitest run \
  src/renderer/platform/google-drive.test.ts \
  src/renderer/sync/providers/google-drive/mobile-oauth.architecture.test.ts \
  src/renderer/sync/providers/google-drive/tauri-transport.test.ts \
  --reporter=verbose
pnpm exec tsc --noEmit --pretty false
pnpm exec eslint \
  src/renderer/platform/contracts.ts \
  src/renderer/platform/types.ts \
  src/renderer/platform/tauri.ts \
  src/renderer/platform/google-drive.test.ts
pnpm public:check
pnpm exec cross-env \
  VITE_LOCAL_ONLY_MODE=true VITE_REQUIRE_AUTH=false VITE_AI_TRANSPORT=direct \
  VITE_API_BASE_URL=http://localhost:3000 API_BASE_URL=http://localhost:3000 \
  tauri ios build --debug --target aarch64-sim --ci
pnpm exec cross-env \
  VITE_LOCAL_ONLY_MODE=true VITE_REQUIRE_AUTH=false VITE_AI_TRANSPORT=direct \
  VITE_API_BASE_URL=http://localhost:3000 API_BASE_URL=http://localhost:3000 \
  tauri android build --debug --apk
```

The HTTP fake verifies the exact revoke method/path/form body, idempotent
`invalid_token`, retained secret on `invalid_request`/`5xx`, retry metadata and
the absence of bearer headers. TypeScript verifies that only an opaque reference
crosses IPC and that abort cancels the native operation.

Current machine evidence is
[`acceptance/phase5-google-drive-credential-revoke.json`](acceptance/phase5-google-drive-credential-revoke.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).

No test credential is a real Google token. The official clients compile in the
iOS simulator and Android APK builds, but consent revocation, propagation to a
second device, reconnect after revoke, and physical-device behavior remain
explicit gates.
