# Hosted sync dogfooding

The active Tauri client now supports a separately operated Hosted account and
immutable-object provider. Hosted is the only App sync provider. Builds without
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

The desktop workspace shows sync state outside Settings: a sand mark in the
paper's lower-left corner for long transfers, retries and offline, plus the
notification bell for problems the author has to act on. See
[sync status](sync-status.md).

[Account settings](account-settings.md) supports changing the display name,
choosing/removing an avatar and changing the password. With sync connected,
appearance, typography, writing behaviour, interface language and shortcuts
follow the account; device-bound settings stay local. See
[account preferences](preferences.md). Password changes verify
the current password and sign out other devices while rotating this device's
session. The existing local library and sync ownership remain unchanged.

Each Hosted account has its own library on the Mac and a separate local library
holds signed-out writing; see [account-isolated libraries](account-libraries.md).
Signing in opens the account's library (relaunching the App), signing out
returns to the local library, and an expired session or offline use keeps the
same library. A book moves between libraries only by an explicit export and
import ([book transfer](../book-transfer.md)). Within every library the domain user identity stays
`drifting-library.db`; it does not become a server account ID.
Cached account display metadata contains no token. Production bearer sessions use an
origin-scoped secure-storage key; another host's retired session is never read
or migrated. Lab bundle identifiers use isolated credential services. Neither
credential hydration nor session requests block opening the local library.

The same configured app offers **Continue locally** and **Sign in / sign up and
sync** on first use. The welcome page states that signing in opens the
account's own library and downloads its cloud projects, while books already on
this device stay in the local library. On the Mac this choice is a
dialog shown before the bookshelf mounts; the existing account flow continues
in that dialog. Authors can switch between sign-in and registration, verify
their email, or use email-code sign-in and password recovery. When the service
cannot mail a code today (`MAIL_QUOTA_EXHAUSTED`) or right now
(`MAIL_DELIVERY_FAILED`; see the service's mail pool), each of those steps says
so and that Drifting works fully without an account: the author keeps writing
on this device and signs in to sync later. The share-link reader shows a shorter
version of the same notice. Successful
authentication connects the library before opening the shelf.

Above the email fields the flow offers **Continue with Google** when the service
declares it: `GET /api/auth/providers` lists the providers the deployment
registered, and the client shows the ones it knows
(`src/renderer/lib/oauth-providers.ts`, keyed by the same provider name, so
WeChat later is one entry and an icon). An older service, an error, offline use,
a local-only build or closed sign-up shows none, and email sign-in is unchanged.
The button opens the system browser at `/api/auth/oauth-redirect/:provider` with
a 256-bit state and an S256 PKCE challenge kept in WebView storage for ten
minutes. The service answers the provider callback with a page that opens
`drifting://auth/callback` with a two-minute single-use code; the app trades it
with its verifier at `/api/auth/native-exchange` for a bearer token, stored in
secure storage like any other session, and the browser keeps no session (service
contract: the service's `docs/native-oauth-v1.md`). One listener for the whole
app (`NativeOAuthEffects`) receives every callback, so a callback that arrives
after the dialog closed, or that launches the app cold, opens the sign-in dialog
and finishes there. While the browser is open the button reads *Waiting for
browser authorization…* with **Cancel**; cancelling forgets the pending state, so
a later callback is ignored. A cancel in the browser, a sign-in that outlives the
pending state, and a Google email that already belongs to an unverified account
each get their own sentence. The whole path stays behind the hosted-service gate
in `src/renderer/lib/config.ts`.

An existing
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
Hosted storage claim. Neither welcome-page variant includes a quick-guide link. The `v6` seen marker is stored per local library identity; it is not tied to the
Hosted account. Clearing WebView storage can show the guide again.

Initial connection publishes the library's existing projects and restores validated cloud projects before
activating one app-wide authority. On the desktop a new account library has no
projects of its own, so its first connection only restores. New projects publish a genesis snapshot;
**Sync now** waits for every binding to mount and complete a fresh cycle. The
account panel reports the last completed sync and retry/pending state. While a
connect restores projects, the shelf and the account panel show its phase and
download progress; a second connect request joins the running one. Other
running clients discover projects on wakeup and periodic checks. An offline
startup revalidates the cached session on focus and every 30 seconds, so a service
restart does not require a new browser network event or manual login.

A library that was bound to the removed Drive sync is turned into a local
library by migration `0014` and then connects like any other local library.
Objects the device never fetched from Drive are recorded as removed, so they never wait as
downloads. Snapshot restore/rebase inserts bounded batches into SQLite.

Existing projects continue through the shared SyncEngine journal, checkpoint,
reducer and native blob paths. No second prose database or service entity CRUD
adapter exists. Retired account-deletion and billing clients and the subscription
panel have been removed; local recovery has no subscription cache.

An expired session stops outbound sync and keeps local writing available. Signing
in to the same verified account resumes authentication-blocked generations.
Another account is rejected while the library owns the current Hosted authority;
on the desktop signing in with another account opens that account's library
instead, so the check is a safeguard.
Pause/resume applies to the active project bindings. Disconnect first uploads
what only this Mac holds (this installation's change sets no published segment
covers, and verified blobs the provider lacks), showing how many remain; it does
not wait for downloads, and **Disconnect now** stops waiting and leaves the rest
on this Mac. Signed out or paused, nothing can upload, so Disconnect states that
count and asks before going ahead. Either way local projects and remote copies
are retained. Sign out stops sync, keeps the account's library and binding on
this Mac and, on the desktop, returns to the local library; signing back in to
the same account resumes. While this Mac holds changes the cloud lacks, Sign out
first opens a dialog that says how many: **Upload, then sign out** (offered only
while sync can upload) waits for them and **Sign out now** leaves them in the
account's library. With nothing pending it signs out at once. To switch
accounts on the desktop, sign in with the other account. Mobile keeps one
library: there the dialog's switch also disconnects it, and the
account-mismatch dialog points to Account settings.

## Versioned service contract

### Project trash

Deleting a project from the bookshelf or the mobile project actions first moves
it to **Recently Deleted**: a synced `project.deleted_at` field write (migration
`0010_project_trash`, last-writer-wins like any other project field). It works
offline, hides the project on every device, closes it where it is open, and keeps
all content, Hosted data and the readable Markdown copy. Restoring clears the
field. Thirty days after `deleted_at`, the shelf permanently deletes the project
through the path below; it waits two minutes after the shelf opens so a restore
made elsewhere can arrive first, and a failure leaves the project in the trash
for the next attempt. Recently Deleted also offers **Delete now**.

### Project deletion

Permanent deletion (from Recently Deleted, or when the trash period expires)
is one **Delete locally and from Hosted** command. Configured Hosted builds require a connected owning account; there is
no local-only fallback. The client drains discovery, provisioning and sync,
keeping sync suspended until overlapping deletion/provider-change holds release,
checks current bindings plus historical connection receipts, and calls
`DELETE /api/sync/v1/project-v1/generations/{id}` for every owned Hosted generation.
Only matching successful deletion receipts permit the local SQLite purge and
subsequent asset/presentation cleanup. Offline, unsupported-server, account-change
and ambiguous-response failures keep the local project and leave the confirmation
dialog open with a retryable error. Never-synced projects in service-disabled
local builds retain local deletion; unowned remote evidence blocks that path.
Objects stored by a removed provider are outside the Hosted deletion contract.

The service tombstones the project stream and the same generation's
`agent-chat-v1` stream in one PostgreSQL transaction. Tombstones are permanent;
the bytes stay operator-recoverable for 30 days and are then purged by the service.
Retries return the same deletion receipt, discovery omits tombstoned snapshots,
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

### Storage quota

`GET /api/sync/v1/usage` reports the account's `usedBytes` (live projects only),
the 500 MiB product `quotaBytes` and a 1 GiB `hardLimitBytes`. Before a new
image or PDF is committed to a Hosted library, `assertHostedQuotaAllows`
(`src/renderer/sync/hosted/quota.ts`, called from `prepareLocalProjectAsset`)
adds the account's server usage, local attachment bytes not yet uploaded and the
new file, and refuses the import with a readable message when that exceeds the
quota; the partial import is removed. Prose and structure are never limited.
Local-only libraries are not checked, and an unreadable usage (offline, first
launch) never blocks writing; the service's hard limit is the backstop. A blob the
service refuses (`413 QUOTA_EXCEEDED`, a distinct non-retryable code) holds back
that project's later change-sets until usage drops, so the import gate keeps it
from happening in normal use. Settings → Account shows the usage meter and
explains a quota-blocked project.

### Log truncation

Every native request sends `X-Drifting-Sync-Capabilities: removals-v1`, and
`changes` asks for `includeRemovals=1`. Once the service has pruned a stream,
it rejects requests without that capability (HTTP 426).
`POST …/generations/{id}/prune` takes `{basisCursor, retain, remove}` and
returns `{status: "pruned", removed, deferred, cursor}`. The service keeps at
least two snapshot markers and defers segments inside its 30-day grace window.
It removes packages only together with a marker, never removes blobs, and
rejects a basis that a later snapshot outdates. The client keeps pruning off
(`SYNC_LOG_PRUNING_ENABLED`) until that service version is deployed. Local
journal truncation needs no service change and is on
(`SYNC_JOURNAL_TRUNCATION_ENABLED`): once a published snapshot covers applied
history, the replica deletes those journal rows. Retention, removal handling,
lagging-replica catch-up and journal truncation are specified in
[phase 7](../sync-engine/phase7-log-compaction.md).

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
absence of retired welcome-page links. `src/renderer/features/auth/auth-errors.test.ts`
and `src/share-web/i18n.test.ts` check the notice for each verification-mail
refusal in both languages and that every request mailing a code uses it. These
source contracts do not claim a live account registration or delivered
verification email.

[Native session observations and open gates](native-session.md) record the
interactive work separately from the final source checks.

[Generated integration evidence](acceptance/client.json) is tied to the current
source fingerprint and exercises real HTTP with independent SQLite libraries:
initial connect/recovery, concurrent offline Chinese prose, lost upload response,
new-project provisioning/discovery, synthetic asset bytes, session rejection,
reauthentication, reopening SQLite, a library migrated from Drive connecting and
converging, cross-batch reducer ancestry and asset restoration. Dedicated tests also cover account identity,
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
keys and all BYOK/OAuth secrets cannot use this path. No old Keychain token
is copied. The first updated lab launch requires signing in again; subsequent
lab rebuilds reuse the local session without code-signing authorization prompts.
