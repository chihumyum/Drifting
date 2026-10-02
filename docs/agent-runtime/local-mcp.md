# Local MCP access

The Mac Tauri app exposes the existing Agent domain runtime to external MCP
clients. No Hosted account, internal model, API key, Node installation, or
separate domain database is required. This is an inbound MCP server; the
existing **MCP extensions** settings remain the outbound client.

## Connect

1. Open the project in Drifting, then Settings → General Agent → External agent access.
2. In the **Codex**, **Claude Code**, or **Antigravity** row, choose **Read only** (the default),
   **Allow changes**, or **Allow changes and destructive operations**, then click **Connect**.
   Drifting creates the project grant and installs the client entry automatically.
3. Reopen the client or restart its MCP server to load the entry. Follow any tool
   approval prompts in that client. No terminal command, CLI installation, pasted
   configuration, model login, or Keychain permission is needed for this setup.
4. Keep Drifting and the authorized project open. Switching to the shelf or
   another project stops access. After restarting Drifting, reconnect the client
   and read targets again before editing.

Each client has one row and one permission selector. Before connecting, its
selection applies only to that client's new project grant; after connecting,
the same row shows the saved permission and configuration/revocation actions.
There is no global permission selector or duplicate configured-client button.
Changing an existing connection's permission immediately persists the
grant without replacing credentials or client configuration. Active sessions use
the new grant, and the server advertises `tools.listChanged` and sends
`notifications/tools/list_changed` so clients can refresh `tools/list` on the
same connection ([MCP tools protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#list-changed-notification)).
Client support determines when its model sees the refreshed tools; restart the
client's MCP connection if it retains the old list. Installing this server update
requires restarting Drifting and reconnecting existing MCP clients once.

Permission changes cancel pending requests and invalidate queued authorization,
including writes waiting for the shared scheduler. A write already committed is
not undone; inspect interrupted writes before retrying. Other connections keep
their own grants. Read handles remain in the same session; permission changes do
not bypass read coverage, freshness checks or editor review.

**Reconfigure** repairs a missing entry or an app that moved without duplicating
the grant or changing its permission. Revoking
stops access first, then removes only this connection's auto-installed entry.
If that entry was externally replaced or cannot be written, access is still
revoked and the UI asks you to remove the leftover entry in the client.

Automatic setup edits only the named MCP entry in the client user configuration:
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) for Codex,
`~/.claude.json` for Claude Code, or `~/.gemini/config/mcp_config.json` for Antigravity.
Antigravity uses `mcpServers` entries with `command` and `args` for stdio;
reconfiguration preserves its `disabled` and `disabledTools` controls.
Names are stable per Drifting installation and project; other projects and MCP
servers are preserved. Existing configuration is backed up next to the original
as `*.drifting-backup-*` with owner-only access. Writes use a same-directory
atomic rename, reject malformed or unsafe files and detected concurrent edits,
and preserve Codex comments, JSON numeric precision, and unrelated client settings. Tool approval and
workspace trust settings are never enabled on the user's behalf. A failed
configuration install rolls back the new grant and its credential.

For other clients or a custom Claude configuration directory, expand **Other
clients · Manual setup**, name the connection and choose its independent
permission there, then create it and copy its MCP
configuration. The command points to the app executable, with arguments
`--mcp --connection <local-connection-file>`. TOML clients can use the same values
under `[mcp_servers.drifting]`; JSON clients can use `mcpServers.drifting`.
Credentials are never embedded in the copied or installed configuration.
Manual connections are managed inside the same expanded section. Draft
permissions are scoped to the project and client; revoking an installed client
returns its row to the read-only default for a future connection.

Client format references: [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code MCP scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes),
and [Antigravity MCP configuration](https://antigravity.google/docs/mcp).
Antigravity setup targets the current documented global configuration. If an older
client uses a different location, use manual setup in its **View raw config** editor.
One-click setup configures clients on this Mac; it does not configure cloud
sessions or a client's separately configured remote host.

Read-only connections discover 24 tools: the 23 canonical domain reads plus
`read_tool_result`. Writable connections discover 70 tools: all 69 domain tools
plus pagination. Schemas and validation come from the production runtime.
`ask_user`, model planning, long-task orchestration, working memory, arbitrary
SQL, and outbound plugin tools are not part of this external surface.

The destructive permission is a separate, explicit connection grant. Ordinary
writable connections reject tools whose canonical permission policy requires
pre-execution confirmation. Normal writes retain the configured editor review
behavior. All writes keep the existing receipts, inverse guards and sync journal.
Revoke a connection in the same settings section; new and queued requests stop,
while mutations that already committed remain in the book.

## Ownership and authorization

```
External MCP client
  → app executable in stdio mode (no GUI startup)
  → private Unix socket in this app's data directory
  → native connection grant and mounted-project check
  → renderer ExternalToolSession
  → canonical validation + permission policy + shared Agent scheduler
  → production domain tools / live Yjs / SQLite / authored sync journal
```

The native layer issues independent random 256-bit credentials. The grant
registry stores SHA-256 hashes; the client credential file is mode 0600 inside
a mode-0700 directory. Tokens never enter renderer JS, copied config, tool
arguments, or logs. No TCP listener, Hosted session, or Keychain read is used.
This is a local OS-user trust boundary, not isolation from malicious software
already running with that user's filesystem privileges.

The native boundary checks the grant on every request, binds it to its project,
limits frames/connections/in-flight requests, and rejects duplicate request IDs.
Disconnect, cancellation, revocation and project detach cancel pending renderer
requests. An interrupted mutation may already have committed: inspect its
result before retrying. Calls are never automatically replayed after restart.

Each external connection has a distinct runtime session and durable call/turn
records. Calls are ordered within that session and share the existing
reader/writer scheduler with internal Agents. Read coverage stays session-scoped;
reconnecting cannot inherit another client's observations. Changing a document
after it was read makes a stale full-body replacement fail. Runtime reviews are
available through the normal editor review UI; MCP does not approve its own work.

External tool conversations have durable `source=external_mcp`; internal chats
use `source=chat`. General Agent history, usage, restore, continuation, rename
and deletion operate only on internal chats. Clearing chat history leaves MCP
call/turn records, write receipts and editor reviews intact. MCP conversations
do not enter the Agent chat export queue or backfill. Migration
`0005_agent_conversation_source` classifies existing MCP identities and runtime
provider records without deleting their data, using the normal native safety
snapshot migration path. Old MCP branch objects received through chat sync are
retained without projecting them into resumable chats.

MCP wire revision: `2025-11-25`, with stdio `initialize`, `ping`, `tools/list`,
`tools/call`, initialized notifications, tool-list change notifications and
cancellation. The official SDK is used only for development acceptance, not
shipped as an app runtime dependency.
Mobile and remote HTTP/OAuth endpoints are outside this milestone.

## Shared reading, search and read-only Markdown projection

These domain tools are shared with General Agent. MCP only adapts their wire
response: `content` contains the model-facing result once; `structuredContent`
contains success/review metadata, never another `data`/`modelData` prose copy.
Internal receipts and freshness enforcement remain unchanged.

- `read_chapter` defaults to numbered body lines (`lineNumbers: false` disables
  the prefixes). `startLine`/`endLine` select an inclusive range. Long reads
  continue with the returned absolute code-point `cursor`; also pass the
  returned `version` to reject content changes between pages. Range pagination
  must retain the same range arguments. A page can begin mid-line and is labeled
  accordingly. Line prefixes are presentation, never text to write back.
- `search_prose` retains `matchMode: "ranked"` by default. `matchMode: "exact"`
  matches the literal query within editor blocks, including punctuation and
  whitespace, without tokenization or NFKC normalization. It returns every
  non-overlapping occurrence, not one hit per document. `caseSensitive` defaults
  to true in exact mode; false enables Unicode case-insensitive literal matching.
  `scope: "chapters"` searches only chapter bodies; default `"all"` also includes
  drifts, elements, storylines and categories. Neither scope searches titles or
  summaries. Exact results include block/body-line coordinates and code-point
  offsets within the plain-text block. Continue with `nextCursor` as `cursor`
  and the same query/options/`version`; a changed corpus requires a fresh search.
- The desktop project runtime automatically maintains a structured Markdown
  directory even when no MCP client is connected. MCP initialization tells the
  external Agent the **actual local directory**, structure and **READ-ONLY / NO
  REVERSE SYNC** restriction. Settings → Sync & Data → Local data shows the path,
  generation status, output folder picker, restore-default, copy and refresh
  actions. Output locations are per project and device-local; previous output
  is retained on relocation. The MCP panel only links to these settings in one
  explanatory sentence. New connections use the saved custom location.
  `get_project_overview` reports the same projection status to both Agents.

See [local Markdown projection](../local-data-export.md#automatic-read-only-project-projection)
for layout, freshness, cleanup and the one-way boundary. Reading a disk file
does not establish the tool read coverage required before writing through MCP.

## Acceptance

The 2026-10-03 configurable projection location update has source, production
SQLite/Yjs, scheduler and native filesystem/IPC acceptance, including persistent
custom paths, reset, collision protection, retry and MCP initialization paths.
The older packaged Mac reports below predate this update and do not certify its
native folder picker UI.

`pnpm mcp:acceptance` runs the actual domain-runtime/SQLite integration cases and
native IPC/authentication and client-configuration tests, then generates
[`acceptance/local-mcp.json`](acceptance/local-mcp.json). `pnpm mcp:check` verifies
its source fingerprint. Fixtures contain synthetic text only.
The same collector includes `AgentMcpAccessState.test.ts` for client grouping,
saved grant preservation, project isolation and permission mapping. These UI
state checks do not install or alter real client configurations.
Permission-change regressions cover live socket notifications to multiple
sessions, fresh native grant dispatch, persistence and failed updates, read/write
tool discovery, destructive permission changes and cancellation before a queued
write executes. These do not establish any particular client's UI refresh behavior.

For packaged-App acceptance, create a disposable project named `MCP 验收` and
connections through the actual settings UI, then run:

```sh
pnpm mcp:smoke '<app executable>' '<connection file>' write
pnpm mcp:smoke '<app executable>' '<read-only connection file>' read
pnpm mcp:smoke '<app executable>' '<connection file>' reconnect
```

The write smoke requires that exact synthetic project and exercises create,
read, replacement, review receipts, stale concurrent writes, reconnect read
requirements, and soft delete. Additional `editor`, `unmounted` and `revoked`
modes cover live-editor updates, project detach and revoked credentials.
Local reports omit credentials, filesystem paths and prose. Native UI checks
and production signing remain separate from automated source acceptance.

### Mac acceptance, 2026-10-01

The packaged debug app passed 26 official-SDK checks across writing, read-only
access, live-editor operation, cold-start reconnection, project detach and
revocation. The generated run records are in
[`acceptance/local-mcp-mac.json`](acceptance/local-mcp-mac.json); collect them with
`node scripts/run-mcp-acceptance.mjs --record-live` after all smoke modes pass.

Native UI inspection separately verified connection creation/configuration,
author text becoming visible to MCP, external changes appearing immediately in
the mounted editor, heading formatting, and the same text after a normal quit
and cold start. Both synthetic test connections were revoked after acceptance.
The app was ad-hoc signed; this is not a notarized release acceptance.

### One-click client setup

Native acceptance includes Codex TOML and Claude Code/Antigravity JSON formats, preservation of existing
settings/comments/numeric precision, idempotent setup, project scope, failed
installation rollback, and revocation even after an external config change.

On 2026-10-01 the packaged debug app passed all 12 setup/cleanup checks in
[`acceptance/local-mcp-setup-mac.json`](acceptance/local-mcp-setup-mac.json).
The Codex and Claude Code buttons and reconfiguration were exercised through native UI; the test
grants were revoked afterwards. All 33 MCP-specific checks and 109 native tests
passed (one unrelated native test remained ignored).

Antigravity is covered by the generated runtime/native acceptance in
[`acceptance/local-mcp.json`](acceptance/local-mcp.json): settings-row isolation,
stdio schema, preservation of other servers and disabled-tool controls, private
config creation/backups, idempotent grants, permission updates and revocation.
The historical packaged report above does not cover Antigravity; actual Antigravity
session reload and tool use remain unverified.

Packaged-App setup acceptance uses a synthetic project and all three real client
configuration locations. Save owner-only copies of each original configuration
under `.local-data/mcp-acceptance/pre-oneclick-{codex,claude_code,antigravity}.config`, click
the three connection buttons, then run:

```sh
node scripts/mcp-client-setup-smoke.mjs '<app data directory>' installed
# Revoke the three test connections through Drifting's settings.
node scripts/mcp-client-setup-smoke.mjs '<app data directory>' revoked
```

This checks exact preservation of unrelated parsed settings, launches the
installed commands through the official SDK, exercises scoped reads and denied
writes, and verifies cleanup plus failed reconnection after revocation. The
script writes sanitized evidence to `acceptance/local-mcp-setup-mac.json`.
It requires Python 3.11+ only on the acceptance host to parse TOML; shipped setup
has no Python dependency. Actual client session reload and client-specific tool
approval remain separate from the SDK connection check.
