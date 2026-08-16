# Phase 5 Google account discovery and project restore

Status: **Google sign-in plus automatic project discovery is the only current
restore contract; real-account acceptance remains open**.

There is no separate Restore action or recovery-material form. On the first
connection and on a new/reset device, the user chooses **Sign in with Google**.
The owned Google credential identifies one account, and SyncEngine inventories
that account's complete Drifting `appDataFolder` before publishing local state.

## Restore sequence

1. Reuse or complete Google OAuth and durably claim the opaque credential.
2. Capture the inventory start cursor, enumerate all Drifting object metadata,
   and drain changes to a stable cursor.
3. Group verified commit markers and objects by `projectSyncId` and
   `syncGenerationId`;
   unknown versions and malformed/conflicting objects enter durable quarantine.
4. Select the newest valid committed checkpoint per ProjectSync using the
   protocol's deterministic ordering.
5. Download required package, Yjs, segment, and asset objects into opaque native
   staging; verify kind, identity, hash, size, schema, references, and CRDT state.
6. Materialize each remote project only inside isolated SQLite restore staging.
7. Atomically activate the complete recovered project set, provider authority,
   bindings, observed object inventory, and committed cursor.
8. Publish genesis for local-only projects after remote discovery has completed.

A failed or cancelled attempt exposes no partial remote project and preserves
all authored local data. Network calls never execute inside SQLite
transactions. Provider object removal is corruption/degradation evidence, not a
domain delete.

An empty inventory means this is the account's first Drifting connection.
Signing in to another Google account selects another independent project set;
the app does not ask for a recovery code to bridge accounts.

Current restore evidence is
[`acceptance/phase5-google-drive-restore.json`](acceptance/phase5-google-drive-restore.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).
