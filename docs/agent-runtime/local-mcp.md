# Local MCP access

The Mac Tauri app exposes the existing Agent domain runtime to external MCP
clients. No Hosted account, internal model, API key, Node installation, or
separate domain database is required. This is an inbound MCP server; the
existing **MCP extensions** settings remain the outbound client.

## Connect

1. In Drifting, open Settings → General Agent → External agent access, or, on
   the shelf, Settings → External agent access. No book needs to be open.
2. In the **Codex**, **Claude Code**, or **Antigravity** row, click **Connect**.
   Drifting creates the grant and installs the client entry automatically.
3. Reopen the client or restart its MCP server to load the entry. Follow any tool
   approval prompts in that client. No terminal command, CLI installation, pasted
   configuration, model login, or Keychain permission is needed for this setup.
4. Keep Drifting open. Each client connects once and works in whichever book is
   open; on the shelf its tools are unavailable. After restarting Drifting,
   reconnect the client and read targets again before editing.

A connection belongs to the library it was made in (each signed-in account has
its own) and reaches every book in it, one at a time: the book open in Drifting.
Switching books cancels pending requests, and the first tool call a session
makes after a switch is refused before anything runs, telling the client to
call `get_project_overview` (which reports the open book's name, `bookId` and
Markdown folder) and read again; reads and the tools that need them start over
in the new book, and entity ids do not carry between books. Listing tools does
not count as looking again. Each external session's conversation record belongs
to the book it was working in.

Connections made by earlier versions covered a single book, with one client
entry per book (`drifting_<hash>` per book). They keep working in that book
only and are listed, with the book's name, under **Other clients · Manual
setup**. Connecting or reconfiguring a client revokes that client's per-book
connections and removes their entries from the same configuration file; if one
of those entries was changed outside Drifting or cannot be written, access is
still revoked and the UI asks you to remove the leftover `drifting_` entry.
Per-book manual connections stay until revoked.

Each client has one row: **Connect** before it is connected, then
**Reconfigure**, **Connection configuration** and **Revoke**. There is no
permission to choose. Since 2026-11-06 every connection may use every tool the
external surface offers, reads, writes and destructive operations alike, with
no read-only or confirmation tier. A connection an earlier version made
read-only or without destructive operations has the same access after updating;
the tier still stored in its registry entry is read and dropped on the next
write of the registry. A connection's tool list never changes while it is
connected, so the server does not advertise `tools.listChanged`.

**Reconfigure** repairs a missing entry or an app that moved without duplicating
the grant. Revoking
stops access first, then removes only this connection's auto-installed entry.
If that entry was externally replaced or cannot be written, access is still
revoked and the UI asks you to remove the leftover entry in the client.

Automatic setup edits only the named MCP entry in the client user configuration:
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) for Codex,
`~/.claude.json` for Claude Code, or `~/.gemini/config/mcp_config.json` for Antigravity.
Antigravity uses `mcpServers` entries with `command` and `args` for stdio;
reconfiguration preserves its `disabled` and `disabledTools` controls.
Names are stable per Drifting installation and library; other MCP servers are
preserved. Existing configuration is backed up next to the original
as `*.drifting-backup-*` with owner-only access. Writes use a same-directory
atomic rename, reject malformed or unsafe files and detected concurrent edits,
and preserve Codex comments, JSON numeric precision, and unrelated client settings. Tool approval and
workspace trust settings are never enabled on the user's behalf. A failed
configuration install rolls back the new grant and its credential.

For other clients or a custom Claude configuration directory, expand **Other
clients · Manual setup**, name the connection, then create it and copy its MCP
configuration. The command points to the app executable, with arguments
`--mcp --connection <local-connection-file>`. TOML clients can use the same values
under `[mcp_servers.drifting]`; JSON clients can use `mcpServers.drifting`.
Credentials are never embedded in the copied or installed configuration.
Manual connections are managed inside the same expanded section.

Client format references: [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code MCP scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes),
and [Antigravity MCP configuration](https://antigravity.google/docs/mcp).
Antigravity setup targets the current documented global configuration. If an older
client uses a different location, use manual setup in its **View raw config** editor.
One-click setup configures clients on this Mac; it does not configure cloud
sessions or a client's separately configured remote host.

Every connection discovers the whole external surface: the canonical domain
reads and writes plus `read_tool_result` (89 tools in the 2026-11-06 source
acceptance). Schemas and validation come from the production runtime.
`ask_user`, model planning, long-task orchestration, working memory, arbitrary
SQL, and outbound plugin tools are not part of this external surface.

A connection runs every certified write without a prompt, as the in-app Agent
does since 2026-11-06: a deletion, or anything without a safe automatic
inverse, included. Certification, schema validation, read coverage
and freshness checks still apply, normal writes retain the configured editor
review behavior, and all writes keep the existing receipts, inverse guards and
sync journal.
Revoke a connection in the same settings section; new and queued requests stop,
while mutations that already committed remain in the book.

## Ownership and authorization

```
External MCP client
  → app executable in stdio mode (no GUI startup)
  → private Unix socket, beside the library's connection files or in the
    user's own cache folder when that path is too long (macOS),
    or a loopback TCP port (Windows)
  → native connection grant and open-book check
  → renderer ExternalToolSession
  → canonical validation + permission policy + shared Agent scheduler
  → production domain tools / live Yjs / SQLite / authored sync journal
```

The native layer issues independent random 256-bit credentials. The grant
registry stores SHA-256 hashes; on macOS the client credential file is mode
0600 inside a mode-0700 directory, on Windows it lives in the user's own app
data, private through its inherited ACL. Tokens never enter renderer JS, copied
config, tool arguments, or logs. No Hosted session or Keychain read is used.
macOS listens only on the Unix socket. Its address holds at most 103 bytes of
path, so the socket sits beside the connection files only when that fits. In
an installed App an account's library (`libraries/account-…/mcp`) never fits:
its socket is `drifting-mcp/<16 hex>.sock` in the user's own cache folder
(`/var/folders/…/C`, mode 0700, not swept while the App runs, unlike the
temporary folder beside it), named from the MCP directory so every launch binds
the same path. Windows has no such socket in the standard library, so it
listens on `127.0.0.1` alone, on a port chosen at each
launch and written into every connection file; the token authenticates each
stream exactly as on the socket, and nothing listens beyond loopback.
This is a local OS-user trust boundary, not isolation from malicious software
already running with that user's filesystem privileges.

The native boundary checks the grant on every request, sends it only to the open
book (or, for a per-book connection, only to its book), limits
frames/connections/in-flight requests, and rejects duplicate request IDs.
Disconnect, cancellation, revocation and closing or switching the book cancel pending renderer
requests. An interrupted mutation may already have committed: inspect its
result before retrying. Calls are never automatically replayed after restart.

Each external connection has a distinct runtime session and durable call/turn
records. Calls are ordered within that session and share the existing
reader/writer scheduler with internal Agents. Read coverage stays session-scoped;
reconnecting cannot inherit another client's observations. Changing a document
after it was read makes a stale full-body replacement fail. Runtime reviews are
available through the normal editor review UI; MCP does not approve its own work.
A native connection can outlive a renderer bridge remount (project switch,
window reload). Each bridge attachment therefore scopes the durable session to
`<native session>:<attachment>`, so a remount starts a fresh session with no
read coverage instead of colliding with the closed one. A failed session
initialization is retried on the next call, never replayed.

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

## Shared reading, search and the Markdown folder

Markdown projection status returned by `get_project_overview` omits cleared
fields instead of retaining `undefined` values. This keeps recovery from a
projection error compatible with durable Agent payload serialization.

These domain tools are shared with General Agent. MCP only adapts their wire
response: `content` contains the model-facing result once. Responses never
carry `structuredContent` (no tool declares an `outputSchema`): clients such as
Claude Code show it to the model instead of `content`, so a metadata-only
object hid every result. Review metadata travels in
`_meta["cc.drifting/presentation"]`, outside model context, and never another
`data`/`modelData` prose copy. Internal receipts and freshness enforcement
remain unchanged.

- `read_chapter` defaults to numbered body lines (`lineNumbers: false` disables
  the prefixes). `startLine`/`endLine` select an inclusive range; an end beyond
  the last line stops at the chapter end, while an invalid start or reversed
  range still fails. A first read omits `version`; an empty/blank version is
  also treated as absent, never as evidence of a changed chapter. Long reads
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
  The disk format supports Obsidian via relative links, stable block references,
  YAML alias lists and local image/PDF attachments. Disk lines/hashes differ from
  `read_chapter`; `.drifting/manifest.json` maps full entity identities to readable
  filenames and records canonical `sourceVersion` values. Start at `开始阅读.md`;
  chapters use reading-order numbers and existing act folders, elements use
  existing categories, and comments/TODOs are aggregated. Rename/reorder refreshes
  rebuild internal links; external hand-written file links may become stale.

See [local Markdown projection](../local-data-export.md#automatic-project-markdown-folder)
for layout, freshness, cleanup and the one-way boundary. Reading a disk file
does not establish the tool read coverage required before writing through MCP.

## Acceptance

The 2026-10-03 configurable projection location update has source, production
SQLite/Yjs, scheduler and native filesystem/IPC acceptance, including persistent
custom paths, reset, collision protection, retry and MCP initialization paths.
The older packaged Mac reports below predate this update and do not certify its
native folder picker UI.

The 2026-11-06 change to connections that reach whichever book is open has
native socket acceptance (open-book dispatch, the refused first call after a
switch, per-book connections kept to their book, retirement of a client's
per-book entries including a changed one), renderer bridge and settings-state
tests, and a run in a development App. The packaged Mac reports below predate
it.

`pnpm mcp:acceptance` runs the actual domain-runtime/SQLite integration cases and
native IPC/authentication and client-configuration tests, then generates
[`acceptance/local-mcp.json`](acceptance/local-mcp.json). `pnpm mcp:check` verifies
its source fingerprint. Fixtures contain synthetic text only.
The same collector includes `AgentMcpAccessState.test.ts` for client grouping,
saved grant preservation and per-book connections listed apart, and
`AgentMcpAccessSettings.render.test.ts` for a Connect button per client with no
permission to choose. These UI checks do not install or alter real client
configurations.
The 2026-11-06 removal of permission tiers is covered by a native test in which
a registry naming a retired tier loads, dispatches its grant without one and
drops it on the next write, and by runtime tests in which a connection discovers
the whole surface and deletes a chapter without a confirmation.

For packaged-App acceptance, create a disposable project named `MCP 验收` and
connections through the actual settings UI, then run:

```sh
pnpm mcp:smoke '<app executable>' '<connection file>' write
pnpm mcp:smoke '<app executable>' '<connection file>' reconnect
```

The write smoke requires that exact synthetic project and exercises create,
read, replacement, review receipts, stale concurrent writes, reconnect read
requirements, and soft delete. Additional `editor`, `unmounted` and `revoked`
modes cover live-editor updates, project detach and revoked credentials.
Local reports omit credentials, filesystem paths and prose. Native UI checks
and production signing remain separate from automated source acceptance.

### Mac acceptance, 2026-10-01

The packaged debug app passed 26 official-SDK checks across writing, read-only (a tier retired on 2026-11-06)
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
config creation/backups, idempotent grants and revocation.
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
installed commands through the official SDK, checks that they discover every
tool and read the synthetic project, and verifies cleanup plus failed
reconnection after revocation. The
script writes sanitized evidence to `acceptance/local-mcp-setup-mac.json`.
It requires Python 3.11+ only on the acceptance host to parse TOML; shipped setup
has no Python dependency. Actual client session reload and client-specific tool
approval remain separate from the SDK connection check.
