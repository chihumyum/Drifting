# Moving a book between libraries

Status: **current desktop feature** (the shelf). Mobile is paused.

Each Hosted account has its own library and signed-out writing has the local
library ([account-isolated libraries](hosted-sync/account-libraries.md)). Only
one library is open per process, and signing in never brings a book along. To
carry one book from one library into another (local library → account library,
account → account, or a second copy in the same library), the author exports it
as a `.driftingbook` file and imports that file in the library that should
receive it. Nothing is ever imported automatically and an import never
overwrites a book: it always adds a new one.

## What the author sees

- **Export**: the arrow-out icon among a book card's hover actions on the shelf
  (beside edit and move to Recently Deleted), labelled *Export this book
  (.driftingbook)*. Drifting saves pending edits, builds the file and asks
  where to save `<book name>.driftingbook`.
- **Import**: *Import book* with `.driftingbook` beside it, a cell in the
  shelf's left column (its tooltip reads *Import book (.driftingbook)*). Both
  labels name the extension, so the import is not mistaken for the in-book
  manuscript import (Word, Markdown). After a file is picked an *Importing*
  card stands on the shelf until the book appears.
- A failed import names the reason (not a Drifting book, exported by a newer
  Drifting, damaged, too large, the account's storage is full, or a write
  failure) and leaves the library as it was.

The copy carries the whole book: chapters and ideas with their live prose,
outline structure, storylines and their membership, elements, categories,
templates, facts, aliases, relations and relation types, comments and their
actions, element patches, Plot Grids, acts, timeline markers, Project Memory,
material notes, folders, images and PDFs (source, display and thumbnail bytes),
and what was in the book's own trash. It does not carry Agent conversations,
entity history snapshots, Markdown folder bindings, share links or anything
device-local; word counts and other projections are rebuilt.

## File format (version 1)

A CBOR map (`src/renderer/services/book-transfer/book-file.ts`):

```text
format             "drifting.book"
version            1
exportedAt, title
packageBytes       an ordinary sync snapshot package, payload v2 (docs/sync-engine)
commitMarkerBytes  its commit marker, binding the package SHA-256
assets[]           { assetId, variants[] { variant: source|display|thumbnail, ext, bytes } }
```

The package is exactly what a checkpoint publishes: authored rows, compacted
canonical reducer state and full Yjs state for every prose document. Integrity
comes from the package itself (every page and document is hashed, the marker
binds the package) and from the source SHA-256 each asset row records. Display
and thumbnail bytes are rebuildable and unverified. A file is at most 1 GiB.

## Export

`exportBook` (`export-book.ts`) runs `captureSnapshot` for the book's active
SyncGeneration, in one SQLite read transaction, with an asset port that reads
the source bytes from the library's own asset store and verifies them against
the row's SHA-256, size and MIME. Nothing is staged in the sync object store and
nothing in the library changes. A book with open sync gaps, conflicts or
quarantined objects cannot be captured and is not exported. The renderer then
hands the bytes to `book_transfer_save` (`src-tauri/src/book_transfer.rs`) as a
raw IPC body; the native save dialog writes them.

## Import

`importBook` (`import-book.ts`):

1. `book_transfer_open` returns the picked file's bytes (raw IPC body). The
   envelope is decoded, then the package is validated with
   `validateSnapshotForRestore`, the same validation a cloud restore runs, and
   every asset's source bytes are checked against the package.
2. **New identities.** The change-sets inside a package are content-addressed
   and name the original ids, so they cannot be re-keyed, and restore would
   mark checkpoints and blobs as already published. Instead every row id gets a
   fresh UUID (`id-rewriter.ts`) and every value naming one is rewritten:
   foreign keys, order scopes, document ids, JSON columns, reducer registers,
   and Yjs element attributes, text marks and embeds. Plot Grid document and
   cell ids are derived again from their rewritten parts. Block ids inside
   prose are kept: they are always scoped by their document. The copy shares no
   id with its original or with an earlier import of the same file, so per-book
   renderer state and Markdown folders start fresh.
3. **Fresh journal.** `planBookReplay` (`reducer-replay.ts`) turns the source's
   canonical reducer state into this installation's own authored mutations:
   one `entity.create` per live or trashed entity whose row is in the package,
   then its fields, tuples, set members, order positions and asset binds; a
   second change-set trashes what was in the trash (one change-set holds one
   lifecycle transition per entity). Registers of purged or superseded
   incarnations are dropped.
4. **Assets first.** Each asset's variants are written to the asset store
   under the new project and asset ids, behind an import marker, and the native
   blob port verifies the source into the sync object store.
5. **One transaction.** The rewritten rows, a new active SyncGeneration, the
   verified blob receipts, the reseeded Yjs documents and both change-sets
   (recorded and observed by the production domain kernel, exactly as a local
   write) commit together. Projections (KV and alias JSON, order columns, Plot
   Grid JSON) are rebuilt from the replayed authority while every entity is
   live, before the trash change-set. If anything fails the transaction rolls
   back, the asset files are deleted and the staged blobs discarded.
6. After commit the import markers are cleared and authored-commit observers
   run, so word counts, Markdown and sync proceed as after any local write.

In an account library the new SyncGeneration stages a pending provider binding,
so the book is published like any book written there, after
`assertHostedQuotaAllows` has refused a book the account cannot hold.

## Acceptance

`pnpm book-transfer:evidence` runs the renderer suites below and the native
`book_transfer` tests, and writes
[`acceptance/book-transfer.json`](acceptance/book-transfer.json) with the
hashes of the sources they cover; `pnpm book-transfer:check` verifies it is
current.

- `book-transfer.integration.test.ts` builds the built-in sample (every authored
  table, live prose with entity links, seven illustrations with all variants,
  element portraits) in one library, trashes an element, exports it and imports
  it into a second library. The copy's authored state equals the original's
  with every id replaced and none shared; projections and live prose (marks
  included) match; every asset's bytes arrive under a new id with a verified
  receipt; the journal holds two local change-sets and the element is trashed.
  The copy exports again and imports into a third library. The same file
  imports twice into its own library beside the untouched original. In a
  library connected to an account the copy's new SyncGeneration gets a pending
  provider binding, its blobs wait for upload and the storage check is asked
  about the book's source bytes. A damaged asset, a non-book file and a newer
  version are refused with nothing written, and a failed activation rolls back
  rows, asset files and staged blobs.
- `id-rewriter.test.ts`: identity rewriting, derived Plot Grid ids, and Yjs
  attributes, marks and embeds with text and block ids untouched.
- `book-file.test.ts`: the envelope and its refusals; file names.
- `src/renderer/platform/tauri.test.ts`: raw-body save and open contracts.
- Native: file-name validation and the read limit.

A desktop development profile (`pnpm dev:seed:lite --frontend-debug`) was also
run on 2026-11-03 with only the two native pickers stubbed in the renderer: the
card's export action produced a 5.7 MB file of the lite sample (21 chapters,
six images and PDFs), and *Import book* (then in the account menu; since
2026-11-03 a cell in the shelf's left column) showed the
Importing card for about eight seconds, then the second copy. In the App's own
database every authored table had the same row count, no id was shared, all 31
prose documents' live text matched, every stored asset variant was present
under the new ids, and the copy opened on Project Home with its word counts
rebuilt.

Not yet covered: the native pickers in a packaged build, and publishing an
imported book to a Hosted account end to end (the pending binding is the
ordinary new-project path, but no round trip against the service has run).
