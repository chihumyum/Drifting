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
| Sync now | Requests one cycle for every mounted Project when cloud authority is ready. |
| Pause/resume | Changes all eligible Project bindings together; mixed per-Project provider mode is not exposed. |
| Reauthorize | Requires the same Google subject and replaces the existing native credential in place. |
| Disconnect | Requires confirmation, follows durable native revoke ordering, and returns to Local mode without deleting local SQLite, Yjs, assets, or Project identity. |
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

## Acceptance boundary

Focused product evidence is
`src/renderer/features/settings/personal-cloud-settings.acceptance.test.ts`
together with product command/authority/runtime, disconnect, provider, and
production composition tests. It proves routing and secret-free projection; it
does not prove a real Google account or physical device.

Current product-control evidence is
[`acceptance/phase6-product-controls.json`](acceptance/phase6-product-controls.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).

Open release gates include real Google accounts on supported platforms,
fresh-device automatic discovery, cross-device convergence, restart refresh,
revoke/reauthorize, background/lock/suspend/force-stop/offline behavior, and
large-asset resumable transfer. Fake-provider, simulator, build, and static
architecture results must not be reported as those gates.
