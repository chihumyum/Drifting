# Hosted sync dogfooding

The active Tauri client now supports a separately operated Hosted account and
immutable-object provider. The Apple-native migration remains paused. As of
2026-10-01, Hosted is the only enabled App sync provider. Google Drive settings,
OAuth actions, project provisioning, project sync and Agent conversation sync
are suspended in all builds, including public local-only builds. The retained
Drive implementation, schema and recovery records are not deleted. Builds without
a configured Hosted service continue locally. The author narrowed this
milestone to Mac on 2026-09-30. On 2026-10-01 the author resumed Tauri iOS
Hosted integration, with iPhone Simulator acceptance against the operator's VPS;
Android and physical iOS devices remain outside this milestone. See [iOS](ios.md).

## Local operator loop

For the normal Mac client with Vite HMR against a remote service, use
`DRIFTING_HOSTED_ORIGIN=https://your-service.example pnpm dev:online`.
The origin can also live in ignored `.env.local`; see the
[development setup](../contributor-quick-start.md#develop-against-a-hosted-service-with-hmr).
This uses the normal development library and verified development signing.
The independent labs below keep their own identities and libraries.

Start the private server's Docker stack using its own README. This repository
contains no private server implementation. Run the independent client lab:

```sh
pnpm hosted:client desktop dev
pnpm hosted:client desktop build --debug --bundles app
DRIFTING_HOSTED_LAB_INSTANCE=peer pnpm hosted:client desktop build --debug --bundles app
pnpm hosted:acceptance
pnpm hosted:acceptance --check
```

The default service origin is `http://localhost:3000`. Verification messages
are available in the private stack's local Mailpit. The lab uses its own bundle
identifier and local database directory. `DRIFTING_HOSTED_LAB_INSTANCE=peer`
creates a second isolated Mac instance with its own library and credential service. macOS debug bundles use an ad-hoc
signature; this is not distribution signing. Non-debug macOS bundles require a
verified Apple Development identity. Physical mobile devices require a reachable
service origin, platform provisioning and installation acceptance.

`DRIFTING_HOSTED_ORIGIN` selects another service origin and is embedded in the
native transport allowlist. The lab launcher supplies matching renderer config
and CSP. Release native transport rejects plain HTTP. A local Docker stack on a
sleeping/disconnected Mac cannot provide continuous access away from that Mac.

## Writing and account behavior

[Account settings](account-settings.md) supports changing the display name,
choosing/removing an avatar and changing the password. Password changes verify
the current password and sign out other devices while rotating this device's
session. The existing local library and sync ownership remain unchanged.

The library remains `drifting-library.db` before login, after login, offline and
after logout. Its domain user identity does not become a server account ID.
Cached account display metadata contains no token. Production bearer sessions use an
origin-scoped secure-storage key; another host's retired session is never read
or migrated. Lab bundle identifiers use isolated credential services. Neither
credential hydration nor session requests block opening the local library.

The same configured app offers **Continue locally** and **Sign in / sign up and
sync** on first use. The welcome page states that connecting downloads cloud
projects and uploads the current local library. On the Mac this choice is a
dialog shown before the bookshelf mounts; the existing account flow continues
in that dialog. Authors can switch between sign-in and registration, verify
their email, or use email-code sign-in and password recovery. Successful
authentication connects the library before opening the shelf. An existing
session instead offers **Manage account and sync**. Later sign-in (user menu or
Account settings) opens the same compact dialog over the current screen instead of a
full-page route; the dialog stays open while the library connects. Mobile keeps
its full-page `/login` route. Login explicitly describes the upload/download
boundary and connects the existing library after account verification;
connection failures offer an immediate retry and remain retryable in Account
settings through **Connect and sync**. No second install or
library is needed to move from local writing to Hosted. The source-default
service-disabled configuration is an operator boundary, not a user mode.
Service-disabled builds show only **Continue locally**, without a sync action or
Hosted storage claim. Neither welcome-page variant includes Google Drive copy
or a quick-guide link. The existing `v5` seen marker is retained, so this copy
correction does not reopen onboarding for authors who already dismissed it.

Initial connection publishes existing local projects and restores validated cloud projects before
activating one app-wide authority. New projects publish a genesis snapshot;
**Sync now** waits for every binding to mount and complete a fresh cycle. The
account panel reports the last completed sync and retry/pending state. Other
running clients discover projects on wakeup and periodic checks. An offline
startup revalidates the cached session on focus and every 30 seconds, so a service
restart does not require a new browser network event or manual login.

For a library previously using Drive, **Sign in and sync** or **Connect and sync** adopts
the saved local replica. It does not contact Drive, include unseen changes from
other devices, or delete the Drive copy. The client drains cancelled provider
callbacks, flushes local writes, then atomically records a local disconnect,
creates independent sync generations and a resumable Hosted connect attempt.
The original immutable history remains retired. Rebased reducer ancestry gets
new identities; prose, project IDs, assets and domain rows remain unchanged.
A fresh writer inherits the highest source clock and starts at sequence 1.
No Drive cursor, segment chain, upload receipt or remote asset receipt becomes
Hosted authority. Only a verified published genesis activates sync. An upload
failure leaves the new local replica writable and retryable; cancelling the
connect retains it in local mode. Rejected inbound Drive objects stay quarantined
in the retired generation, with their bytes and diagnostics preserved; they never
enter the new Hosted genesis or block adoption of verified local content. Local
quarantine without a remote source, unresolved conflicts and journal gaps still
block adoption. Unfinished Drive transitions are cancelled locally before
connection, without OAuth, credential revocation or remote deletion. Snapshot
restore/rebase inserts bounded batches into SQLite.

Existing projects continue through the shared SyncEngine journal, checkpoint,
reducer and native blob paths. No second prose database or service entity CRUD
adapter exists. Retired account-deletion and billing clients and the subscription
panel have been removed; local recovery has no subscription cache.

An expired session stops outbound sync and keeps local writing available. Signing
in to the same verified account resumes authentication-blocked generations.
Another account is rejected while the library owns the current Hosted authority.
Pause/resume applies to the active project bindings. Disconnect waits for a fresh
converged frontier, then retains local projects and remote copies. Sign out stops
sync and retains local data; it does not imply pending changes reached the server.

## Versioned service contract

### Project deletion

The bookshelf and project actions share one **Delete locally and from Hosted**
command. Configured Hosted builds require a connected owning account; there is
no local-only fallback. The client drains discovery, provisioning and sync,
keeping sync suspended until overlapping deletion/provider-change holds release,
checks current bindings plus historical connection receipts, and calls
`DELETE /api/sync/v1/project-v1/generations/{id}` for every owned Hosted generation.
Only matching successful deletion receipts permit the local SQLite purge and
subsequent asset/presentation cleanup. Offline, unsupported-server, account-change
and ambiguous-response failures keep the local project and leave the confirmation
dialog open with a retryable error. Never-synced projects in service-disabled
local builds retain local deletion; unowned remote evidence blocks that path.
Suspended Drive history is retained outside the Hosted deletion contract.

The service deletes live project objects and the same generation's `agent-chat-v1`
objects in one PostgreSQL transaction, retaining permanent generation tombstones.
Retries return the same deletion receipt, discovery omits the removed snapshots,
and old devices cannot reopen or upload to either deleted stream. A scoped
HTTP 410 receipt includes `GENERATION_DELETED`, namespace, generation ID and deletion
time; the client validates the receipt and current account before applying the
local purge. A generic HTTP error never authorizes local deletion. This also
recovers a crash or lost acknowledgement after the server committed deletion.
Backups follow the operator's separate retention policy.

Deploy the service migration and endpoint before using this client action.
The real HTTP/SQLite tests in `hosted.integration.test.ts` cover offline failure,
lost DELETE response, an offline peer with pending prose and fresh-device discovery.
`project-deletion.integration.test.ts` covers local atomicity, ownership, historical
generations and local-only boundaries. `pnpm hosted:acceptance` regenerates their
machine-checkable report; native UI and production deployment remain separate gates.

Paths start `/api/sync/v1/project-v1` or `/api/sync/v1/agent-chat-v1`. The provider
opens account-owned generations, enumerates inventory and changes using opaque
cursors, uploads immutable objects with SHA-256, and downloads them into native
staging references. Account-wide snapshot discovery never activates unvalidated
bytes. The current service ceiling is 64 MiB per object.

Native requests enforce the configured origin, deny redirects, cap responses,
verify uploaded files and downloaded hashes, stream binary data outside JS, and
publish downloaded files only after fsync and rename. A cancelled or corrupted
transfer leaves the canonical destination unmodified. The service can read stored
content; this integration does not claim end-to-end encryption.

iOS shares account, native object transport and local-first sync with desktop.
Its explicit online launch and installation paths use the same configured origin
for renderer requests, native transport and CSP. No physical mobile usability is claimed.

## Acceptance and remaining device gates

`src/renderer/features/auth/auth-entry.acceptance.test.ts` and
`src/renderer/features/settings/hosted-settings-boundary.acceptance.test.ts`
check the first-run account entry, local-only boundary, English/Chinese copy and
absence of retired welcome-page links. These source contracts do not claim a
live account registration or delivered verification email.

[Native session observations and open gates](native-session.md) record the
interactive work separately from the final source checks.

[Generated integration evidence](acceptance/client.json) is tied to the current
source fingerprint and exercises real HTTP with independent SQLite libraries:
initial connect/recovery, concurrent offline Chinese prose, lost upload response,
new-project provisioning/discovery, synthetic asset bytes, session rejection,
reauthentication, reopening SQLite, offline Drive takeover with rollback, preserved
immutable history and remote quarantine, cross-batch reducer ancestry and asset restoration.
The Hosted-only App boundary also verifies that retained Drive bindings mount no
project or conversation transport, Settings exposes no Drive controls, and local
integrity failures still roll back adoption. Dedicated tests also cover account identity,
local-only network denial and credential persistence failures.

The Mac interaction loop uses two isolated app instances on one physical Mac.
The integration report uses explicit test ports for object staging and asset
activation. Native UI interaction, physical IME, physical-device backgrounding,
installation signing and internet deployment are separate gates. No unattended
background execution guarantee is made for mobile; wait for sync completion before
switching devices. Keep independent exports/backups while dogfooding.

## Local writing identity and macOS prompts

The non-secret installation marker lives in `sync-installation-v2.json` in the
native app data directory, outside SQLite backups. Creation publishes a fully
fsynced owner-only file without overwriting another creator. Concurrent first
reads converge; a corrupt or symlinked marker fails explicitly. A missing marker
creates a new identity and the existing journal rotates writer/epoch while
retaining prior changes and HLC ordering. The retired Keychain marker is never
read or deleted during this upgrade. Local writing does not need a Keychain grant.

macOS background credential reads skip entries requiring user interaction. They
never weaken an entry's access control; unavailable credentials require sign-in
or re-entry. Explicit production credential writes may still require the OS's
normal authorization. Stable distribution signing remains a separate release gate.

Only debug Mac lab identities targeting an exact compiled loopback service keep
that origin's Hosted session in an atomic owner-only local file (directory 0700,
file 0600). This is disposable developer-session storage, not encryption. Release
builds, production app identities, remote service origins, other-origin session
keys and all BYOK/OAuth/Drive secrets cannot use this path. No old Keychain token
is copied. The first updated lab launch requires signing in again; subsequent
lab rebuilds reuse the local session without code-signing authorization prompts.
