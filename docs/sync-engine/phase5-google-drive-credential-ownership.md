# Phase 5 Google Drive credential crash ownership

Status: **native singleton ownership is the current credential contract;
real-account crash injection remains open**.

One app has one active Google provider authority. Native secure storage owns one
opaque credential slot with `provisional | claimed` state and the Google account
subject. Desktop stores refresh material natively; mobile delegates account and
token lifecycle to the official SDK. Renderer code and SQLite never receive a
token.

## Durable ordering

1. Google sign-in creates or reuses the provisional native credential.
2. SQLite records the exact account subject, opaque ref, and connection attempt.
3. Native `claimAccount` verifies both identities and commits ownership.
4. SyncEngine automatically inventories that account's Drifting projects.
5. Remote projects restore through isolated staging; local-only projects publish
   genesis.
6. One SQLite transaction activates the complete account-wide project set.

There is no recovery code, recovery QR, application-managed Project content
key, or reveal/confirmation step. A crash retries the same credential and
discovery attempt. Account mismatch, offline failure, cancellation, `429`, and `5xx` keep
the owned credential; another account can replace it only after explicit revoke
succeeds.

The product vocabulary is Project. Technical contracts use `ProjectSync` for
the stable cross-device identity and `SyncGeneration` for one immutable-log
generation.

Focused acceptance covers singleton namespace confinement, provisional claim
idempotence, exact-subject checks, crash/reopen reuse, credential-first durable
attempts, cancellation/revoke retention, and same-account reauthorization. No
machine test is a real Google-account `SIGKILL` or Keychain-restart report.

Current machine evidence is
[`acceptance/phase5-google-drive-credential-ownership.json`](acceptance/phase5-google-drive-credential-ownership.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).
