# Library backup and restore

Status: **current desktop feature** (Settings → Sync & Data → Local data).

A `.drifting` file is a complete copy of the local library: every project's
SQLite rows and Yjs prose, plus the original image/PDF bytes and their display
and thumbnail variants. It is the restorable counterpart to the readable
[relational Markdown export](local-data-export.md), which is not a backup.

## Package format (version 1)

A ZIP archive with exactly these entries:

```text
manifest.json                                  format, version, app version, creation time,
                                               project list, per-file SHA-256 and size
library.sqlite                                 VACUUM INTO snapshot (deflated)
assets/<project>/<asset>/<variant>.<ext>       source / display / thumbnail (stored)
```

Asset paths use the on-disk segment form shared with the Tauri asset store
(`asset_store::sanitized_asset_segment`). Only assets referenced by
`project_asset` rows are packaged; import markers are not. A referenced asset
whose directory is missing on the exporting device is counted in
`missingAssets` and reported to the author instead of failing the export.

## Export

1. The renderer flushes local persistence and drains transactions.
2. The SQLite worker writes `VACUUM INTO` between transactions; the library is
   never modified.
3. The snapshot must pass `integrity_check`, the foreign-key check and the
   exact embedded migration history, and must be a local, stable library.
4. The package is written beside the chosen destination, fsynced and moved into
   place atomically.

## Restore

Restore is split so nothing live changes until the author confirms:

1. **Inspect** extracts the chosen file into
   `<databases>/library-restore/<id>/`, rejects unexpected entries, unsafe
   paths, size or checksum mismatches, then prepares `candidate.sqlite`: the
   public migrations are applied (a backup from a newer build is refused),
   every project is assigned to the current library owner, and every sync
   writer is retired so the next local write starts a fresh writer identity.
2. **Confirm** shows the creation time, project names, file counts and size.
   Cancelling discards the staging directory.
3. **Restore** runs as one SQLite worker request: it closes the open library,
   saves it as `<databases>/safety-backups/pre-restore/Drifting-pre-restore-*.drifting`
   (newest three kept), merges asset files additively, removes WAL sidecars and
   atomically replaces the database file. The renderer then reloads.

Asset identifiers are immutable, so merging never deletes a file: an existing
derivative is kept and an existing source is replaced only when its checksum
differs from the backup. A failure before activation reopens the original
library for the same renderer session. A crash at any point leaves either the
old or the new database, each with every asset file it references.

## Sync boundary

Both export and restore require the library to be local and stable. While a
cloud provider is connected or a transition is in progress, the controls are
disabled and the native side refuses with `library-sync-connected`; disconnect
sync first. Restored libraries are always local. Reconnecting a restored
library uses the ordinary connect flow, which has not been separately
validated for restored libraries; retired writers only guarantee that no
published writer sequence is reused.

## Machine-checkable evidence

- `cargo test -p drifting-core --lib library_backup`: export contents, restore
  replacement with additive asset merge and a rollback package, refusal of
  cloud-bound libraries, tampered/unexpected/traversal entries and newer
  schemas, retention, and the gateway close/restore/reopen lease.
- `src/renderer/platform/database.test.ts` and
  `src/renderer/services/backup/library-backup.service.test.ts`: command
  contract, summaries, settle-before-export/restore order and reload only on
  success.
- `src/renderer/services/backup/library-backup.acceptance.test.ts`: settings
  wiring, native ownership and this document.

Manual desktop interaction with the native file dialogs is not claimed by these
tests.
