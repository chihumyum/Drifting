# Mac Hosted acceptance — 2026-09-30

The author narrowed this milestone to Mac. All accounts and writing used for
interactive acceptance were synthetic. Two independent Tauri app instances ran
on one physical Mac, with separate SQLite libraries and credential services.
This is local Docker acceptance, not two physical computers or a public release.

| Gate | Observed result |
| --- | --- |
| Local writing | Created a project and chapter, pasted Chinese paragraphs, saved and saw the rendered prose. This covers paste, not physical Chinese IME composition. |
| Initial Hosted publication | Signed in and connected one local project. A separate PostgreSQL query confirmed native-uploaded genesis, segment and snapshot-commit objects. |
| Fresh Mac instance | Signed into the same account in the peer app; connected and restored the project, chapter and exact Chinese text. |
| Reverse writing | Appended Chinese text in the peer; it appeared automatically in the first app. |
| Concurrent offline writing | Stopped the API container, appended different paragraphs in both clients, then restarted the service. Both paragraphs were retained and merged into the same chapter. |
| Offline application restart | Quit and reopened the first app while the API remained stopped. The local project and saved prose opened. Appended another paragraph, restarted the service, and observed that paragraph in the peer without signing in again or pressing Sync now. |
| Final account code | Opened the final Mac bundle, confirmed restored account identity, signed out, returned to the retained 105-character local project, then signed in again successfully. |
| Source verification | Final full suite: 450 passing files / 3,155 passing tests; 2 skipped files / 4 skipped tests. Typecheck, CI contract, public boundaries and 19 Agent capability checks passed. Full lint has 0 errors / 70 warnings. The later touched-file lint has 0 errors / 1 existing warning. |
| Hosted protocol verification | The generated client report records 39 passing cases, including actual HTTP, independent SQLite files, Drive adoption rollback/retry, old-history retention, asset bytes, bounded history inserts and account-request races. Object staging/asset installation in these tests use explicit synthetic ports. |
| Native and service checks | Native origin/path validation passed. Both ad-hoc Mac bundles built. Private service check passed; its 8-case report includes restart, concurrent pagination/account isolation and isolated PostgreSQL backup restoration. Credential scans passed for both repositories. |

## Defects repaired during acceptance

- Account/Keychain hydration no longer blocks opening local writing.
- Lab app identities use separate credential services from the original client.
- Shelf settings now exposes Account settings.
- Hosted settings and avatars use the Hosted identity rather than the local DB owner.
- Sync now waits for runtime activation and a complete fresh cycle.
- Offline startup retries session verification on focus and periodically; a service
  restart does not need a browser online event.
- Stale authentication responses cannot replace credentials or rebind a signed-out
  session. Account changes are checked again before publishing/restoring data.
- The explicit Drive-local-replica takeover has independent generations and an
  atomic, retryable local boundary; it needs no Google request.

## Dogfooding observations still open

- Shelf word counts can remain at their previous cached value until the affected
  chapter is opened. The authoritative Yjs prose and editor count were correct.
- Physical Chinese IME, a second physical Mac, internet deployment and notarized
  distribution are separate acceptance gates. This milestone claims none of them.

The author's existing library was only inspected for sync metadata/counts; it was
not switched, uploaded or reset by this acceptance run. The lab keeps its synthetic
library and account. The Docker service remains available locally.

Mobile is deferred at the author's request. Before that scope change, a simulator
archive had built and launched, but simulator login/writing and physical mobile
acceptance were not completed. Those observations do not expand the Mac milestone.

## Local writing and account entry follow-up

The configured Mac app now offers Continue locally or Sign in and sync. The
latter connects the existing library after verified login; errors remain
retryable without replacing SQLite. Account-menu logout returns to the local
shelf, and an expired cached profile offers sign-in rather than a false logout.
Public source without a configured service still defaults to service-disabled.

- A rebuilt ad-hoc Mac lab launched, entered local writing without reauth and
  imported 20 ordered Markdown chapters and 7 reference documents. All persisted
  Yjs visible text matched the parsed sources; chapter paragraph counts and order
  also matched. Verification and backups of author data remain outside the repo.
- Signing into the local test account resumed publication. The independent peer
  library restored all chapters and materials, with the same text verification.
- The receiving app signed out and opened downloaded chapter prose from SQLite.
- The updated primary signed out, saved a synthetic Chinese paragraph by paste,
  typed `#` plus Space and an English heading, then quit and cold-started. Both
  the paragraph and the level-one heading were present in Yjs and in the editor.
  Physical Chinese IME composition is still not claimed.
- These local writing, import, login and restart actions showed no Keychain
  authorization prompt. A further cold restart restored the signed-in session
  without re-entry or an OS prompt. The app-owned installation marker was version 2.
- Source regression passed 453 test files / 3,163 tests, with 2 files / 4 tests
  skipped. Typecheck passed; full lint had 0 errors / 70 existing warnings.
  The final small account-menu correction passed its targeted lint and boundary
  suite; the generated Hosted report has 46 passing cases and a current source
  fingerprint. Native identity tests (4) and restricted local-lab session tests
  (2) passed. CI/public boundaries and Agent capability checks passed.

Native regression commands:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib installation_identity
cargo test --manifest-path src-tauri/Cargo.toml --lib local_lab_session
pnpm hosted:acceptance
pnpm hosted:acceptance --check
```

This remains one physical Mac with two separate app libraries and a local Docker
service. The novel acceptance is personal dogfooding, not a redistributed test
fixture. Release signing, internet deployment and mobile remain separate gates.
