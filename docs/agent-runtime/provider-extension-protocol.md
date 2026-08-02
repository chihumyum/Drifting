# Provider and extension platform protocol

This is the normative Milestone I contract for General Agent model providers,
MCP servers, dynamic tools, secrets, permissions and lifecycle ownership.

## 1. Provider boundary

- A turn freezes one certified `provider` and one model from that provider's
  catalog. Settings changes affect the next turn only; a model id can never be
  silently routed through another provider.
- DeepSeek and OpenAI use their respective Chat Completions adapters. Anthropic
  uses the native Messages streaming adapter. All three project into the same
  `text_delta`, complete tool-call arguments, usage and terminal-finish events.
- Fragmented and parallel tool calls are assembled by stable call index/id.
  Missing usage, missing terminal finish, malformed arguments, authentication,
  rate limit and abort behavior are normalized before the runtime adopts
  provider history.
- Model context windows and output ceilings come only from the certified model
  catalog. The planner may reserve or reduce that budget, never enlarge it.
- Provider API keys are independent native Keychain entries. They do not enter
  SQLite, localStorage, the sync service, MCP configuration or logs.

## 2. MCP configuration and discovery

MCP server configuration is project-scoped SQLite state. A server declares one
transport, public non-secret configuration, Keychain references for secrets,
an exact config hash, enabled state and per-tool policy. Health, discovered
schema and server info are projections, not execution authority.

Activation performs MCP `initialize` using protocol `2025-06-18`, emits
`notifications/initialized`, then exhausts bounded `tools/list` pagination.
Only a valid tools capability, bounded names/descriptions and strict object
input schemas become visible. Dynamic names are namespaced by source/server;
built-in names remain reserved.

## 3. Transports

### Desktop stdio

Desktop Tauri owns a persistent native child process. The executable and cwd
must be absolute, environment inheritance is cleared to a minimal platform
set, request/response sizes are bounded, JSON-RPC ids must match an active
request, stderr is a bounded diagnostic ring and malformed/foreign stdout
terminates that generation. Stop and abort cancel pending requests and reap the
child. Mobile rejects stdio explicitly; no Node sidecar is bundled there.

### Streamable HTTP

All Tauri targets use the native Rust request host so product behavior does not
depend on WebView CORS or CSP. Hosted endpoints require HTTPS and public DNS;
loopback HTTP is permitted for author-owned development servers. Redirects,
environment proxies, URL credentials, private hosted destinations and
authority-bearing caller headers are rejected. Requests and responses are
bounded and cancellable.

The renderer owns MCP session/protocol headers and accepts JSON or SSE with
exactly one matching response. A `404` on an established session invalidates
the session and requires reconnect; the failed request is never replayed.
Session deletion on close is best effort.

## 4. Generation lifecycle and failure isolation

One `(project, server, configRevision)` owns exactly one transport, client and
dynamic registry source. Replacement, disable, deletion, project switch or
reconnect aborts and unregisters the old generation before a new schema is
model-visible. Handshake/discovery may retry with a fresh transport; a
`tools/call` is never retried automatically.

One malformed, unavailable or secret-incomplete server becomes failed without
blocking healthy servers. Secrets and raw transport/provider failures are
redacted before health state reaches SQLite or UI.

## 5. Durable permission authority

Unknown dynamic tools default to write + ask. Configuration can make a
discovered tool read/automatic, read/ask, write/ask or disabled; it cannot
bypass central schema and permission checks.

An allow grant is valid only for the exact project, source kind, server id,
remote tool name, stable authority revision, schema hash, normalized argument
hash and scope (`once`, `session` or `project`). Session grants also bind the
session id. Runtime execution revision is intentionally not the durable
authority because it changes after reconnect; any config/schema/arguments/tool/
server/project change fails closed. A grant is durably inserted before tool
dispatch. Config change, disable or deletion revokes source grants, and the UI
can revoke each grant explicitly.

## 6. Product and data flow

1. Settings freezes provider/model for a requested turn and reads its Keychain
   key lazily.
2. Project activation reads MCP configuration/grants from device-local SQLite,
   resolves only referenced secrets from Keychain and registers healthy tools.
3. The runtime freezes selected built-in/dynamic definitions for one iteration,
   validates complete arguments, resolves central permission, persists any
   broader grant, then dispatches.
4. MCP results return through the same context budgeting, artifact paging and
   provider-visible result path as built-in tools.
5. SQLite extension configuration and grants are local device authority and are
   not currently synchronized by Drifting Server. localStorage is not an
   extension or permission authority.

The Agent settings surface provides server create/edit/delete, enable/disable,
health, reconnect, discovered-tool policy and grant revocation. Existing secret
fields remain blank when editing; blank means retain the Keychain value.

## 7. Deliberate boundary

This milestone exposes tools only. MCP sampling, elicitation, roots,
subscriptions, resources and prompts are not model-visible. Subagents remain a
separate product decision. Paid live-provider calls are optional canaries, not
part of the deterministic release gate.

Run the network-free aggregate gate with:

```bash
pnpm --dir client eval:agent:extensions
```

It uses fragmented provider wire fixtures, a real temporary stdio child, a
real loopback HTTP socket, native transport/security tests, real file SQLite
reopen/concurrency and product-composition checks.

An explicit paid canary is available separately:

```bash
DRIFTING_AGENT_LIVE_PROVIDER=anthropic ANTHROPIC_API_KEY=... \
  pnpm --dir client eval:agent:extensions:live
```

Use the matching `DEEPSEEK_AI_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY`; an optional `DRIFTING_AGENT_LIVE_MODEL` overrides the first
certified model. The launcher never runs from the deterministic gate.
