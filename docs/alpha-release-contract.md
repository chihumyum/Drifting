# Drifting desktop Alpha release contract

Status: **paused by the author on 2026-10-28.** Drifting is being substantially
restructured; this contract and its release gates are not in force and will be
rebuilt once the client stabilizes. It is kept as historical context. The
migration rules in [`../AGENTS.md`](../AGENTS.md) still apply.

## Supported product

- macOS 13 or later on Apple Silicon.
- Local-first writing without a Drifting account or hosted Drifting service.
- Optional Hosted account and sync in an explicitly configured distribution.
  SQLite remains the local working copy; the operator can read synced content.
- BYOK Copilot and General Agent are experimental. Model requests go directly
  to the provider selected by the author, use that provider's billing and data
  terms, and never fall back to a hosted Drifting model.

Mobile, Intel Mac, Windows, Linux, hosted models, and non-core Agent products
are outside this release.

## Data contract

`0.1.0-alpha.1` is the first public compatibility baseline. All public `0.1.x`
releases must migrate every earlier public `0.1.x` database forward. Published
migrations are append-only. Development databases from before this baseline
are not a supported migration population.

Relational Markdown is the user-facing readable export. Hosted is the
optional cross-device discovery and restore path. Before a public migration
touches SQLite, the native layer creates and verifies an internal safety
snapshot, migrates only an isolated candidate, and activates it only after
integrity, foreign-key, and migration-journal checks pass.

Installing a downloaded update first drains every local durability lane
(editor, Yjs, snapshot history, assets, sync journal, SQLite checkpoint). If
that fails, nothing is installed and the verified download stays ready for a
retry. After the native install, the relaunch goes through the same flush
barrier and deadline as an ordinary quit; it never restarts directly.

A local, stable library can be exported and restored as a complete `.drifting`
package ([`library-backup.md`](library-backup.md)); a cloud-bound library cannot,
and no same-ProjectSync replacement workflow exists. Internal migration
snapshots are not a general Settings product and appear only when database
recovery is required.

## Release gates

The Alpha must not be offered as a public download until all of these have
current evidence for the exact source SHA and signed artifact:

1. shadow database migration and native asset transactions survive injected
   failure and force quit without exposing partial old/new state;
2. fresh-install write/restart/force-quit and update preservation on a clean Mac;
3. real-account Hosted discovery, two-client convergence, restart, offline,
   reauthorization, revoke, quota/error, and resumable large-asset behavior;
4. Developer ID signing, notarization, stapling, Gatekeeper, updater signature,
   checksum, bundled notices, and public re-download verification;
5. anonymous availability of the CI-enforced public pages — the drifting.app
   homepage, Privacy, service terms, Quick Start, Support, and Known
   Issues — plus the public source repository and license linked from the app;
6. one real reviewed BYOK General Agent task if the Agent remains visible in
   release copy.

Automated tests, fake providers, local builds, simulators, and an unsigned DMG
are supporting evidence only. They cannot close the corresponding native,
real-account, or distribution gate.
