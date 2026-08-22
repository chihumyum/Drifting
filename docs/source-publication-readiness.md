# Source publication readiness

This document records the current source-publication decision, the work already
completed, and the exact checks to repeat before changing the canonical GitHub
repository from private to public. It covers publication of the source
repository only. Desktop and mobile binary distribution has separate release
gates.

## Current decision

Status as of 2026-08-19: **publication intentionally deferred by the
maintainer**.

The canonical repository remains private. Do not change its visibility until
the maintainer explicitly asks to publish it. Do not open a pull request solely
to prepare or perform publication; the maintainer's repository-role bypass is
intentionally retained for direct administration of `main`.

## 2026-08-19 preparation snapshot

The following work is complete at commit
`7378305f10d58155d08ac2bca9f3d497f2f6a89c`:

- the replacement canonical repository is named `Drifting`, with `main` as its
  default branch;
- the predecessor repository remains private and archived, and is not the
  publication target;
- the intended client history, documentation, CI, and repository rules were
  migrated to the replacement repository;
- the canonical repository has no pull requests or issues created during the
  replacement;
- the maintainer explicitly permits publication of the Git author/committer
  email identities retained in the current history; do not rewrite history
  again solely for email privacy;
- the `Protect main (admins bypass)` ruleset blocks deletion and non-fast-forward
  updates, requires the `client` and `native` checks, and gives the repository
  administrator an `always` bypass;
- repository Actions use a read-only default token and the repository has no
  Actions secrets, variables, or environments;
- Dependabot alerts are enabled, while automated security fixes remain disabled
  so GitHub cannot create unsolicited security-update pull requests;
- `pdfjs-dist` was upgraded to `6.2.108`; both high-severity alerts for
  `GHSA-hq66-cqwq-w95j` are fixed;
- the exact-SHA `client` and `native` CI jobs passed in GitHub Actions; and
- the local tree, `origin/main`, and GitHub `main` resolved to the same commit.

The preparation audit also passed:

```bash
pnpm install --frozen-lockfile
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
pnpm audit --prod --audit-level high
gitleaks git --no-banner --redact .
git fsck --full --no-dangling
```

The renderer production build passed with the same explicit local-only
environment used by CI. The workflow run for the snapshot is historical
evidence, not permission to skip the checks on a later publication candidate.

## Known item to revisit

Dependabot currently reports `GHSA-wrw7-89jp-8q8g` against `glib 0.18.5` as a
medium-severity alert. It enters the all-target lockfile through the latest
Tauri 2 Linux GTK 3 dependency line:

```text
tauri 2.11.5 -> gtk 0.18.2 -> glib 0.18.5
```

The application does not directly call `glib::VariantStrIter`, and `glib`
cannot be upgraded independently because `gtk 0.18.2` requires `glib ^0.18`.
Before publication, re-check the current Tauri/GTK dependency line and then do
one of the following with an evidence-backed rationale:

1. upgrade the upstream dependency line if a compatible fix exists;
2. keep the alert open and document the accepted transitive risk; or
3. dismiss it as not used only if the Linux call path has been reviewed and the
   dismissal comment records that evidence.

Do not dismiss the alert merely to make the security dashboard show zero.

## 2026-08-20 Alpha release preparation

The working Alpha implementation adds an exact-tag release check, SHA-pinned
Actions, draft signed/notarized arm64 artifact workflow, SBOM/checksum/NOTICE
assets, and a separately protected updater-channel promotion workflow. These
changes are implementation, not publication evidence: they are not complete
until committed, reviewed, run on the exact tag, and revalidated anonymously.

The release environments intentionally add secrets that were absent from the
historical 2026-08-19 snapshot. `alpha-release` may contain only the production
Desktop OAuth client, Developer ID certificate, App Store Connect
notarization key, and updater signing material. `alpha-channel` protects only
the manual promotion. Neither environment may expose secrets to pull-request
workflows, and ordinary CI keeps read-only contents permission.

## Publication preflight

Run this checklist on the exact commit intended to become public.

### Repository and history

- [ ] Record `git rev-parse HEAD` as the frozen publication SHA.
- [ ] Confirm `git status --short --branch` is clean and aligned with
      `origin/main`.
- [ ] Confirm `git ls-remote origin refs/heads/main` resolves to the frozen SHA.
- [ ] Confirm the publication target has only the intended public branches and
      tags.
- [ ] Confirm the predecessor repository remains private and archived.
- [ ] Run both working-tree and complete reachable-history secret scans:

  ```bash
  gitleaks dir --no-banner --redact .
  gitleaks git --no-banner --redact .
  git fsck --full --no-dangling
  ```

- [ ] Re-read [`public-history.md`](public-history.md) and confirm that the
      disclosed provenance still matches the reachable history.

### Source boundary and licensing

- [ ] Run `pnpm public:check`.
- [ ] Confirm ignored local files such as `.env.local`, local databases,
      credentials, manuscripts, screenshots, and generated artifacts are not
      tracked.
- [ ] Re-check `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`,
      `TRADEMARKS.md`, `THIRD_PARTY_NOTICES.md`, and package-specific licenses.
- [ ] Confirm README feature and availability claims match the current product
      and acceptance documents.

### Build, tests, and dependency security

- [ ] Install from the frozen lockfiles and run the same `client` and `native`
      commands as [CI](../.github/workflows/ci.yml).
- [ ] Confirm the GitHub Actions run for the frozen SHA finishes successfully;
      do not substitute a run for an earlier commit.
- [ ] Run `pnpm audit --prod --audit-level high` and review every open
      Dependabot alert, including Rust lockfile alerts not covered by pnpm.
- [ ] Run `node scripts/check-alpha-release.mjs app-v<version>` and confirm every
      third-party Action remains pinned to a 40-character commit SHA.

### GitHub configuration

- [ ] Confirm the repository is still private before the final approval.
- [ ] Confirm there are no unintended pull requests, issues, releases,
      deployments, Actions secrets, variables, environments, webhooks, or
      installed apps.
- [ ] Confirm Actions default workflow permissions remain read-only and cannot
      approve pull requests.
- [ ] Confirm the default-branch ruleset still requires `client` and `native`,
      blocks deletion and force pushes for ordinary contributors, and retains
      the administrator's `always` bypass.
- [ ] Confirm Dependabot alerts are enabled and automated security fixes remain
      disabled unless the maintainer explicitly changes the no-automatic-PR
      policy.

## Visibility-change sequence

Only perform these steps after explicit maintainer approval:

1. Re-confirm the frozen SHA, clean status, successful exact-SHA CI, and the
   open-alert decision.
2. Change the canonical repository visibility to public.
3. Immediately enable GitHub Private vulnerability reporting. GitHub exposes
   this setting only after a repository is public.
4. Verify from a signed-out request that the repository name, default branch,
   README, license, source tree, and history are visible as intended.
5. Re-query the ruleset, Actions permissions, Dependabot settings, and Private
   vulnerability reporting state; do not assume a visibility change preserved
   every setting.
6. Record the publication timestamp, frozen SHA, CI URL, security-scan result,
   and GitHub-setting verification in this document.

If any post-change verification fails, stop publication work and report the
exact mismatch before making unrelated repository changes.

## Separate binary-release boundary

Making this repository public does not approve an official installer or app
store release. Binary distribution still requires the platform acceptance,
verified mobile link, signing/notarization, operator-policy, bundled-license,
and real-account gates documented in:

- [`../README.md`](../README.md#licensing-and-project-policy);
- [`qa/tauri-native-manual-regression.md`](qa/tauri-native-manual-regression.md);
- [`qa/desktop-alpha-release-candidate.md`](qa/desktop-alpha-release-candidate.md);
- [`qa/google-drive-desktop-alpha-acceptance.md`](qa/google-drive-desktop-alpha-acceptance.md);
- [`../src-tauri/UNSUPPORTED.md`](../src-tauri/UNSUPPORTED.md); and
- [`sync-engine/trusted-cloud-google-drive.md`](sync-engine/trusted-cloud-google-drive.md).

Those gates do not block publication of accurately documented source code.
