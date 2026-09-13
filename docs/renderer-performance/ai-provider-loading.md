# AI provider code on first request

The default client factory and public AI barrel previously imported Google and
OpenAI SDKs even before a model request. The existing synchronous provider
constructors now create small facades. Their complete/stream calls load the
selected implementation, then delegate to the original adapter. The moved
Google, OpenAI and DeepSeek runtime files are byte-for-byte identical to their
`8f17a6c5` versions; hashes are recorded in the generated report.

Google has one cold entry. OpenAI and DeepSeek share one cold entry because they
use the same SDK. The shared cache contains modules only. Each facade snapshots
its constructor options and owns a separate credential-bound client; concurrent
calls on one facade construct at most one instance. Construction alone loads
nothing. Successful code loads are reused, while a failed load permits a later
request to retry.

Cancellation while loading rejects immediately, detaches the abort listener,
and prevents late construction or network sends by that caller. Other callers
waiting for the same code remain active. The BYOK network capability is checked
again after the added asynchronous load, so going offline in that interval does
not send a request. Provider request objects/signals, stream iterator cleanup,
error mapping, tool capabilities, terminal usage and provider reasoning remain
owned by their existing implementations.

The Vite plugin replaces the two ordinary loader imports only in browser
transforms, using the existing same-build deferred-entry mechanism with a fresh
`provider-attempt` query key on each retry. Node/SSR retain ordinary dynamic
imports, including acceptance workers with no Vite application config. The
bundle contract requires every static import of a cold SDK entry to already
belong to the initial dependency graph, avoiding an unaddressed failed cold
subdependency. Both runtime implementations remain available in the installed
build, with no remote code download source.

Agent composition, native event listeners, credential lookup timing, active
turn ownership and native OpenAI Responses/subscription routes retain their
existing lifecycle. This does not delay or replace the Agent Runtime.

## Headless acceptance

`acceptance/f7-ai-providers.json` builds the actual production renderer entry
and configuration from the exact `8f17a6c5963533ea65454d62dbbf33d8ed7e4d6f`
checkout and this implementation. Both receive the same synthetic invocation
harness and SDK evaluation counters, only in the acceptance build. The browser
uses a disposable headless profile; no native window, account or author database
is opened.

| Measurement | Before | After |
| --- | ---: | ---: |
| Initial static JS bytes | 4,945,074 | 4,408,725 |
| OpenAI SDK requested / parsed / evaluated before use | yes / yes / yes | no / no / no |
| Google SDK requested / parsed / evaluated before use | yes / yes / yes | no / no / no |

The static closure decreases by 536,349 bytes (about 524 KiB). The two observed
cold entries are 161,052 bytes for OpenAI-compatible adapters and 375,914 bytes
for Google. These are uncompressed instrumented build bytes, not network savings,
startup latency or a fixed-device performance budget. Full-app bootstrap is not
claimed in the plain browser, which has no native database bridge.

Fourteen browser checks cover construction without loading; real module fetch
failure and same-build new-key retry for both SDKs; cancellation of one waiter
while another remains pending; preserved per-client configuration; going offline
during Google loading; real SDK completion/stream decoding from synthetic
HTTP/SSE responses; factory routing; repeated calls; and exactly one successful
SDK evaluation. Each SDK request is genuinely blocked once through browser
request interception. Canceled requests must produce no provider call. The
fixture rejects non-synthetic credentials and does not contact a live provider.

The report also executes 67 existing and new unit/conformance checks. Thirteen
new lifecycle cases exercise already-aborted and loading complete/stream calls,
concurrent and independent client ownership, post-load offline capability,
request/error identity, iterator return and listener cleanup. Three plugin checks preserve the Node/SSR path, verify both browser import rewrites
and fail the build if a required import changes. Nine report
contracts accept historical evidence and reject eager SDK execution, omitted
or failed checks, repeated failed URLs, cold static dependencies, changed adapter
hashes, and unsupported native/live-provider claims.

```bash
node scripts/run-renderer-deferred-ai.mjs
node scripts/run-renderer-deferred-ai.mjs --check
pnpm exec vitest run src/renderer/architecture/deferred-ai-providers.test.ts
```

Ordinary checks require the current source fingerprint; `--historical` validates
the recorded contract without claiming the current source was measured. The
fingerprint includes renderer, migrations, Vite config/plugins and the runner,
harness and contract. The report retains the real pre-commit SHA and fingerprint.

Other low-frequency code, full app startup/first-request latency, heap budgets,
native local-resource failure/offline upgrade behavior, physical input and live
provider acceptance remain open. All acceptance in this batch is headless.
