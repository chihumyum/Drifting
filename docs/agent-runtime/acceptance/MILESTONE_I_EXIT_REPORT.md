# Milestone I exit report — Provider and extension platform

Date: 2026-08-02

Status: **complete**

## Delivered

- General Agent turns freeze a certified DeepSeek, Anthropic or OpenAI
  provider/model/thinking/effort tuple. Native Anthropic Messages, OpenAI
  Responses and DeepSeek Chat Completions adapters converge on the same
  reasoning/text/tool-call, usage, finish, error and cancellation contract.
- OpenAI exposes GPT-5.6 Sol/Terra/Luna. Settings and the composer expose only
  each model's certified thinking/effort values; hydration and provider/model
  switches normalize stale combinations.
- Reasoning tool loops retain provider-opaque replay state only for the active
  turn: DeepSeek `reasoning_content`, Anthropic signed thinking blocks, and
  OpenAI encrypted Responses output items. Missing replay state fails closed.
  Every provider still uses its own lazily-read native Keychain credential.
- MCP `2025-06-18` initialization, bounded paged tool discovery, strict schema
  projection, tool calls, ping and session lifecycle are implemented.
- Desktop stdio runs through a bounded native child-process host. Streamable
  HTTP runs through a cancellable native Rust request host on every Tauri
  target, avoiding WebView CORS/CSP divergence. Hosted endpoint/private-network,
  redirect, proxy, header, size, id and malformed-output boundaries fail closed.
- Project Settings provide server CRUD, enable/disable, health, reconnect,
  secret references, discovered-tool policy and grant revocation.
- `once`, `session` and `project` grants are durable exact authority over
  project/server/tool/config/schema/arguments. A grant commits before dispatch;
  config replacement, disable, deletion or explicit revoke invalidates it.
- One server/config generation owns one transport/client/registry source.
  Replacement unregisters the old generation; handshake retry is isolated and
  never replays `tools/call`.
- SQLite migration `0076_agent_extension_platform.sql`, generated capability
  schema v7, normative protocol, README/status/roadmap/headless commands and an
  explicit opt-in paid provider canary are included.

Normative behavior is in
[`../provider-extension-protocol.md`](../provider-extension-protocol.md).
Machine evidence is in
[`milestone-i-provider-extension.json`](milestone-i-provider-extension.json).

## Deterministic acceptance

`pnpm --dir client eval:agent:extensions` passed:

- 19 Vitest files, 162/162 tests;
- provider conformance: 57 tests;
- MCP protocol/lifecycle: 28 tests;
- durable authority/product composition: 77 tests;
- TypeScript typecheck, scoped ESLint and generated capability drift gate;
- Rust MCP tests and `cargo check`;
- a real temporary Node stdio child, real loopback HTTP socket and real
  file-backed SQLite reopen/concurrency path;
- no network credential and no paid provider request.

The 2026-08-02 GPT-5.6/reasoning refresh adds deterministic Responses,
DeepSeek-thinking and Anthropic-signed-replay fixtures plus model-profile/store
coverage. The generated schema-v12 capability inventory records each model's
wire contract, thinking modes and effort levels. The paid canary remains
opt-in.

Full Core regression also passed: **141 files, 886/886 tests**. Full native Rust
regression passed **47/47** after replacing a stale hard-coded migration count
with the embedded Drizzle journal length. Root typecheck/lint passed with no
errors (existing unrelated warnings remain).

## Optional live canary

`DRIFTING_AGENT_LIVE_PROVIDER=<deepseek|anthropic|openai> pnpm --dir
client eval:agent:extensions:live` makes one explicit schema-bound tool
request using the matching environment key. It was not invoked during the
network-free exit gate, so this report does not claim paid endpoint availability
for the user's account at this moment.

## Explicit boundary

- Mobile intentionally has no stdio sidecar; Streamable HTTP is its MCP
  transport.
- MCP sampling, elicitation, roots, subscriptions, resources and prompts are
  not exposed.
- Desktop/iOS/Android interactive smoke and 4h/12h real-book endurance remain
  Milestone J. Static bridge/build evidence must not be described as device UI
  acceptance.
