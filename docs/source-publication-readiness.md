# Source publication readiness

This document records source publication, its verification evidence, and the
pre-publication runbook retained for reference. It covers the source repository
only. Desktop and mobile binary distribution has separate release gates.

## Current decision

Status as of 2026-09-23: **[chihumyum/Drifting](https://github.com/chihumyum/Drifting)
is public as an early-development project, following explicit maintainer authorization**.

The published scope is the canonical client repository and its sanitized history.
The short README describes ongoing development without feature-completeness or
stability claims. Binary releases retain their separate acceptance gates. The
maintainer's repository-role bypass remains available for direct administration
of `main`.

## 2026-09-23 publication record

- Visibility changed to public at **2026-09-23 05:06:56 UTC** (13:06:56 in
  Asia/Shanghai). The frozen publication commit was
  `c3eda869a64e04c48c1dcd6a7a03491b1aaa1030`; the clean local checkout,
  `origin/main`, and remote `main` all resolved to that SHA. Only `main` was
  advertised; there were no tags.
- [Exact-commit CI](https://github.com/chihumyum/Drifting/actions/runs/35820432272)
  passed all six jobs. The first attempt hit a Chromium startup timeout before
  application checks; the failed job and its aggregate passed on retry with no
  code or assertion changes. Local validation passed 2,989 tests (one skipped),
  typecheck, lint, documentation navigation, and the CI contract.
- The clean-commit preflight and post-publication snapshot both passed. Gitleaks
  reported zero findings in the publishable tree and all 904 reachable commits;
  Git integrity and public/release boundaries passed. Production and development
  npm audits reported zero findings. The documented Linux GTK3 advisory
  `GHSA-wrw7-89jp-8q8g` remains open under the existing accepted-risk decision.
- Anonymous requests verified the repository, default branch, source tree and
  commit history. The publicly served README and license at the frozen SHA
  matched the local files byte for byte.
- Private vulnerability reporting was enabled immediately after publication and
  verified enabled. The active `Protect main (admins bypass)` ruleset, required
  `client`/`native` checks, deletion/force-push protections and administrator
  bypass were preserved. Actions retain read-only tokens and cannot approve PRs.
  Dependabot alerts remain enabled; automatic security-fix PRs remain disabled.
- Repository Actions secrets, variables, environments and webhooks remain empty.
  The predecessor remains private and archived. This operation created no binary
  release, tag or announcement.

The generated [post-publication verification snapshot](renderer-performance/acceptance/source-publication-verification.json)
records the frozen source fingerprint, scans and public GitHub settings. Recreate
a read-only snapshot with:

```bash
pnpm public:evidence --github --output=.local-data/source-publication/current.json
```

The root README links to the documentation index; capability and acceptance
checks validate the index's detailed-document links without requiring a feature
catalog on the project homepage.

## 2026-09-23 native follow-up

The [native acceptance report](qa/native-acceptance-2026-09-23.md) records fresh
desktop window checks, actual iPhone interaction and the simulator tooling
blocker. This change sets the iOS source-build minimum to 15.0, fixes the iOS 27
scene-adoption launch crash, and narrowly backports the upstream scene lifetime
fix. Simulator build/install passed; simulator interaction and complete native
keyboard/device/account acceptance did not.

Source may be published with the documented Desktop Alpha / experimental mobile
scope once the intended commit's CI and publication preflight pass and the
maintainer explicitly requests visibility change. The remaining signed binary,
real-account and device acceptance gates do not prevent accurately documented
source publication. No repository visibility or distribution action is performed
by this follow-up.

## 2026-09-21 preparation

This change completes the scoped security, contributor-onboarding and publication
record work. No native window, simulator, physical device, signed installer or
real-account acceptance was claimed. The repository remained private at that
preparation snapshot.

- All Tiptap editor packages move together from 3.30.1 to 3.30.5, including the
  optional React menu peers. The independent patched y-tiptap package is retained.
- Vitest moves to 4.1.11; locked XML and YAML dependencies move to
  `@xmldom/xmldom 0.8.15` and `js-yaml 4.3.2`. Scoped overrides prevent the affected
  transitive parser versions and keep Tiptap's optional peers aligned.
- `pnpm security:dependencies` audits production **and development** npm
  dependencies. Ordinary CI and the Alpha release validation fail on high or
  critical npm findings; advisory-service failure also fails the command.
- The headless renderer suite exercises actual DOCX, Markdown and text import,
  Unicode/format retention, corrupt-DOCX rejection and imported-editor undo/redo.
  Existing editor, Agent and graph behavior/resource checks run against the new
  dependency tree.
- The [contributor quick start](contributor-quick-start.md) explains setup from a
  clean clone, an author's own Xcode development certificate, and certificate-free
  source checks. `pnpm dev:check` checks the local signing setup. Desktop launch
  now reports missing/revoked certificates before starting Cargo/Vite, retaining
  revocation checks and revalidation immediately before executable launch.

Generated security and repository-setting evidence:
[source-publication-preparation.json](renderer-performance/acceptance/source-publication-preparation.json).
Reproduce it with:

Install `gitleaks` and authenticate GitHub CLI (`gh`) with read access to this
repository's settings first. The macOS preflight also needs the contributor's
own development certificate described above.

```bash
pnpm public:evidence --github --output=docs/renderer-performance/acceptance/source-publication-preparation.json
```

The generator audits both npm scopes, scans the publishable working tree and all
locally reachable Git history with redacted gitleaks, checks Git integrity and
public/release contracts, and reads GitHub settings without mutating them. It
records a source fingerprint and the parent commit when run on an uncommitted
candidate; it never rewrites that identity to a future commit. The report is a
preparation snapshot, not a visibility-change or binary-release acceptance.

The configuration review found private `main`, an active ruleset requiring
`client` and `native`, ordinary deletion/force-push protection with the existing
administrator bypass, read-only Actions tokens, and no ability for Actions to
approve PRs. No repository Actions secrets, variables, environments, webhooks,
issues/PRs, releases or deployments were present. Dependabot alerts are enabled;
automatic security-fix PRs remain disabled. The predecessor remains private and
archived. Private vulnerability reporting is unavailable while private and must
be enabled immediately after publication.

### Remaining Rust advisory

The earlier accepted `GHSA-wrw7-89jp-8q8g` decision remains in force. The locked
tree still reaches `glib 0.18.5` through `gtk 0.18.2`/`tauri 2.11.5` for Linux;
the macOS arm64 dependency tree does not include it. Keep the alert open and
revisit before supporting Linux or changing that dependency line. This is an
unsupported-target risk decision, not a proof that Linux callers cannot reach
the affected API. npm audit does not cover Rust dependencies.

### Handoff

Local validation passed: 2,989 tests (one skipped), typecheck, lint (no errors),
production renderer build, all six document-import checks, and 100 lifecycle
cycles per surface. Both production and development npm audit scopes reported
zero findings. Signing validation was a certificate/runner preflight only.

Read the [headless dependency regression](renderer-performance/acceptance/source-publication-regression.json)
and [resource-release regression](renderer-performance/acceptance/source-publication-lifecycle.json)
alongside the current commit's GitHub CI result. Human acceptance remains in
[desktop RC](qa/desktop-alpha-release-candidate.md) and
[two-Mac Drive](qa/google-drive-desktop-alpha-acceptance.md). After that review,
freeze the intended publication SHA and repeat the preflight below before an
explicit visibility change. Source visibility and installer distribution remain
separate decisions.

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

### 2026-08-26 decision: option 2 — accepted transitive risk, alert stays open

Evidence gathered against the current lockfile (`tauri 2.11.5`, `gtk 0.18.2`,
`glib 0.18.5`):

- `cargo tree -i glib` on the host target prints nothing; the crate only
  appears under `--target all`, through `glib -> atk -> gtk -> muda -> tauri`.
  macOS, iOS, and Android binaries never compile the vulnerable code, and those
  are the only release-supported targets (`KNOWN_ISSUES.md`).
- Option 1 is not currently possible: the advisory is fixed in `glib >= 0.20`,
  but the `gtk 0.18` line (the final GTK 3 release of gtk-rs) requires
  `glib ^0.18`, and Tauri 2's Linux backend is pinned to GTK 3. No compatible
  upstream fix exists to upgrade to.
- The unsoundness is in `glib::VariantStrIter`; the application has no direct
  call, and the alert therefore describes a Linux-only, not-attacker-reachable
  transitive surface for builds this project does not ship.

The alert deliberately remains open on the dashboard as a tracking signal.
Revisit triggers: before declaring any Linux build release-supported, or when
the Tauri Linux dependency line moves off `gtk 0.18`/`glib 0.18`.

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

This is the pre-publication runbook retained for reference. The completed
publication and its exact-commit evidence are recorded above.

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
