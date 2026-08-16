# Trusted-cloud Google Drive contract

Status: **current product contract; real-account and physical-device release
acceptance remain open**.

Drifting is local-first. SQLite and Yjs remain the working copy and source of
truth on each device. Google Drive is an optional durable transport for
SyncEngine objects; it is not the application database and does not perform
merge or conflict resolution.

## Trust and privacy boundary

Google sign-in is the authority for cross-device access. Anyone who can
authorize the same Google account can discover that account's Drifting
projects. Drifting has no separate account, recovery code, recovery QR, or
application-managed project content key.

Google OAuth and the selected account's Drive `appDataFolder` are inside the
cloud trust boundary. Drifting does not end-to-end encrypt synchronized project
objects against Google. HTTPS protects transport and Google's storage
protections apply at rest, but those protections do not prevent Google from
processing the stored content.

Synchronized objects can contain the complete Project: manuscript text, Yjs
updates and checkpoints, planning metadata, comments, Agent memory, snapshots,
and imported image/PDF bytes. Users who do not accept that trust boundary can
stay in Local mode and use local export.

OAuth credentials stay native-owned. Renderer code receives only an opaque
credential reference and stable Google account subject; access tokens, refresh
tokens, resumable upload session URIs, and absolute local paths do not cross
the renderer boundary.

## One account flow

1. The user chooses **Connect Google Drive** and completes Google sign-in.
2. Native OAuth returns an opaque credential reference and account subject.
3. SyncEngine inventories Drifting objects in that account's `appDataFolder`
   before publishing local state.
4. Existing Projects restore into isolated staging and become visible only
   after verification and one atomic SQLite activation.
5. Local Projects not already represented remotely publish genesis and join
   the same account-wide sync authority.

On a new or reset device, the user signs in to the same Google account.
Automatic account-scoped discovery is the restore mechanism. An empty
inventory is a valid first connection. Choosing another Google account exposes
that account's independent Project set.

Discovery, download, validation, and local staging may be retried after a
crash. Network calls never run inside a SQLite transaction. A failed or
cancelled connection leaves authored local Projects intact and does not expose
partially restored Projects.

## Product terminology

The user-visible unit is a **Project** / **项目**. `ProjectSync` names a stable
cross-device Project identity in technical contracts. `SyncGeneration` names
one immutable-log generation of that ProjectSync, and `generationRef` is only
an opaque provider handle. These internal names are not user accounts,
recovery concepts, or independent provider choices.

## Provider role

Google Drive provides an account-scoped object namespace, immutable object
upload/download, inventory, change cursors, removal notifications, and
resumable transfer. SyncEngine owns:

- canonical change-set and checkpoint formats;
- per-Project ordering, CRDT/LWW/OR-set merge semantics, and conflict state;
- cursor and transfer durability;
- hash/size/schema verification and quarantine;
- isolated restore and atomic Project activation;
- local asset capture/install and post-commit editor notification.

Provider object names are diagnostic only. Identity comes from validated
protocol metadata. The same logical key with the same hash and size is
idempotent; the same key with different content fails closed.

## Release boundary

Source, fake-provider, simulator, and build evidence do not prove real Google
account behavior. A public sync claim still requires real-account acceptance on
the supported desktop/iOS/Android targets, same-account automatic discovery on
a fresh device, cross-device convergence, restart and credential refresh,
offline/retry, force-stop/background behavior, revoke/disconnect, quota/error
handling, and large-asset resumable transfer.

The machine-readable contract is
[`acceptance/trusted-cloud-google-drive-contract.json`](acceptance/trusted-cloud-google-drive-contract.json).
