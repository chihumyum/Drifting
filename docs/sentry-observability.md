# Sentry operational diagnostics

Status: client integration, minified-browser HTTPS checks and live Sentry
error/log/source-map acceptance and isolated signed Mac Debug package acceptance
completed on 2026-10-29. The owner confirmed receipt of the test alert email.
Notarized production distribution and CI rollout remain open.
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
with version/platform, bounded release/environment identifiers and optional
byte/duration counts. Deployment identifiers survive privacy filtering so logs
can be filtered by environment and release. The last 20 operations
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

## Connected operator project

The `drifting/drifting-client` React project is provisioned. Its active public DSN
and project identifiers are configured in this worktree's ignored `.env.local`;
the OAuth/upload token stays in the Sentry CLI credential store. Other checkouts
and CI still need their own operator configuration. No token or DSN is recorded
in this document or the generated evidence.

The [test issue](https://drifting.sentry.io/issues/7816942043/) is
`DRIFTING-CLIENT-1`, `DriftingSentrySetupError: Drifting Sentry setup verification 20261029`.
The [email alert](https://drifting.sentry.io/monitors/alerts/6249230/) covers new
issues and regressions at `error` or higher, sends only to the account owner and
throttles each issue to 30 minutes. It currently covers all environments,
including the explicitly named `sentry-acceptance` canary environment. Development
reporting still requires the separate opt-in described above. The owner confirmed
the email arrived after the initial receipt check.

For a local operator build, the logged-in CLI can supply a short-lived token
directly to the child build process without saving it in `.env.local`:

```sh
SENTRY_AUTH_TOKEN="$(pnpm exec sentry auth token)" pnpm tauri:build --online
```

This is a build command, not a release deployment. CI needs a separately managed
upload credential. Neither CI secrets, distribution nor a paid plan was enabled.

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

Before production rollout, verify an actual packaged Mac build: throw a synthetic
JS error from app code, resolve its exact TypeScript source line in Sentry,
inspect safe logs, test opt-out and failed/retried delivery, and confirm
writing/restart preservation. The live Debug acceptance below closes the cloud
connection and email checks while leaving the packaged-release checks open.

The live [cloud evidence](acceptance/sentry-cloud.json) records a freshly compiled,
isolated Tauri Debug host launched with `pnpm dev:worktree --online --no-watch
--instance sentry-cloud`. A temporary local Vite middleware served the full
production-minified renderer over that profile's loopback HTTP URL. A temporary
app bootstrap canary, guarded by the native Tauri runtime, threw an uncaught error
after initialization. Sentry resolved the exact TypeScript source and line from
the uploaded maps, reported no event-processing errors, received the synthetic
operation log and evaluated the email rule. No `.map` files remained in the local
frontend artifacts after upload. A second run fixed and verified environment
filtering for logs. Both temporary source modifications were restored afterwards.
The build evidence records the baseline commit, changed diagnostic-source hashes
and temporary-canary hashes; a commit alone does not describe this test build.
Logs use the search attributes `sentry.environment` and `sentry.release`; for
example, `sentry.environment:sentry-acceptance` selects the canary logs.

`pnpm diagnostics:sentry:cloud --org <org> --project <project> --issue <id>
--alert <id> --manifest <ignored-canary-manifest.json> --artifacts dist` re-queries
the authenticated API and logs, verifies the exact source line, active DSN and
artifact hashes, then generates allowlisted evidence. `--email-received` records
the separate human confirmation; the API cannot prove mailbox receipt. The
ignored manifest is produced during an operator's temporary app canary and records
its release, environment, exact source line, Git revision and source/artifact hashes.
The command does not create an error or deploy an app. Historical cloud evidence
is not a substitute for repeating acceptance on a later release.

The original live run establishes the Mac WebView pipeline over loopback HTTP.
The separate packaged acceptance below adds the embedded `tauri://` path;
neither run establishes a notarized public release or production CI.

## Isolated Mac test package

`pnpm dev:worktree --build-app --online --no-watch --instance <name>` builds a
signed Debug `.app` with the production-minified renderer embedded. It uses a
different profile from the equivalent development launcher, including a separate
application identifier, native database, Keychain service and Cargo target.
The package uses its identifier's normal Application Support database location,
so launching it from Finder requires no environment variables. Its WebView is
persistent to permit preference/restart acceptance; the daily-use application
identity and data remain separate. `--print-config` reports the local artifact
and database paths without creating files. `--build-app` currently supports macOS.

An explicit `DRIFTING_SENTRY_PACKAGED_ACCEPTANCE=1` build, together with the
`sentry-acceptance` environment and a configured DSN, injects an operator-only
entry from `scripts/sentry-packaged-acceptance.ts`. It refuses to run outside a
packaged `tauri://` window with a worktree application data identity. Normal
builds contain none of its controls; `pnpm frontend:debug:check` verifies the
acceptance marker is absent. No global debug bridge is added to distributed code.

The [packaged evidence](acceptance/sentry-packaged.json) records the main snapshot,
changed build/runtime source hashes and exact executable/frontend hashes. A
synthetic library was seeded before launch. Native UI actions opened a chapter,
typed a synthetic marker through the editor, flushed the ordinary persistence
barrier, exited normally and relaunched the same bundle. The marker remained
visible in the reopened editor and in the canonical Yjs read. The crash-report
preference also remained disabled across relaunch.

The package's initial JS error and operation log reached Sentry. Its
[cloud issue](https://drifting.sentry.io/issues/7816992193/) has original TypeScript
frames resolved from the uploaded maps. With reporting off, the error/log probe
made no Sentry request. A connection failure injected only for the Sentry
destination retained one error; restoring the real HTTPS connection sent the
same event ID and emptied the queue. The system's network was not disconnected.
No source maps remained in either the frontend directory or app bundle.

`pnpm diagnostics:sentry:packaged --manifest <ignored-packaged-manifest.json>`
checks the signed app, source/artifact hashes, app-generated observations in its
own WebKit SQLite storage, and both cloud event IDs plus the operational log.
It writes only allowlisted results; no storage dump, document text, token or
personal filesystem path enters the report. The test bundle uses local Apple
Development signing and is not notarized. Normal exit/relaunch is distinct from
process termination or power-loss durability. Production CI, public distribution,
private-service instrumentation and external availability monitoring remain open.

References: [Browser SDK](https://docs.sentry.io/platforms/javascript/),
[Vite maps](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/vite/),
[alerts](https://docs.sentry.io/product/monitors-and-alerts/alerts/).
