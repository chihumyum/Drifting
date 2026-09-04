# Provider and extension platform protocol

This is the normative Milestone I contract for General Agent model providers,
MCP servers, dynamic tools, secrets, permissions and lifecycle ownership.

## 1. Provider boundary

- A turn freezes one certified `provider`, model, thinking mode and reasoning
  effort from that model's capability profile. Settings changes affect the
  next turn only; a model id or unsupported reasoning value can never be
  silently routed through another provider.
- DeepSeek uses Chat Completions with native `thinking` and top-level
  `reasoning_effort`. During a thinking tool round, Drifting omits
  `tool_choice` and replays the exact `reasoning_content` on the next iteration.
- Anthropic uses native Messages streaming. Sonnet 5 exposes adaptive thinking
  plus `low` through `max` effort; its signed thinking/redacted-thinking blocks
  are retained verbatim only for the active tool loop. Haiku 4.5 exposes no
  certified thinking/effort controls in the current catalog.
- OpenAI is the GPT-5.6 family (`gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`) on the Responses API. Thinking-off maps to reasoning effort
  `none`; thinking-on maps to the selected `low` through `max` effort. Requests
  use `store: false`, request encrypted reasoning content, and replay the exact
  response output items only inside the active tool loop.
- `openai-codex` is the experimental ChatGPT subscription route. It sends the
  same GPT-5.6 Responses body through the same native host to the Codex
  backend, authorized by the author's own ChatGPT sign-in obtained with the
  official Codex device-code OAuth flow. The body mirrors the official CLI:
  no `max_output_tokens`, `text.verbosity` set. The OAuth tokens live only in
  native secure storage under the renderer-inaccessible `oauth.openai-codex`
  key; a token the backend rejects is refreshed once under a shared lease and
  the bounded body replayed. OpenAI publishes no third-party contract for this
  path, so it is unsupported, may stop working without notice, and is never a
  release claim.
- A Codex subscription stream may publish complete reasoning and function-call
  items in indexed `response.output_item.done` events while leaving the terminal
  `response.completed.response.output` array empty. The renderer reconstructs
  that response only from a unique, contiguous sequence of completed item
  indexes. A non-empty terminal output remains authoritative; duplicate or
  missing streamed indexes fail closed.
- One assistant response is one opaque reasoning replay unit. If it contains
  parallel tool calls, context retirement retains or compacts the complete
  overlapping call/result batch; it never removes one call/result pair while
  replaying its siblings. The OpenAI adapter verifies the complete replay call
  set and matching `function_call_output` closure before network dispatch.
- All three adapters project into the same `thinking_delta`, `text_delta`,
  complete tool-call arguments, usage and terminal-finish events. Provider
  opaque replay state never becomes portable canonical conversation history;
  missing active-turn replay state fails closed.
- Fragmented and parallel tool calls are assembled by stable call index/id.
  Missing usage, missing terminal finish, malformed arguments, authentication,
  rate limit and abort behavior are normalized before the runtime adopts
  provider history.
- On the current DeepSeek/OpenAI-compatible route, a tool-capable sample is
  buffered until its complete tool/usage/finish contract validates. Before any
  Agent event or effect escapes, parse/network/rate-limit failures, malformed
  tool arguments, missing required reasoning, unavailable tools and output
  exhaustion before an action receive at most six provider attempts. An
  action-serialization recovery may temporarily turn thinking off; the next
  model iteration restores the turn's frozen reasoning mode. Authentication
  failures and author cancellation are never retried, and tool-free visible
  synthesis is never replayed after text has streamed.
- Model context windows and output ceilings come only from the certified model
  catalog. The planner may reserve or reduce that budget, never enlarge it.
- Provider API keys are independent native Keychain entries. They do not enter
  SQLite, localStorage, the sync service, MCP configuration or logs.
- OpenAI Responses calls leave the WebView entirely: renderer code sends only
  the bounded JSON body over a cancellable Tauri channel, while the fixed-origin
  Rust host reads `byok.openai` and injects Authorization natively. A Keychain,
  connection, HTTP/model-entitlement, quota or stream failure is projected to a
  stable redacted class plus an OpenAI request id when one exists.

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

### OpenAI Responses

All Tauri targets use the dedicated native Rust Responses host for General
Agent OpenAI turns. It is fixed to `https://api.openai.com/v1/responses`, allows
only the certified GPT-5.6 Sol/Terra/Luna models, requires `stream: true` and
`store: false`, rejects redirects, bounds request/error/stream bytes and
forwards author cancellation. It is not the configurable MCP HTTP transport.
The renderer reconstructs an ordered `ReadableStream` from Tauri channel bytes;
it never receives an Authorization header or the OpenAI credential.

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

1. Settings normalizes provider/model/thinking/effort against the certified
   model profile and freezes all four for a requested turn. OpenAI credentials
   are read lazily by the native Responses host; other certified adapters keep
   their existing lazy credential path.
2. Project activation reads MCP configuration/grants from device-local SQLite,
   resolves only referenced secrets from Keychain and registers healthy tools.
3. The runtime freezes selected built-in/dynamic definitions for one iteration,
   validates complete arguments, resolves central permission, persists any
   broader grant, then dispatches.
4. MCP results return through the same context budgeting, artifact paging and
   provider-visible result path as built-in tools.
5. SQLite extension configuration and grants are local device authority and are
   not synchronized by any SyncEngine provider (`agent_mcp_server` and
   `agent_permission_grant` are declared never-synchronized in the domain
   manifest). localStorage is not an extension or permission authority.

The Models & API surface queries credential existence rather than credential
data when it renders; on macOS the query requests Keychain attributes only and
skips authentication UI. Decrypting a key is limited to an explicit provider
operation. The Agent settings surface provides server create/edit/delete, enable/disable,
health, reconnect, discovered-tool policy and grant revocation. Existing secret
fields remain blank when editing; blank means retain the Keychain value.

## 7. Deliberate boundary

This milestone exposes tools only. MCP sampling, elicitation, roots,
subscriptions, resources and prompts are not model-visible. Subagents remain a
separate product decision. Paid live-provider calls are optional canaries, not
part of the deterministic release gate.

Representative live Agent canaries enable the selected model's reasoning and
omit an effort override. In the headless client this is `--thinking adaptive`
without `--effort`; a non-default effort is used only when effort itself is the
scenario under test.

Run the network-free aggregate gate with:

```bash
pnpm eval:agent:extensions
```

It uses fragmented provider wire fixtures, a real temporary stdio child, a
real loopback HTTP socket, native transport/security tests, real file SQLite
reopen/concurrency and product-composition checks.

An explicit paid canary is available separately:

```bash
DRIFTING_AGENT_LIVE_PROVIDER=anthropic ANTHROPIC_API_KEY=... \
  pnpm eval:agent:extensions:live
```

Use the matching `DEEPSEEK_AI_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY`; an optional `DRIFTING_AGENT_LIVE_MODEL` overrides the first
certified model. The launcher never runs from the deterministic gate.

Authoritative upstream contracts: [OpenAI latest model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), and
[Anthropic adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking).
