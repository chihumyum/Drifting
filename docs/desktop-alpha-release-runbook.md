# Desktop Alpha release runbook

This runbook is fail-closed. A checkbox is evidence only when it names the
date, operator, Apple Silicon device, macOS version, exact commit, build tag,
artifact SHA-256, and evidence location. Automated tests never substitute for
the real-account or signed-device rows.

## Candidate preparation

1. Freeze feature work and update `docs/releases/<version>.md` and
   `KNOWN_ISSUES.md`.
2. Run `node scripts/check-alpha-release.mjs app-v<version>`, `pnpm
   public:check`, `pnpm agent:capabilities:check`, lint, typecheck, tests,
   renderer build, Cargo formatting, checks, and tests.
3. Complete the Drive and desktop RC records for the candidate SHA.
4. Confirm the production Google project is External and In Production, the
   OAuth consent links are anonymously accessible, and only `openid` and
   `drive.appdata` are requested.
5. Confirm the repository is public and LICENSE, PRIVACY, NOTICE, SECURITY,
   Support, Known Issues, source, and release pages are anonymous-readable.
   The tag workflow independently curls the drifting.app homepage, `/privacy`,
   `/google-drive-data-use`, `/quick-start`, `/support`, and `/known-issues`
   anonymously before the signed build starts; any unreachable page fails the
   whole workflow closed.

## Immutable release

1. Create the immutable signed tag `app-v<version>` on the accepted SHA.
2. The tag workflow reruns exact-SHA CI in a secret-free job.
3. The protected `alpha-release` environment imports the Developer ID
   certificate, notarization key, production OAuth values, and updater signing
   key; it builds arm64 only and creates a draft prerelease.
4. Review every asset, SBOM, THIRD_PARTY_NOTICES.md, checksum, updater
   signature, signing, notarization, staple, mount, and first-launch result.
   Publish the draft only after review.
5. Re-download the public DMG and updater archive, verify SHA-256, `codesign
   --deep --strict`, `spctl`, staple, mount, launch, and one real update.
6. Manually dispatch `Promote Alpha updater channel` for that published tag.
   The protected environment verifies the release before publishing
   `/updates/alpha/latest.json`. Never use GitHub `/releases/latest` for Alpha.

## Stop conditions

Do not publish or promote the channel for data loss, partial restore, corrupt
database, duplicate Drive project, permanent sync blockage, wrong-account
credential replacement, invalid signature/notarization, failed migration
safety snapshot, or an updater that modifies the app without explicit
confirmation.
