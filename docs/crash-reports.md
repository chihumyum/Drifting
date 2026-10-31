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
| `renderer-error`, `unhandled-rejection` | uncaught errors and rejections (`installCrashReporting` in `main.tsx`) | error |
| `render-failure` | the root error boundary replaced the UI (`App.tsx`) | fatal |
| `native-panic` | a Rust panic recorded by `src-tauri/src/crash_reports.rs`, sent on the next launch | fatal |
| `integrity` | `database-open-failed:<code>` (recovery screen), `yjs-load-failed`, `local-flush-failed` (quit or update install), `sync-blocked:<code>` (a non-retryable sync stop other than sign-out, cancellation or project deletion) | fatal for the database, otherwise error |

Nothing is sent when the build has no Hosted service (public local-only source
builds), in development builds (unless `VITE_DRIFTING_CRASH_REPORTS_IN_DEV=1`
for acceptance against a local service), or when the author turns off
Settings → Privacy → Send crash reports automatically. The setting defaults on
and is disclosed in the first-launch guide (`preAlphaGuide.crashReports`, guide
v6). With reports off, recorded native panics are still taken and discarded.

## What a report contains

Kind, severity, a grouping fingerprint (kind, error name and the first frame's
file stem, or a stable integrity code), error name, a sanitized message,
stack frames only, app version, platform, a random diagnostics-only installation
ID, the time, and a few context values (for example the flush reason or the
Yjs document family, never an identifier or text). A signed-in Hosted session
adds the account so the maintainer can follow up.

`crash-sanitize.ts` truncates messages to 300 characters, replaces runs of 12 or
more CJK characters, quoted spans over 40 characters and runs of 13 or more
words with `[text]`, replaces home-directory paths with `~`, and keeps only stack
frame lines. Native panic records replace the home directory and are bounded to
12 KiB per field before they are written.

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
