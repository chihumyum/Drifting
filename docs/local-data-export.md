# Local relational Markdown export

Finished-manuscript EPUB, PDF and Word export is separate; see
[manuscript export](manuscript-export.md).

## Automatic project Markdown folder

Chapter and drift files are two-way: edits saved in any editor merge back into
Drifting while it runs, and edits made while it was closed merge when the project
opens. Every other file is generated and read-only. The merge model, ledger and
safeguards are in [Markdown folder two-way sync](markdown-mirror.md).

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
created when a project opens and refreshed after local authored commits and remote
project changes. Background refreshes wait until no commit has arrived for 5
seconds, and at most 30 seconds after the oldest change not yet projected, so
continuous typing does not keep re-exporting the project. They serialize captures
and replace only changed files. Closing the project, and the local lifecycle flush
that runs before the app quits, capture any change not yet projected (or retry a
failed capture) at once instead of waiting for the pause; a reopened project's
first capture waits for its closing one. The native quit waits at most 5 seconds
for the whole lifecycle flush; see [desktop quit persistence](desktop-quit-persistence.md).
Only the open project's rows and Yjs state are captured. While the project stays
open its renderer keeps the prose it hydrated, keyed by each document's persisted
Yjs revision, so a capture reads Yjs state only for documents changed since the
previous one. A capture that the renderer cannot match fails and drops that cache;
the next capture is complete. Closing the project releases it.
Automatic captures wait while the active editor is composing IME text and check
again between asynchronous stages. Manual refresh and lifecycle flush still run;
the authoritative incremental Yjs save path is independent of this deferral.

```text
开始阅读.md
正文/
  目录.md
  001 序章.md                    # chapters before the first act stay outside acts
  01 第一幕/
    本幕.md
    002 雨夜.md
构想/
  片段/窗边的片段.md
要素/
  人物/
    分类说明.md
    林岚.md
故事线/主线.md
资料/
  建筑参考.md
  附件/建筑参考.pdf
注释与待办.md
导出说明.md
.drifting/manifest.json
```

The directory is designed for readers. Every element and storyline is one
complete named document containing its summary, prose and related links. Every
chapter and drift is one editable file: frontmatter with `drifting-id`, writing
status and summary, then the prose. There are no per-entity ID folders or `index.md`/`prose.md` pairs.
The home page shows the project title, capture time, which files are editable and entry
links. The chapter directory follows reading order, with summaries and writing
status; chapters are numbered and grouped using the existing act boundaries.
Pre-act chapters remain unassigned, and empty acts have their own guide. Drift
folders use existing drift groups, and element folders use existing categories.
Scene/beat/note headings are `#`, `##` and `###`; the file name is the title.
Comments and TODOs are collected by target in `注释与待办.md`, with links from
related documents.

Names are normalized, bounded by UTF-8 byte length and cleaned for filesystem and
Markdown safety, including Windows reserved names. Case-insensitive collisions
receive a deterministic short suffix; full IDs do not appear in readable names.
Titles and aliases remain intact inside the document. Chapter filenames express
order rather than the authored floating-point timeline coordinate. Rename,
reorder or grouping changes can change paths: every capture rebuilds all internal
links, while external hand-written links are not guaranteed to survive.

Reader-facing YAML contains alias lists and writing status; chapter and drift
files add `drifting-id` and the summary, and keep other properties verbatim. The hidden
`.drifting/manifest.json` stores generation time, content hashes and a `documents`
identity map (`key`, `path`, `title`, `anchor`, canonical `sourceVersion`).
`anchor` is always `null` and is kept only for manifest schema 3 compatibility;
all comments map to the aggregate `注释与待办.md`.
Resolve identities through this map rather than guessing filenames. The existing
project output location is retained for in-place upgrades; the project's title is
shown in the reading home page. All internal navigation, relations, mentions and
citations use file-relative Markdown destinations, so the whole directory can be
opened as a vault or moved beneath any folder in an existing vault. Obsidian's
own settings are unmanaged. No plugin or generated `.obsidian` configuration is
required. See [Obsidian links](https://obsidian.md/help/links) and
[aliases](https://obsidian.md/help/aliases) for target syntax.

Prose stays plain text: the projection writes no Obsidian block anchors
(`^drift-…`) and no `#^` link fragments (2026-10-23). Mentions, passage and range
citations, relations and comment links open the whole target file; empty editor
blocks are omitted and deleted entities render as plain labels.
The Agent's `drifting:` citation protocol and tool `read_chapter` numbering stay
unchanged. Disk prose adds metadata and adapts links, so its physical
line numbers and file hashes **are not** tool line numbers or versions.
`documents[].sourceVersion` in the manifest holds the source tool version at capture time. Reread
through authorized tools for current coordinates before a write.

Referenced live element portraits and library image/PDF sources are copied from
the current project's app-owned asset store into
`资料/附件/<readable owner title>.<ext>`. Notes contain relative embeds and an
original-file link. Unsupported source image formats (for example HEIC and TIFF)
include the existing JPEG display derivative for preview. Copying is local-only;
no remote download or hosted API is triggered. Missing metadata, missing local
bytes, source size/hash mismatch or unavailable preview rejects the refresh before
managed files change, and settings report the error. Attachments share the
20,000-file/256-MiB generation limit with Markdown. Manual ZIP export below retains
its existing text-only scope.

**Only chapter and drift files sync back.** A refresh overwrites edits to every
other file. Creating, deleting, renaming or moving files is not synced: a deleted
chapter file is generated again. Drifting never replaces chapter or drift bytes it
has not read; an edit it cannot merge is kept under `.drifting/preserved`. On
Unix, chapter and drift files are mode 0600, generated files are mode 0400 and
created directories are mode 0700. This is not a boundary against the same
OS user deliberately changing permissions. The projection omits CRDT history,
runtime records and full database metadata; it is not a lossless backup.

The same local durability barrier and authoritative Yjs hydration as ZIP export
precede generation; in-flight local asset writes are also drained. A failed/corrupt
capture does not publish fabricated prose. Every source attachment is verified
against its captured immutable size and SHA-256 before any managed output changes.
Writes use same-directory atomic replacement per file; the manifest is published
last with generation time and SHA-256 hashes of Markdown and binary attachments.
A private `.drifting/pending-manifest.json` records file ownership before writing, so interrupted
generation can be retried without overwriting unrelated files. It is removed after
successful publication and is not a freshness indicator. Multi-file reads are not
a transaction: verify hashes against an unchanged manifest, or retry while refresh
is pending. A write interrupted partway may leave a hash mismatch until the next
refresh. Settings and the project overview expose errors; derived-output failure
never blocks saving the authoritative manuscript.

Closed projects retain their last snapshot; consult the manifest time and reopen
to refresh. Soft-deleted entities and their unreferenced attachments disappear on
refresh. A project in Recently Deleted keeps its last projection; permanently
deleting a project removes its manifest-owned files at the current
location and the location preference after stopping/draining its writer. Previously
retained locations remain. Unmanaged files (including `.obsidian`) are preserved;
collisions with newly generated paths reject the write before managed prose
changes. Path traversal, duplicate paths, symlinks and hard-linked files are
rejected; only manifest-owned files (including interrupted-write claims) may be
removed. Manifest schema 3 identifies the readable format and entity map. Schema 1/2 root
`manifest.json` and interrupted `.pending-manifest.json` ownership are still read.
A successful refresh publishes the new hidden manifest, removes old owned paths
and legacy manifests, and prunes only empty managed folders. Unmanaged files and
Obsidian configuration remain. Existing projections upgrade on the next successful refresh
without changing the output path or deleting user files.

MCP settings retain one line pointing external Agents to the Markdown folder
and its settings location. MCP initialization, projection settings, the directory
README and the shared project overview state that chapter and drift files are
two-way, merge as the author's own edits without Agent review, and that every
other file is read-only. The path is local to the computer running Drifting. External file
reads do not satisfy the MCP session's read-before-write requirement. New MCP
connections resolve the saved output preference; existing connections can query
`get_project_overview` for the updated directory and generation status.

Machine evidence for this projection and shared prose access is generated by
`pnpm mcp:acceptance` in
[`agent-runtime/acceptance/local-mcp.json`](agent-runtime/acceptance/local-mcp.json).
It includes production SQLite/Yjs source-version agreement, portable relative links without
block anchors, alias lists, attachment plans, literal
search, scheduler behavior, readable naming, rename/reorder link regeneration and native filesystem writes.
`node scripts/run-markdown-projection-settings.mjs` generates
[`projection-settings-ui.json`](agent-runtime/acceptance/projection-settings-ui.json)
from browser clicks on the real React settings components in English and Chinese.
It covers cancellation, choose/reset/refresh, failure feedback and narrow desktop
layout, with synthetic picker/service actions. Pass `--check` to verify its source
fingerprint. The native OS folder-picker dialog is not exercised by this browser
report; filesystem and scheduling behavior are tested separately above.

`node scripts/run-obsidian-projection-acceptance.mjs` generates
[`obsidian-projection.json`](agent-runtime/acceptance/obsidian-projection.json)
using an isolated installed Obsidian profile and synthetic vaults. It checks actual
metadata-cache link resolution, absent block anchors, alias lists and image/PDF rendering
for a projection embedded inside another vault. No personal vault or manuscript is
used. Pass `--check` to verify the report's source fingerprint.

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

This is a **readable migration archive**, not a lossless backup (use a
[`.drifting` library backup](library-backup.md) for that):

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
