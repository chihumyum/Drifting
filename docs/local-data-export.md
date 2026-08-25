# Local relational Markdown export

The default local-only build exposes **Settings → Sync & Data → Local data → Export
relational Markdown**.
The export does not require a Drifting account and does not call the hosted project graph,
entity mutation flush, remote Yjs sync, or any hosted asset/service API.

## Consistency boundary

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

## Archive contents and limits

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

## Machine acceptance

Run:

```bash
pnpm vitest run src/renderer/services/export/relational-markdown.acceptance.test.ts
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml native_capabilities::tests::archive_filename_is_a_single_bounded_zip_segment
```

The acceptance suite proves snapshot-only Yjs, update-log Yjs, never-initialized seed fallback, soft-delete
exclusion, safe ZIP paths, forward/reverse Wiki links, flush-before-read ordering, the local-only
settings entry, and the absence of hosted project/sync calls in the export implementation.
