# Phase 5 initial Google Drive connection

Status: **one Google sign-in entry with automatic project discovery is the
current product contract; real-account/device gates remain open**.

Initial connection and restore are not separate choices. Settings calls the one
Google Drive connect command. After OAuth, SyncEngine automatically discovers
existing projects in the selected account before it publishes projects that
exist only on the current device.

## Durable sequence

1. Fail closed if native Google OAuth/transport is unavailable.
2. Complete or reuse Google sign-in and obtain only the account subject plus
   opaque credential reference.
3. Persist and claim that exact credential before provider I/O.
4. Create one App-wide connection attempt covering the current local project
   set; no project becomes independently provider-selectable.
5. Capture Drive inventory and drain its cursor, verify remote objects, and
   restore discovered projects through isolated staging.
6. Flush local Yjs, capture genesis for local-only projects, and publish required
   blobs/package/commit marker in dependency order.
7. Atomically activate the provider authority and every ready project binding.
8. Emit `sync:authority-changed` only after the activation commit.

There is no recovery phrase, QR, biometric/user-presence reveal, “saved”
confirmation, project key, or separate Restore form. Restart resumes the owned
credential, inventory, transfer receipts, and connection attempt without
opening OAuth again unless authorization needs repair. Cancelling the pending
transition from Settings revokes its native credential through the durable
revoke path before the attempt is cancelled; abandoning the OAuth flow itself
never yields a credential and keeps any already-owned one. Neither form of
cancellation deletes authored local projects.

Checkpoint thresholds and fail-closed gap/conflict/quarantine rules remain
provider-neutral. Network calls never run while a SQLite transaction is open.

Current connection evidence is
[`acceptance/phase5-initial-connect.json`](acceptance/phase5-initial-connect.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).
