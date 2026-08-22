# Drifting desktop Alpha release contract

Status: **frozen for `0.1.0-alpha.1` implementation; external release gates remain open**.

## Supported product

- macOS 13 or later on Apple Silicon.
- Local-first writing without a Drifting account or hosted Drifting service.
- Optional Google Drive `appDataFolder` synchronization through the author's
  Google account. SQLite remains the local working copy. Synchronized project
  content is not end-to-end encrypted against Google.
- BYOK Copilot and General Agent are experimental. Model requests go directly
  to the provider selected by the author, use that provider's billing and data
  terms, and never fall back to a hosted Drifting model.

Mobile, Intel Mac, Windows, Linux, hosted accounts, hosted models, Ambient
Editor, and non-core Agent products are outside this release.

## Data contract

`0.1.0-alpha.1` is the first public compatibility baseline. All public `0.1.x`
releases must migrate every earlier public `0.1.x` database forward. Published
migrations are append-only. Development databases from before this baseline
are not a supported migration population.

Relational Markdown is the user-facing readable export. Google Drive is the
optional cross-device discovery and restore path. Before a public migration
touches SQLite, the native layer creates and verifies an internal safety
snapshot, migrates only an isolated candidate, and activates it only after
integrity, foreign-key, and migration-journal checks pass.

The Alpha does not expose a whole-library backup/import format or a
same-ProjectSync replacement workflow. Internal migration snapshots are not a
general Settings product and appear only when database recovery is required.

## Release gates

The Alpha must not be offered as a public download until all of these have
current evidence for the exact source SHA and signed artifact:

1. shadow database migration and native asset transactions survive injected
   failure and force quit without exposing partial old/new state;
2. fresh-install write/restart/force-quit and update preservation on a clean Mac;
3. real-account Google Drive discovery, two-Mac convergence, restart, offline,
   reauthorization, revoke, quota/error, and resumable large-asset behavior;
4. Developer ID signing, notarization, stapling, Gatekeeper, updater signature,
   checksum, bundled notices, and public re-download verification;
5. public Privacy, Google Drive data-use, Known Issues, Support, source, license,
   feedback, and basic troubleshooting pages;
6. one real reviewed BYOK General Agent task if the Agent remains visible in
   release copy.

Automated tests, fake providers, local builds, simulators, and an unsigned DMG
are supporting evidence only. They cannot close the corresponding native,
real-account, or distribution gate.
