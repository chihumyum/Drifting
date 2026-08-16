# Phase 5 Google Drive same-account reauthorization

Status: desktop, iOS and Android native implementations complete; real-account
and physical-device verification remain open.

`platform.googleDrive.reauthorizeAccount(credentialSecretRef)` repairs an
existing `needs-reauth` credential without creating a second secret reference.
The renderer passes only the existing opaque ref and receives the same ref plus
the verified Google account subject; tokens never cross IPC.

## Atomic identity boundary

Desktop reauthorization uses the same system-browser, loopback callback and
PKCE S256 flow as first connect. Native code performs these steps in order:

1. Validate the native-generated credential-ref namespace.
2. Read and retain the existing `GoogleCredentialV1` in native memory.
3. Complete OAuth, token exchange and native UserInfo `sub` lookup.
4. Compare the replacement `sub` with the existing credential's `sub`.
5. Only on an exact match, replace the value at the existing secure-storage
   reference and return that same reference.

OAuth denial, timeout, token/UserInfo failure, wrong-account selection and
secure-storage failure never delete the existing secret. A wrong account has a
dedicated non-retryable `account-mismatch` error and is never written over the
current binding. Reauthorization does not create a temporary credential ref and
does not revoke either the old or replacement token implicitly.

The native refresh mutex serializes refresh, revoke and reauthorize for the
account credential, preventing an old-token refresh from overwriting a newly
reauthorized credential or racing deletion.

iOS reauthorization uses Google Sign-In with the existing SDK account subject
as its hint; Android uses `AuthorizationClient` and verifies the subject from
the resolved `GoogleSignInAccount`. Both compare the official SDK subject again
in Rust before replacing the token-free mobile binding at the same secret ref.
Wrong-account selection may change transient SDK UI state, but it cannot
replace Drifting's subject or ownership record. The `googleDriveOAuth`
capability remains the product gate; transport availability alone does not
imply that reauthorization is usable. See
[`phase5-google-drive-mobile-oauth.md`](phase5-google-drive-mobile-oauth.md).

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

Rust tests prove same-sub replacement, wrong-sub non-write and storage-failure
preservation. TypeScript proves the IPC request contains only the opaque ref and
projects the verified same ref/subject result.

No machine test opens a real Google consent screen. The SDK clients compile in
the iOS simulator and Android APK builds, but existing-ref replacement,
wrong-account selection, restart refresh and another-device continuity remain
real-account/physical-device gates.
