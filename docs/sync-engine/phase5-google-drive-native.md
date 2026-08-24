# Phase 5 native Google Drive transport

Status: **native transport foundation implemented; trusted-cloud product
acceptance remains behind real-account and physical-device gates**.

Google Drive is an `ObjectLogProvider`, not a database. SQLite/Yjs remain each
device's complete working copy and SyncEngine owns merge semantics. The current
trust contract is
[`trusted-cloud-google-drive.md`](trusted-cloud-google-drive.md): Google OAuth
and Drive are trusted. Drifting sends plaintext SyncEngine objects over HTTPS
and does not end-to-end encrypt Project content against Google.

## Native boundary

`TauriGoogleDriveObjectTransport` exchanges only opaque credential,
`generationRef`, and `syncobj:` references plus Drive file IDs, cursors, object
kind, logical ID, SHA-256, and byte size. Access/refresh tokens, bearer headers,
resumable session URIs, and absolute paths never enter renderer DTOs.

Upload validates the native-root-confined source, logical identity, kind,
hash, and size before streaming it. Download validates immutable Drive
`appProperties`, streams into native staging, verifies size and SHA-256,
`fsync`s, and atomically activates the destination. These are integrity and
path-confinement controls, not application-level content encryption.

The current Drive wire is `object-v2`; `driftingSyncGenerationId` is the
generation metadata key. Account-level `discoverProjectSnapshots()` scans
only current `snapshot-commit` objects, and generation-bound transport opens
with `google_drive_open_generation`. Upload uses
`google_drive_upload_immutable` after exact native ref/hash/size validation.

Drive uses only `https://www.googleapis.com/auth/drive.appdata` and the account's
hidden `appDataFolder`. Full inventory plus change cursors support automatic
account-scoped project discovery. Same logical ID/hash/size is idempotent;
different content under an existing identity fails closed. Uploads are
resumable and downloads are streaming.

Desktop uses system-browser OAuth with loopback callback and PKCE. iOS uses
Google Sign-In and Android uses `AuthorizationClient`. All return only an
opaque native credential reference and Google account subject. Missing build
configuration advertises OAuth as unsupported.

Native HTTP errors preserve safe recovery semantics without projecting response
bodies: 401 refreshes once then requires reauthorization; 403 distinguishes
permission, rate, and quota reasons; 429 and 5xx retry with bounded
`Retry-After`; 408 and 425 are also transient retries rather than permanent
invalid requests. A missing immutable object remains a fail-closed integrity
result.

The desktop `pnpm dev`, `tauri:build`, and `tauri:build:debug` entrypoints use
`scripts/run-desktop-tauri.mjs`. It loads the ignored repository `.env.local`
before spawning Tauri so native compile-time OAuth settings match the renderer
development environment; an explicit shell or CI value wins. The launcher logs
only a configured/missing boolean and never prints the client ID or installed-
app secret.

## Verification boundary

Focused native/provider checks include `google_drive_sync`,
`src/renderer/platform/google-drive.test.ts`, provider architecture/conformance,
Tauri transport, desktop launcher environment, mobile OAuth architecture,
typecheck, scoped ESLint, and
`pnpm public:check`.

Current native transport evidence is
[`acceptance/phase5-google-drive-native.json`](acceptance/phase5-google-drive-native.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).

Real consent, restart refresh, interrupted transfer, revoke propagation,
same-account fresh-device discovery, cross-device convergence, and physical
desktop/iOS/Android behavior remain open release gates.
