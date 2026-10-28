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
