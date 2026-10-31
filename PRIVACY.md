# Drifting client privacy boundary

Last updated: 2026-10-31

This document describes what the open-source Drifting client stores and what
it sends over the network. It is a technical description of the client, not a
service privacy policy. The privacy policy of the official Hosted service is at
<https://drifting.cc/privacy>. Anyone who distributes a modified build or runs
another compatible service is responsible for their own disclosures.

## Two kinds of build

- **Source builds** (`pnpm dev`, `pnpm tauri:build`) are local-only. They have
  no account, no sync, no crash reports and no update checks.
- **The official macOS build** from GitHub Releases is the same local-first
  app. It also offers an optional Hosted account at `https://api.drifting.cc`,
  sends crash reports and checks for updates, as described below. Using it
  without signing in keeps your projects on your Mac.

## On your Mac

- Projects are stored in a local SQLite database with Yjs prose, in the app's
  data folder. Imported images and PDFs, imported fonts, generated image
  candidates, version-history snapshots and migration safety snapshots are kept
  there too. Version history is local and kept for 30 days.
- API keys, the ChatGPT sign-in, the Hosted session and MCP server secrets are
  stored in the macOS Keychain. They are never written to project data,
  `localStorage` or synced preferences.
- The automatic Markdown folder is a readable copy of each project, in the app's
  data folder or a folder you choose. Any program that can read that folder
  can read your writing.
- A copied diagnostic summary (Settings → Privacy) contains versions, counts
  and error categories only, and is never uploaded automatically.
- Drifting has no usage-analytics uploader.

You are responsible for having the right to use any manuscript, image, PDF or
font you import.

## Hosted account and sync

Only the official build (or another build configured for a compatible service)
can sign in. When you sign in:

- The service stores your email address, sign-in credentials, display name
  and avatar.
- The current local library is uploaded and your cloud projects are
  downloaded. From then on, project changes sync through the service: prose,
  structure, elements, comments and TODOs, materials with their image and PDF
  files, Project Memory, and finished Agent conversations.
- API keys, the ChatGPT sign-in, MCP configuration, Agent Working Memory,
  generated image candidates and Project Home check-in cards stay on the device.
- Synced content is not end-to-end encrypted. HTTPS protects it in transit, and
  the service can read what it stores. Signing in means trusting the service
  operator with your projects.
- The service also processes network metadata such as IP address, user agent,
  request times and session identifiers.

Signing out or disconnecting sync keeps local projects and does not delete the
copies on the service. Deleting a project permanently (from Recently Deleted)
deletes it from the service too; the service keeps the deleted data
recoverable for 30 days and then purges it. Backups, retention and account
requests follow the service privacy policy.

## Share links

Share links need a Hosted account and are created only when you choose
**Create share link**. The service receives a reader copy of that one chapter,
idea, element, storyline or category: its text and formatting, the name,
summary and colour of each entity it links to, its place in the book, its
storyline's name and colour, its word count, and your display name. Your own
comments, TODOs and the rest of the project are not sent.

Anyone with the link can read the copy and every reader comment on it. Readers
comment with their own Drifting account, and their comments are imported into
your library. **Stop sharing** deletes the link and the comments still on the
service. See [share links](docs/share-links.md).

## Crash and integrity reports

The official build sends a report when Drifting fails: an uncaught error, a
crash, a failed database open, a Yjs load or local save failure, or a stopped
sync. A report contains the error kind, a shortened and sanitized message,
stack frames, the app version, platform, a random installation ID and a few
non-identifying context values. Long runs of prose-like text and home-directory
paths are removed. When you are signed in, the report includes your account so
the maintainer can follow up.

Reports are on by default and can be turned off in **Settings → Privacy**.
Source builds and development builds send none. A build can be configured to
send reports to Sentry instead; see [crash reports](docs/crash-reports.md) and
[Sentry diagnostics](docs/sentry-observability.md).

## AI

Drifting has no AI service of its own. Nothing is sent to a model provider
until you connect one in **Settings → Models & API**.

- **DeepSeek, Anthropic and OpenAI** use your own API key. Requests go directly
  from your Mac to the provider. They contain your messages, the conversation,
  and whatever the Agent reads with its tools: chapters, elements, materials
  (including PDF text and images), Project Memory and Working Memory.
- **ChatGPT subscription** is experimental and not an OpenAI-supported
  integration. You sign in with OpenAI's device code; the token stays in native
  code and the Keychain. Requests go to the ChatGPT Codex backend and count
  against your ChatGPT plan.
- **Element portraits** are generated through the same ChatGPT route. Results
  wait on the device and are deleted after 30 days unless you keep them. A kept
  image becomes a material, with the prompt recorded alongside it, and syncs
  like any other material. See [image generation](docs/image-generation.md).
- **Voice dictation** is optional. With an Alibaba Cloud DashScope key, recorded
  audio and a list of the project's names go directly to DashScope.
- **Background Agent work.** With a provider connected, Project Home's daily
  check-in and auto-organize send recently changed prose to your selected
  provider without a separate request each time. Both can be turned off in
  Project Home settings.

What a provider keeps, and whether it trains on your data, depends on that
provider and your account with it. Read its terms before sending private
writing. Drifting contains no training pipeline. Agent output can be wrong;
Agent edits are applied directly, marked in the text and can be undone from
version history.

## MCP and external agents

- **MCP extensions** are servers you add yourself, either local programs or
  HTTP URLs. The Agent sends them the arguments of tools you allow, which can
  include project content.
- **External agent access** lets Codex, Claude Code, Antigravity or another MCP
  client read, and if you allow it change, the open project through a private
  local socket. What such a client reads goes to its own model provider under
  its own terms. You choose the permission per client and can revoke it in
  Settings. See [local MCP access](docs/agent-runtime/local-mcp.md).

## Update checks

The official build checks
`https://github.com/chihumyum/Drifting/releases/latest/download/latest.json` at
most once a day, and whenever you check manually in **Settings → Updates**. GitHub sees the
request and your IP address. Downloading and installing an update each need
your confirmation. Source builds do not check.

## Your controls

- Write without an account; nothing leaves the Mac unless you connect a
  provider, an extension or an account.
- Turn off crash reports in Settings → Privacy, and the daily check-in and
  auto-organize in Project Home settings.
- Keep your own backups. A `.drifting` backup holds the whole library but needs
  a local library (disconnect sync first); the Markdown export and Markdown
  folder are readable copies, not full backups. See
  [library backup](docs/library-backup.md).

For a security issue, follow [SECURITY.md](SECURITY.md). For the boundary
between this client and the official service, see
[docs/official-service.md](docs/official-service.md). Questions about the
official service: support@drifting.cc.
