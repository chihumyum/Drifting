# Phase 6 SyncEngine product controls

Status: **the current Settings contract is one Google-sign-in entry with
automatic Project discovery; real-account and physical-device release gates
remain open**.

Settings reads one App-wide, secret-free sync snapshot. User actions go through
the product command service; UI code never receives credential refs, tokens,
resumable sessions, provider handles, object bytes, or filesystem paths.

## Product surfaces

| Product intent | Current behavior |
| --- | --- |
| Connect Google Drive | Shows **Sign in with Google**. OAuth is followed automatically by account-scoped discovery/restore, then publication of local-only projects. There is no connect-vs-restore choice. |
| Cancel pending cloud connect | Settings exposes a second-confirmation cancel for an unactivated local-to-Drive transition. The `cancelPendingGoogleDrive` product command revokes the pending native credential through the durable revoke path, cancels the attempt, and preserves every authored local project. |
| Sync now | Requests one cycle for every mounted Project when cloud authority is ready. |
| Pause/resume | Changes all eligible Project bindings together; mixed per-Project provider mode is not exposed. |
| Reauthorize | Requires the same Google subject and replaces the existing native credential in place. |
| Disconnect | Requires confirmation, follows durable native revoke ordering, and returns to Local mode without deleting local SQLite, Yjs, assets, or Project identity. |
| Reconnect after disconnect | Discovers Drive before activation. An attached Project uses its `projectId`; an offline-deleted Project resolves the same unique identity from its terminal generation journal. An exact `projectId` + `projectSyncId` + `syncGenerationId` match rebinds without restoring over offline work or publishing a second genesis. Existing provider-object inventory rows retain their durable SQLite primary keys when the connect receipt references the commit marker. Because the provider object log is immutable, discovery may also return older generations that this device has already durably retired or purged; those terminal local receipts are skipped without resurrection or blocking the still-active generation. The runtime then publishes pending edits or the terminal Project purge. New remote Projects still restore normally; an ambiguous or mismatched identity fails closed. |
| Retry an interrupted remote restore | Discovery may reuse a project-less staged generation after its authenticated marker has already resolved `projectSyncId`. Resuming the same durable attempt, or cancelling it and later starting a fresh connect, revalidates the marker and continues restore instead of reporting local ownership. A staged row with Project state, authored journal state, a provider binding, or an activated history still fails closed. |
| Status and diagnostics | Shows Local, connecting/discovering, syncing, synced, paused, offline, or attention plus Project and pending-work counts. Transport generation identifiers stay internal. |

The panel states the privacy boundary next to the connection action: SQLite is
the local working copy; the selected Google account and Drive are trusted with
synced project content; Drifting does not E2EE it against Google.

There is no recovery-code input, recovery phrase/QR display, biometric reveal,
saved-confirmation step, or standalone restore action.
Automatic discovery after Google sign-in is the restore experience. Closing
Settings may cancel presentation/work owned by that UI invocation, but durable
background work remains governed by its connection attempt and transfer
receipts.

The shelf Settings route remains available before a project is created, so a
fresh device can sign in and discover existing projects.

The mobile Settings surface routes through the same command service behind a
compact presentation (`google-drive-settings-presentation.ts`). Connection is
gated on complete native readiness: OAuth, Drive transport, and the opaque
object store must all be available before the sign-in action is enabled.
Native failures project only localized, safe issue descriptions; iOS OAuth
status maps the official Google Sign-In enum, and Android derives its OAuth
permission state from the granted scope rather than an arbitrary status
message. The mobile acceptance suite
(`mobile-v2-google-drive.acceptance.test.ts`) freezes this contract.

## Acceptance boundary

Focused product evidence is
`src/renderer/features/settings/personal-cloud-settings.acceptance.test.ts`
together with product command/authority/runtime, disconnect, provider, and
production composition tests. The recorded command set also runs
`desktop-standalone-settings.acceptance.test.ts`,
`google-drive-settings-presentation.test.ts`,
`mobile-v2-google-drive.acceptance.test.ts`,
`mobile-workspace-controller.acceptance.test.ts`,
`pending-transition-cancel.integration.test.ts`,
`google-drive-physical-evidence.acceptance.test.ts`, and
`pnpm mobile:google-drive:acceptance:contract`. The Google Drive restore
integration suite also
covers reconnect discovery where a locally purged historical generation is
returned before the exact active generation, for both offline edit and offline
Project-purge paths. It proves routing and secret-free projection; it
does not prove a real Google account or physical device.

Current product-control evidence is
[`acceptance/phase6-product-controls.json`](acceptance/phase6-product-controls.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).

Open release gates include real Google accounts on supported platforms,
fresh-device automatic discovery, cross-device convergence, restart refresh,
revoke/reauthorize, disconnect-local-edit-reconnect, background/lock/suspend/
force-stop/offline behavior, large-asset resumable transfer, and an independent
security review. Physical-run claims must pass the strict physical-evidence
validator, whose privacy checks fail closed and whose passed rows require
digests. Fake-provider, simulator, build, and static architecture results must
not be reported as those gates.
