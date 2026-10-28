# Sentry operational diagnostics

Status: client integration and minified-browser HTTPS acceptance implemented;
account/project setup and live Mac/cloud acceptance remain open.
This milestone changes no service deployment, subscription or paused
Alpha release gate. See generated [acceptance](acceptance/sentry-observability.json).

The Sentry build-plugin dependency uses the patched `brace-expansion` 5.0.12
floor. Dependency auditing still reports pre-existing high/critical findings in
other dependencies; this milestone does not establish release security readiness.

## Scope and ownership

Hosted-capable builds may set a public `VITE_SENTRY_DSN`. Drifting then sends its
existing crash/integrity reports to Sentry instead of the Hosted diagnostics
endpoint. An unset DSN retains the existing endpoint and email behavior. The
Hosted service is independently operated; this change adds no private service
implementation or server-side SDK. The first milestone covers the Tauri Mac
renderer and previously recorded Rust panics. It does not capture OS crashes,
abort/kill signals, hangs or native crash symbols.

`installCrashReporting` remains the sole owner of global JS error/rejection
listeners; React's existing root boundary and caught integrity reports use the
same queue. An isolated BrowserClient with no instrumentation integrations
converts these reports to Sentry envelopes. It does not install a second global
error listener, capture console output, inspect DOM or record replay, tracing,
application metrics, request bodies, model calls or local variables.

## Privacy and delivery

The existing crash-report preference controls errors and operational logs.
Public local-only builds send neither, even with an inherited DSN. Development
needs `VITE_DRIFTING_CRASH_REPORTS_IN_DEV=1`. The SDK loads lazily on the first
enabled report/log, so unconfigured/local-only startup does not load it.

Outbound events are rebuilt from allowed fields: error kind, sanitized name and
message, app version/platform, release/environment, random diagnostic installation
ID and bundled JS frame locations. No Hosted bearer token, account email,
project ID, document state or arbitrary SDK scope is forwarded. Error-text
redaction is defense in depth; callers must never put prose or credentials in
errors. Native backtraces remain bounded diagnostic text, without symbolication.
Native reports use the version recorded at the panic, rather than attributing a
previous-version panic to the build that subsequently uploads it. They carry no
native build SHA, so their Sentry release identifies the version only.
The operator must disclose Sentry as a processor before enabling distribution;
Sentry necessarily receives network metadata. SDK IP inferral and automatic user,
cookie, HTTP, GraphQL, AI/MCP and variable collection are explicitly disabled.

Errors retain the existing 20-entry local queue, 30-report session limit and
one-hour suppression per fingerprint (including the first frame/column in Sentry
mode, so unrelated errors in a minified line are not collapsed). Network/5xx failures remain queued; 4xx
rejections are terminal. Collection checks consent and build capability separately
from connectivity, so an error first observed offline is retained without loading
the SDK. A report's deterministic event ID survives retries.
Every new network request rechecks consent and Hosted/network availability,
including SDK timer flushes. Reconnecting retries the queue. Reports disabled
while a request is in flight do not start another request from that drain.
Counts describe received reports, not the total number of failures or a crash
rate; no session denominator is collected in this milestone.

Operational logs are best effort, capped at 100 per application session. Only
update check/download/install and sync-cycle failure machine events are allowed,
with version/platform and optional byte/duration counts. The last 20 operations
also provide sanitized error breadcrumbs. Logs do not persist offline. Neither
diagnostic delivery nor failure blocks local writing or installation safety.

## Operator configuration

1. Create a Sentry project for the client; copy its public HTTPS DSN. Set
   `VITE_SENTRY_DSN` in ignored local configuration or operator build variables.
   The public DSN is routing data; an auth/upload token must never use `VITE_*`.
2. Use `pnpm dev:worktree --online --no-watch` for isolated Mac development,
   with a synthetic Hosted origin and explicit development-report opt-in. The
   launcher carries the DSN into that isolated profile. Standard desktop and
   Hosted lab launchers add only the DSN's exact HTTPS origin to `connect-src`.
   No broad wildcard or permanent public-source CSP exception is added.
3. For `pnpm tauri:build --online`, provide private CI variables
   `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`. Builds with a DSN fail
   before bundling if these inputs are missing. `VITE_SENTRY_ENVIRONMENT` defaults
   to `production`; `VITE_SENTRY_RELEASE` defaults to package version plus the
   full Git SHA (`DRIFTING_BUILD_REVISION` supplies provenance outside Git).
4. The final Vite plugin injects matching release/debug IDs, uploads hidden
   source maps and removes `dist/**/*.map` after upload. Upload errors fail the
   build. Token values are never injected into renderer code. CI should build
   from a clean checkout; a source SHA alone cannot describe uncommitted edits.
   Existing paused local-only release workflows remain paused and unchanged.
5. In Sentry configure production email alerts for new fatal/integrity issues
   and regressions, with throttling. Decide retention, quotas and optional paid
   spend limits in the Sentry account; no subscription is enabled by this code.

## Acceptance

`pnpm diagnostics:sentry:evidence` runs unit tests and the minified-browser
acceptance, generating source-fingerprinted reports. The unit suites cover SDK
packets, privacy policy, queue, updater and launcher boundaries.
`pnpm diagnostics:sentry:check` verifies both reports' freshness.

`pnpm diagnostics:sentry:browser` runs the browser checks independently and
generates [browser evidence](acceptance/sentry-browser.json). It builds a synthetic
fixture importing the production reporter, settings and runtime modules; the
official Vite plugin injects real Debug IDs with cloud upload explicitly disabled.
A disposable Chromium profile sends actual fetch/CORS requests to an isolated
loopback HTTPS receiver using a temporary certificate. Certificate exceptions and
request interception exist only in that disposable browser target. All network
destinations outside the fixture and receiver are blocked. No Sentry account,
real DSN or credential is used; certificates, source maps and browser data are
deleted when the run ends. OpenSSL and an installed Chromium are required.

Checks cover uncaught JS errors and promise rejections, exact original TypeScript
source-line resolution from emitted maps, log/breadcrumb privacy, opt-out after
initialization, offline collection followed by automatic online-event retry,
HTTP 503 retry with a stable event ID, and local-only silence with an inherited
DSN. Hidden maps are never served by the fixture. This verifies a production-mode
minified diagnostic fixture in Chromium, not the full app's packaged Mac WebView,
Sentry cloud symbolication, source-map upload/deletion or email delivery.

Before calling the hosted integration operational, create the project and verify
an actual packaged Mac build: throw a synthetic JS error from app code, resolve
its exact TypeScript source line in Sentry, inspect safe logs, receive one email,
test opt-out and failed/retried delivery, and confirm writing/restart preservation.
Upload success, real dashboard access, email delivery and Mac WebView acceptance
remain separate open gates. Backend errors/availability and broader server log
collection are the next milestone in the private service repository.

References: [Browser SDK](https://docs.sentry.io/platforms/javascript/),
[Vite maps](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/vite/),
[alerts](https://docs.sentry.io/product/monitors-and-alerts/alerts/).
