# Crash and integrity reports

Optional Sentry routing, operational logs, privacy filtering, source maps and
remaining deployment gates are documented in [Sentry diagnostics](sentry-observability.md).
When `VITE_SENTRY_DSN` is configured, reports go to Sentry and do not carry the
Hosted account bearer or email. Otherwise the endpoint described below remains
the delivery path.

Hosted-capable builds send content-free reports when Drifting fails, so the
maintainer hears about problems without asking authors for logs. The service
side (storage, operator email, retention) is specified in the Hosted service's
`docs/diagnostics-v1.md`.

## When a report is sent

`src/renderer/services/diagnostics/crash-reporter.ts` reports:

| Kind | Source | Severity |
| --- | --- | --- |
| `renderer-error`, `unhandled-rejection` | uncaught errors and rejections (`installCrashReporting` in `main.tsx`); a rejection that is a `DatabaseOpenFailure` is left to the failure screen | error |
| `render-failure` | an error boundary replaced the window (`scope: app`, `App.tsx`) or the open project's workspace (`scope: workspace`, `ProjectRuntimeProvider.tsx`) | fatal |
| `native-panic` | a Rust panic recorded by `src-tauri/src/crash_reports.rs`, sent on the next launch | fatal |
| `integrity` | `database-open-failed:<code>` (the failure screen, see below), `yjs-load-failed`, `local-flush-failed` (quit, update install, or `reason: sync-cycle` when a sync cycle's durability barrier meets a failed local write; that cycle is retried), `sync-blocked:<code>` (a non-retryable sync stop other than sign-out, cancellation or project deletion) | fatal for the database, otherwise error |

Nothing is sent when the build has no Hosted service (public local-only source
builds), in development builds (unless `VITE_DRIFTING_CRASH_REPORTS_IN_DEV=1`
for acceptance against a local service), or when the author turns off
Settings → Privacy → Send crash reports automatically. The setting defaults on
and is disclosed on first launch (`preAlphaGuide.crashReports`): the first-run
welcome card, which every author passes whether they sign in or continue
locally, ends with one line, "By continuing, you agree to the terms", and the
hover card on "the terms" says that fault reports are sent and where to turn
them off, above rows that open the terms and the privacy policy
(`features/auth/ConsentLine.tsx`, 2026-11-13; before that the sentence itself
was the card's last line). The sign-in flow carries no such line: its sign-up
form names the terms and the privacy policy in its own sentence. With reports
off, recorded native panics are still taken and discarded.

## What a report contains

Kind, severity, a grouping fingerprint (kind, error name and the first frame's
file stem, or a stable integrity code), error name, a sanitized message,
stack frames only, app version, platform, a random diagnostics-only installation
ID, the time, and a few context values (for example the flush reason or the
Yjs document family, never an identifier or text). A signed-in Hosted session
adds the account so the maintainer can follow up.

Hosted reports include the OS version (`context.osVersion`) when the native
shell has supplied it. A packaged renderer also records the source revision
(`context.buildId`), taken from the Git checkout or a hexadecimal
`DRIFTING_BUILD_REVISION` supplied by the build. A native panic uses the
app version recorded at the crash, has no build revision, and records the OS
version of the next launch when available. Reports already on disk keep their
original fields.

A `render-failure` also names its boundary (`scope`) and, as `component1` to
`component8`, the innermost component frames of React's component stack that
carry a source position (`componentStackContext`). An error React itself throws,
such as an update loop (#185), has only React's own frames on its stack; before
2026-11-14 such reports arrived with an empty context.

Release builds ship no source maps. To read a release's positions, check out
its tag, install with `pnpm install --frozen-lockfile`, and run
`pnpm exec vite build --config vite.renderer.config.ts --sourcemap hidden` with
the release's renderer variables (`VITE_LOCAL_ONLY_MODE=false`,
`VITE_REQUIRE_AUTH=false`, `VITE_AI_TRANSPORT=direct`, `VITE_CLOSED_BETA=false`,
`VITE_API_BASE_URL` set to the Hosted origin, `VITE_TERMS_URL`,
`VITE_PRIVACY_URL`) and nothing else. When the asset names in the report
(`index-<hash>.js`, `project-route-components-<hash>.js`) match the build's,
the bundle is byte-identical and its maps resolve the frames.

A `native-panic` carries the panicking thread, the panic's `location`, the
version that crashed (`crashedVersion`) and when it crashed (`crashedAt`): the
report itself goes out on a later launch, so its own time is that launch's.
When a step of the Tauri `setup` hook in `src-tauri/src/lib.rs` fails, Tauri
panics at its own `app.rs` with "Failed to setup app: error encountered during
setup hook: " in front of the error; `setupStep` then names the step
(`database-gateway`, `deep-link`, `webview-configure`, `window-fit`,
`window-show`, `tray`, `media-devices`, `ios-window`; see
`crash_reports::enter_setup_step`). A panic inside a step on the thread running
it carries the step too. What fails before the panic hook is installed (the
windows created from the configuration, plugins, the data folders) leaves no
record. Reports before 2026-11-17 have neither field, and their message was
usually `[text]` (see below).

An `AggregateError` or an error with a `cause` lists what it was made of after
its own message, one bracket per level: up to three inner errors per level and
three levels deep, each as `Name: message` (or the bare string a native command
rejected with), sanitized like the message. The local durability barrier names
the steps that failed in its message, for example
`1 local persistence step(s) failed: session-token [AggregateError: … [secure storage write failed]]`.
A failed database statement (Drizzle's `Failed query: <sql> params: <values>`)
is reported as its statement and table followed by the database's reason, for
example `Failed query: insert into "element" [Error: FOREIGN KEY constraint failed]`;
its values are the author's data and are never sent. Before 2026-11-19 the
whole statement filled the 300 characters and the reason was cut off.

`crash-sanitize.ts` truncates messages to 300 characters, replaces runs of 12 or
more CJK characters, quoted spans over 40 characters and runs of 13 or more
words with `[text]` (a framework's fixed wording at the start of a message, such
as Tauri's "Failed to setup app" sentence, is kept and not counted, so the short
error after it survives), replaces home-directory paths with `~` (the macOS, Linux
and Windows forms, a Windows account name with spaces included), and keeps
only stack frame lines. Native panic records replace the home directory and are
bounded to 12 KiB per field before they are written.

## A library that cannot be opened

Every failed `database_open` reaches the renderer as a `DatabaseOpenFailure`
(`crates/drifting-core/src/database.rs`, `recovery_failure`) and replaces the
app with the failure screen (`DatabaseRecoveryBoundary`), whether or not an
upgrade left something to restore. Before 2026-11-14 only a stopped upgrade
did; any other failure drew the shelf over a closed database, reported
`unhandled-rejection:DatabaseOpenFailure` with the fixed sentence "could not
open the local library database" and nothing else, and never checked for
updates, because that check waits for the library.

- `code` is the step that stopped. For a stopped upgrade it is the recovery
  stage's code (`migration-candidate-failed`, `activated-database-invalid`, …).
  For any other failure it is the clause that opens the native error, as a
  token of at most 64 characters: `failed to enable WAL mode: database is
  locked` gives `failed-to-enable-wal-mode`. Errors on the open path begin with
  such a clause, so rewording one changes its report group.
- `detail` is what that step reported, at most 400 characters, with the
  library's own folder replaced by `<library>` (SQLite and the operating system
  name the files they could not reach). A stopped upgrade carries the detail of
  its stage on the launch that stopped it; a later launch reads the receipt,
  which holds the code only.
- The report is `integrity`, fatal, `database-open-failed:<code>`, with
  `sourceVersion`, `targetVersion`, `safetyBackup` and `cause`: the detail after
  its leading clause, which the code already names. Splitting it keeps a long
  clause plus a short cause from reading as a 13-word sentence and being
  redacted whole. An operating-system message in Chinese may still become
  `[text]`; its `(os error N)` survives.
- The screen shows the code and the detail. With nothing to restore it offers
  a retry (a reload), the folder that holds the database
  (`database_open_directory`), feedback, the diagnostic summary and exit; a
  stopped upgrade keeps its restore actions and gains feedback.
- The screen checks for an update as it appears and installs one from there.
  Installing normally refuses to start until every local write is saved; with a
  failed open published that barrier no longer blocks it (a failure is still
  reported, `reason: update-install-library-closed`), since a newer release may
  be the only way back into the library.

`database-open-failure.acceptance.test.ts`, `db-open-failure.test.ts` and the
`open_failure_*` and `stopped_upgrade_*` tests in `database.rs` hold this.

## Delivery

Reports go to `POST <API_BASE_URL>/api/diagnostics/v1/reports`. Each fingerprint
is sent at most once an hour per session, at most 30 per session. Unsent reports
wait in local storage (20 at most) for the next launch; reports the service
rejects (4xx) are dropped. Native panics are written to
`diagnostics/native/` next to the databases directory, at most 20 at a time, and
removed once the renderer takes them.

## Crash follow-ups

When a `render-failure` or `native-panic` report reaches the service (or
Sentry), the client keeps its fingerprint, time and the id the service
returned (`drifting.diagnostics.follow-ups.v1`, five at most). A render failure
waits for a later launch; a native panic is already reported on the launch
after the crash. Once that launch's native panics and queue have been sent
(`crashReportsSettled`), `offerCrashFollowUp` takes the newest ready one and
puts a single `crash-follow-up` notification in the notification center; older
ones are retired, so each report is offered once at most and never twice in
one launch. Reports that were never sent (reports off, no service, rejected,
still queued) are never offered. While the notification is unread the bell
keeps its warning seal.

Its row opens the feedback dialog as a follow-up: the crash time as the
kicker, the message asks what the author was doing, and **Ignore** retires the
notification. Closing the dialog keeps it. The note is sent as feedback with
`kind: "crash-follow-up"` and the report's id and fingerprint.

## Feedback

`services/diagnostics/feedback.ts` and `features/feedback/FeedbackDialog.tsx`.
The dialog opens from the account menu, Settings → About and a crash
follow-up. It holds the author's message (up to 5000 characters), a reply-to
address (the signed-in account's email by default; optional, validated as one
plain address) and a switch, on by default, for the sanitized diagnostic
summary of Settings → Privacy, which the dialog takes once as it opens and can
preview. ⌘↩ sends.

Feedback is sent on purpose, so it ignores the automatic report switch. With a
Hosted service and a network it goes to
`POST <API_BASE_URL>/api/diagnostics/v1/feedback` (`drifting.feedback` v1, the
service's `docs/diagnostics-v1.md`), with the session when signed in; the
service stores it and emails the maintainer with the author's address as
Reply-To. Local-only builds, development builds without
`VITE_DRIFTING_CRASH_REPORTS_IN_DEV=1`, an offline Mac and a failed send all
hand the same message, the version and, when attached, the summary to the mail
client as a `mailto:` to the support address. Nothing from the manuscript, the
database or the Keychain is read; `feedback.test.ts` guards the payload and the
imports.
