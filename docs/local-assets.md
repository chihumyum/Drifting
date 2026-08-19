# Local project assets

Status: **current architecture**.

Drifting is pre-release. This document defines the only supported asset format;
development databases created by an older build must be reset. The repository's
clean-over-compatibility rule lives in [`../AGENTS.md`](../AGENTS.md).

## Authority and ownership

- SQLite is the metadata authority and the app-owned `assets/` directory is the
  byte authority.
- `project_asset` is an immutable description of one imported source:
  `id`, `projectId`, `kind`, `sourceMime`, `sourceSizeBytes`, `sourceSha256`,
  optional image dimensions, and `createdAt`.
- Ownership is expressed exactly once: `library_item.assetId` owns an image or
  PDF; `element.portraitAssetId` owns a portrait image.
- Provider file IDs, revisions, cursors, transfer sessions, and retry state do
  not belong in `project_asset`. SyncEngine stores them in its own
  replica/transport tables.

`LibraryItem.kind` is the only payload discriminator:

| kind | required payload | forbidden payload |
| --- | --- | --- |
| `image` / `pdf` | `assetId` | external URL and text body |
| `url` | `externalUrl`; optional `previewImageUrl` | asset and text body |
| `text` | optional canonical TipTap `bodyJson` | asset and external URL |

`notesJson`, when present, is also a canonical TipTap document. Picker paths are
command input only and are never persisted in a domain row, sync operation, or
Markdown export.

## On-disk layout

The native platform owns this layout under `$APPLOCALDATA/assets/`:

```text
assets/<projectId>/<assetId>/source.<ext>
assets/<projectId>/<assetId>/display.jpg
assets/<projectId>/<assetId>/thumbnail.jpg
```

`source` is durable authored data. `display` and `thumbnail` are rebuildable
projections. The renderer accesses all three through the typed `assetStore`
platform contract; it does not construct filesystem paths or use HTTP fallback.

## Import transaction boundary

1. The native picker returns a temporary app-owned import path.
2. Image/PDF processing validates type and limits, computes SHA-256, and prepares
   the source plus derivatives.
3. Every variant write settles before a failed import removes its asset
   directory, preventing a late sibling write from recreating an orphan.
4. The use case commits `project_asset` and its owner reference in one SQLite
   transaction.
5. Only after commit does it release the picker import. A failed transaction
   removes the uncommitted asset directory.

Deletion first commits removal of owner/metadata and then deletes the app-owned
directory. Project deletion captures every live asset ID in its SQLite
transaction and performs file cleanup after commit.

The remaining commit-to-file-cleanup crash window is current-format durability,
not compatibility, and is independent of whether a cloud provider is enabled.
Restart-safe inventory/GC must account for staging files, released picker
imports, and directories with no live `project_asset` row.

## Network and sync boundary

Normal import, display, replacement, deletion, project boot, and online/offline
events never call a hosted asset API. Project boot reads the complete local
replica; no remote graph-hydration path exists. Binary sources enter a provider
only through the SyncEngine blob lane after the author connects that provider.

SyncEngine publishes in dependency order:

```text
content-addressed source blob -> immutable asset metadata -> owner operation
```

Google Drive and a future hosted provider implement the same opaque object/log
contract. They transport bytes and immutable records; local SQLite still owns
transactions, merge rules, Yjs application, and domain validation.

The relational Markdown ZIP intentionally omits binary bytes and is not a
restorable backup. Portable genesis/checkpoint packages must include each
reachable source blob by SHA-256.

## Machine acceptance

- `src/renderer/services/local-project-asset.service.test.ts` covers successful
  import, cleanup, and the delayed-sibling write failure.
- `src/renderer/services/local-project-assets.acceptance.test.ts` locks the
  clean model, local-only platform path, and absence of retired upload/runtime
  concepts.
- `src/renderer/sqlite-repo/project-deletion-repo.integration.test.ts` verifies
  fresh-schema foreign keys and complete project/Yjs/asset metadata deletion.

Manual desktop/iOS/Android picker, import, restart, preview, replacement, and
project-deletion checks remain in
[`qa/tauri-native-manual-regression.md`](qa/tauri-native-manual-regression.md).
