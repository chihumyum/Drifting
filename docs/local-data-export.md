# Local relational Markdown export

## Automatic read-only project projection

The Tauri desktop client maintains one project-scoped directory. **Settings →
Sync & Data → Local data → Local Markdown projection** shows its actual path,
generation status, folder picker, restore-default, copy and refresh actions.
Open a project to configure its projection. The default location is
`<app-local-data>/markdown-projections/<SHA-256 of project ID>/`. Selecting a
folder changes it to `<selected-folder>/markdown-projections/<SHA-256 of project ID>/`.
The location is saved per project on this device in
`<app-local-data>/markdown-projection-settings.json`, outside SQLite, Yjs and
synced preferences. Worktree instances retain their isolated application-data
identity and default output. Custom locations are explicitly user-selected;
use separate folders for independent acceptance instances.

Changing or resetting the location drains the current capture, checks the new
directory and its writability, saves the preference, then regenerates the
projection. Old directories are retained as snapshots and no longer refreshed;
remove them manually when no longer needed. If regeneration fails, the chosen
location remains selected and the UI reports the error for retry. An unavailable
custom folder never silently falls back to the default. Restore default remains
available after a location error. No manuscript data is moved.

The directory is
created when a project opens, refreshed after local authored commits and remote
project changes, and refreshed during the local lifecycle flush. Background
refreshes coalesce commits, serialize captures, and replace only changed files.
Only the open project's rows and Yjs state are captured.
Automatic captures wait while the active editor is composing IME text and check
again between asynchronous stages. Manual refresh and lifecycle flush still run;
the authoritative incremental Yjs save path is independent of this deferral.

```
README.md
index.md
manifest.json
project/
  index.md
  chapters/id-<entity ID>/{index.md,prose.md}
  drifts/id-<entity ID>/{index.md,prose.md}
  elements/id-<entity ID>/{index.md,prose.md}
  categories/id-<entity ID>/{index.md,prose.md}
  storylines/id-<entity ID>/{index.md,prose.md}
  comments/id-<entity ID>/index.md
  library/id-<entity ID>/index.md
```

Entity IDs are percent-encoded. Renaming/reordering entities does not move their
files. Entity indexes contain names, summaries and relations; `prose.md` contains
only the shared Agent Markdown body. Each editor block occupies a single line
with `<br>` for embedded breaks, separated by a blank line; empty blocks remain.
Thus block N begins on line `2N-1`, matching `read_chapter` and exact-search body
coordinates. Number prefixes are never saved in these files.

**This is a read-only, one-way projection. There is no reverse sync.** Editing
files never updates Drifting; a refresh can overwrite edits. Use Drifting or its
authorized domain tools to change content. No file watcher or Markdown import
feeds these files back into SQLite/Yjs. On Unix, generated files are mode 0400
and created directories are mode 0700. This is not a boundary against the same
OS user deliberately changing permissions. Images/PDF bytes and runtime records
are excluded; this is not a lossless backup.

The same local durability barrier and authoritative Yjs hydration as ZIP export
precede generation. A failed/corrupt capture does not publish fabricated prose.
Writes use same-directory atomic replacement per file; the manifest is published
last with generation time and SHA-256 hashes. A private pending manifest records
file ownership before writing, so interrupted generation can be retried without
overwriting unrelated files. It is removed after successful publication and is
not a freshness indicator. A body file's hash with `sha256:`
prefix equals its shared tool `version`. Multi-file reads are not a transaction:
verify hashes against an unchanged manifest, or retry while refresh is pending.
A write interrupted partway may leave a hash mismatch until the next refresh.
Settings and the project overview expose errors; derived-output failure never
blocks saving the authoritative manuscript.

Closed projects retain their last snapshot; consult the manifest time and reopen
to refresh. Soft-deleted entities disappear on refresh. Deleting a project
removes its manifest-owned files at the current location and the location
preference after stopping/draining its writer. Previously retained locations
remain. Unmanaged files are preserved, including collisions with newly generated
paths: those reject the write before managed prose changes. Path traversal,
duplicate paths, symlinks and hard-linked files are rejected; only manifest-owned
files (including interrupted-write claims) may be removed.

MCP settings retain one line pointing external Agents to the read-only projection
and its settings location. MCP initialization, projection settings, the directory
README and the shared project overview state the read-only/no-reverse-sync restriction. The path
is local to the computer running Drifting. External file reads do not satisfy
the MCP session's read-before-write requirement. New MCP connections resolve the
saved output preference; existing connections can query `get_project_overview`
for the updated directory and generation status.

Machine evidence for this projection and shared prose access is generated by
`pnpm mcp:acceptance` in
[`agent-runtime/acceptance/local-mcp.json`](agent-runtime/acceptance/local-mcp.json).
It includes production SQLite/Yjs tool-to-file version/line agreement, literal
search, scheduler behavior, stable export paths and native filesystem writes.
`node scripts/run-markdown-projection-settings.mjs` generates
[`projection-settings-ui.json`](agent-runtime/acceptance/projection-settings-ui.json)
from browser clicks on the real React settings components in English and Chinese.
It covers cancellation, choose/reset/refresh, failure feedback and narrow desktop
layout, with synthetic picker/service actions. Pass `--check` to verify its source
fingerprint. The native OS folder-picker dialog is not exercised by this browser
report; filesystem and scheduling behavior are tested separately above.

## Manual ZIP export

The default local-only build exposes **Settings → Sync & Data → Local data → Export
relational Markdown**.
The export does not require a Drifting account and does not call the hosted project graph,
entity mutation flush, remote Yjs sync, or any hosted asset/service API.

### Consistency boundary

Export follows this order:

1. Flush every mounted Yjs document's local persistence queue and full snapshot.
2. Capture all project rows, exported relation rows, Yjs snapshots, and remaining Yjs updates in
   one SQLite read transaction.
3. Render the captured state into Markdown and generate a ZIP.
4. Save the ZIP through the native document picker on desktop, iOS, and Android.

For node, element, storyline, and category prose, persisted Yjs state is authoritative. A
snapshot-only document and a document with remaining updates are both hydrated from Yjs. The
`contentJson` column is used only when that entity has never established any Yjs state, in which
case it remains the editor's never-initialized seed. A malformed persisted Yjs state rejects the export
instead of silently substituting a possibly stale projection.

Soft-deleted nodes, elements, storylines, and categories are omitted. Library items are
hard-deleted in the current schema, so every remaining local `library_item` row is active.

### Archive contents and limits

The export covers every project in the local library and is saved as
`drifting-all-books-markdown-<date>.zip`. The ZIP root contains a library-level `README.md` and an
`index.md` listing every book; each project then contributes its own index plus Markdown documents
for current chapters, drifts, elements, element categories, storylines, comments, and library
notes. Curated entity relations, comment targets, storyline membership, category membership, and
inline `entityLink` marks become portable `[[path|title]]` links. User-controlled path segments
are normalized and combined with a stable ID suffix.

This is a **readable migration archive**, not a lossless backup:

- image and PDF binary files are not included;
- local paths, caches, runtime state, credentials, Agent execution journals, and database-only
  metadata are not included;
- the ZIP cannot be imported to recreate the exact SQLite/Yjs state.

Binary assets belong in the future versioned genesis/backup format used by SyncEngine, where they
can be addressed by content hash and verified during restore.

The native save contract accepts only one bounded `.zip` filename and rejects renderer payloads
larger than 256 MiB. Canceling the OS picker is a no-op rather than an export failure.

### Machine acceptance

Run:

```bash
pnpm vitest run src/renderer/services/export/relational-markdown.acceptance.test.ts
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml native_capabilities::tests::archive_filename_is_a_single_bounded_zip_segment
```

The acceptance suite proves snapshot-only Yjs, update-log Yjs, never-initialized seed fallback, soft-delete
exclusion, safe ZIP paths, forward/reverse Wiki links, flush-before-read ordering, the local-only
settings entry, and the absence of hosted project/sync calls in the export implementation.
