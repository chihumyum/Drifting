# Phase 1 — normalized authored authorities

Status: closed for the clean pre-release baseline. Checkpoint code does not
smuggle whole-JSON or numeric projections back into the protocol. The manifest
excludes those fields, capture includes their normalized tables and reducer
metadata, and restore rebuilds every projection while the SyncGeneration is still
staged before activating it atomically.

No legacy backfill, dual-write compatibility path, or old-database migration is
part of this closure. The baseline schema is the only supported starting point.
The old `demo:seed`/`demo:purge-local` utility was retired because its raw SQL
writes could manufacture projection-only databases outside these writers.

## Completed authority slices

The KV and alias authority slice is implemented in the fresh local-first
baseline. `entity_kv_entry` owns stable rows for project facts, project
storyline templates, storyline facts, category element templates and element
facts. Each replacement reconciles stable entry IDs and emits
`entity.create`/`field.set`/`entity.purge` plus `order.move` in the same
authored SQLite transaction that rebuilds the legacy JSON projection. New
storylines and elements create new entry IDs rather than sharing template row
identity.

Element aliases are a normalized-value OR-set. Their reducer target kind is
`alias`, their persisted `sync_set_tag.set_key` is `aliases`, removals cite the
observed live add tags, and `aliases_json` is a deterministic projection of the
live member set. Generic project/storyline/category/element mutations no
longer carry the complete KV or alias JSON values.

Storyline, drift-group, element-patch, library-item, KV-entry and Plot Grid axis
ordering use `sync_order_register`. The register stores an ASCII Rocicorp
fractional-indexing `positionKey`; numeric columns for those discrete lists are
deterministic query/UI ranks rebuilt by sorting `(positionKey UTF-8 bytes,
entityId UTF-8 bytes)`. Numeric projections are never encoded back into the
wire key. Moving a group between parent scopes replaces its single order
register rather than leaving a second stale scope entry. Manual and Agent
create/update/restore paths derive new keys from adjacent current authority
registers.

Bottom Timeline positions are continuous authored coordinates, not discrete
list ranks. `book_node.book_order`, `book_node.narrative_order`, and
`book_act.start_order` are finite real LWW fields. Their exact numeric value is
preserved through mutation, checkpoint, and restore. Chapter sequence,
narrative-time sequence, and act segmentation sort by `(coordinate, entity ID
UTF-8 bytes)`, so the coordinate is both visual placement and semantic order
without a second fractional authority that can snap it to a rank.
`book_order` and `narrative_order` retain the immutable baseline's SQLite
`INTEGER` affinity: SQLite stores non-integral values in those columns as REAL,
and Drizzle's ordinary numeric integer mapping does not round them. This keeps
existing migration hashes stable without sacrificing continuous placement.

The Bottom Timeline owns a usable default coordinate interval even when it has
no placed chapters. Creating a narrative marker or an act boundary therefore
does not depend on chapter existence. Chapter tiles, narrative markers and act
boundaries all use the host axis's affine pixel-to-coordinate inverse; grid
lines are presentation only and never become an insertion-slot or rounding
policy.

Empty marker and act tracks retain the same right-click creation menus as
populated tracks. The act-rail head `+` creates exactly one first act at the
book-axis head; a bare-track context-menu action creates it at the clicked
coordinate. A book-head anchored act (`startOrder = null`) is optional and
movable, not a permanent opener. Moving it writes a finite coordinate, after
which chapters to its left intentionally belong to no act. New first acts are
created with a finite coordinate, and deleting an act never promotes another
boundary to the book head.

A chapter drop is one `chapter-timeline-move` authored transaction. It always
writes the selected `bookOrder` or `narrativeOrder` LWW register and, when the
target lane changes, updates the storyline membership OR-set and primary
storyline LWW register in that same SQLite transaction. Default-lane drops keep
membership, unaffiliated-lane drops clear it, and real Storyline drops replace
the old primary while preserving secondary memberships. This means independent
coordinate and membership edits merge by their named authorities, while a
single field edited concurrently resolves by the existing deterministic
HLC/writer LWW rule.

The shared chapter pointer controller preserves the exact source-relative grab
offset for both full-size track cards and narrow unplaced chips. The compositor
ghost is the only placement preview; there is no separate chapter-center drop
indicator whose geometry could disagree with the grabbed point or card shape.

Pre-release chapter fractional-order effects are retired history. They are not
captured into new checkpoints and are not revalidated as part of a later scalar
timeline write. A newly authored chapter `order.move` still fails closed with
`domain.unsupported-order`, preventing the retired representation from
re-entering current state.

## Normalized authority inventory

| Existing projection | Required v1 authority | Closure |
| --- | --- | --- |
| `project.kv_json` | First-class stable KV-entry rows owned by `(project, facts)`, with entry lifecycle/LWW fields and a `sync_order_register` position key | **Closed in the KV/alias writer slice:** manual and Agent project writers reconcile stable entries and rebuild this projection in one transaction. |
| `project.storyline_template_kv_json` | The same KV-entry model under `(project, storyline-template)` | **Closed in the KV/alias writer slice:** project template edits reconcile stable entries; storyline creation clones their values under fresh entry IDs. |
| `storylines.kv_json` | Stable ordered KV-entry rows under `(storyline, facts)` | **Closed in the KV/alias writer slice:** manual and Agent storyline writers use entry lifecycle, LWW fields and order registers. |
| `element_category.element_template_kv_json` | Stable ordered KV-entry rows under `(element-category, element-template)` | **Closed in the KV/alias writer slice:** category template edits reconcile stable entries; element creation clones their values under fresh entry IDs. |
| `element.kv_json` | Stable ordered KV-entry rows under `(element, facts)` | **Closed in the KV/alias writer slice:** manual, Agent and history-restore writes converge through the normalized writer. |
| `element.aliases_json` | Normalized-value OR-set in `sync_set_tag` (`setKey=aliases`), with UI projection rebuilt from live tags | **Closed in the KV/alias writer slice:** manual, Agent and history-restore writes emit observed-tag `set.add`/`set.remove` operations and rebuild the deterministic projection. |
| `node_content.plot_grid_json` | `plot_grid_document` size tuple; stable `plot_grid_row` and `plot_grid_column` identities with ordered-set position keys; stable `plot_grid_cell` identity/value; row/column labels as LWW fields | **Closed in the Plot Grid vertical slice below:** generic content writers exclude `plotGridJson`; desktop/mobile planners emit named mutations and rebuild the sparse projection transactionally. |
| `book_node.book_order` | Authored finite real LWW field; query/UI order sorts `(bookOrder, node ID)` | **Closed:** manual, Agent, restore and checkpoint paths preserve the exact coordinate; no chapter `sync_order_register` is written or materialized. |
| `book_node.narrative_order` | Authored nullable finite real LWW field; query/UI order sorts placed chapters by `(narrativeOrder, node ID)` | **Closed:** Bottom Timeline writes the continuous pointer-derived coordinate directly, while `null` remains the explicit unplaced state. |
| `storylines.order_key` | `sync_order_register` position key in the project storyline list | **Closed:** manual and Agent storyline writers emit `order.move`; generic payloads omit `orderKey`. |
| `drift_group.sort_order` | `sync_order_register` position key scoped by project + parent group | **Closed:** every group has finite local projection plus one register; reparenting changes that register's scope. |
| `element_patch.order_key` | `sync_order_register` position key scoped to the owning element | **Closed:** typed patch create/update paths emit `order.move`; generic payloads omit `orderKey`. |
| `library_item.order_key` | `sync_order_register` position key in the project library list | **Closed:** create/update ordering is journaled and the numeric column is projection only. |
| `book_act.start_order` | Authored nullable finite real LWW field on the book axis | **Closed:** `null` is an optional movable book-head anchor, while finite boundaries may leave a leading no-act interval; exact coordinates survive create/move/delete/spread/checkpoint flows without act-list rank projection. |

The shared KV model must be a first-class domain table, not a generic metadata
blob. A suitable baseline shape is one `entity_kv_entry` table with stable
`id`, `project_id`, `owner_kind`, `owner_id`, `namespace`, `key`, and `value`;
membership/lifecycle and ordering remain explicit reducer concepts. Plot Grid
likewise needs explicit tables because rows, columns, and cells have independent
identity and merge behavior.

## Closure and acceptance

1. Every discrete-list writer above mutates normalized rows/tags/registers
   inside the same `runAuthoredTransaction` as its legacy UI projection;
   continuous timeline writers atomically update their scalar row and LWW field.
2. KV entry create/update/remove and ordering use stable IDs; aliases use
   `set.add/set.remove`; list insertion/move uses `generateKeyBetween`; an
   explicit multi-entity reorder uses one `order.rebalance` change-set whose
   entries come from `generateNKeysBetween`. Reducers never rebalance on their
   own.
3. Plot Grid emits named row/column/cell/size mutations rather than one
   `field.set(plotGridJson)`.
4. Checkpoint capture includes the new authored tables through the generated
   manifest and the reducer metadata already present in `reducerState`.
5. Restore materializes normalized rows and deterministically rebuilds
   `kv_json`, aliases, `plot_grid_json`, and discrete numeric ordering
   projections before SyncGeneration activation, while preserving authored
   timeline coordinates exactly.
6. Tests cover non-empty KV/template/alias/grid data and multiple reordered
   entities, then compare canonical semantic state before and after restore.
7. The old lossy-projection capture guard has been removed only after the
   normalized capture/restore test passed.
8. Empty chapter axes still expose marker/act context menus and accept
   coordinate-specific creation. The act-head `+` creates one first act at the
   left edge, and that first act remains movable so a no-act prefix is legal.
9. Bottom Timeline and
   Storyline Graph share one compositor-backed pointer drag for placed and
   unplaced chapters, and each drop calls one atomic timeline move.

Capture first checks that every normalized KV, authored discrete list, and Plot
Grid axis has its required order authority, so an incomplete checkpoint cannot
be published. Restore validation checks normalized KV ownership and Plot Grid
document/axis/cell reachability. Restore loads authored tables and reducer
metadata, rebuilds excluded projections using the staged `syncGenerationId`,
and sets the SyncGeneration to `active` only at the end of the same activation
transaction. The end-to-end fixture deliberately corrupts excluded discrete
projections before capture and verifies canonical reconstruction from
fractional authority. It separately verifies that chapter and act coordinates
retain their exact pre-capture real values because those values are authored.

The following excluded fields are not blockers: `created_at/updated_at` are HLC
projections, `outline_json` and word-count basis are rebuilt from Yjs, and
`library_item.preview_image_url` is a local network/cache projection.

## Completed vertical slice — Plot Grid

The Plot Grid authority is now normalized in the single pre-release baseline:

- `plot_grid_document` owns the per-node `(cell_width, cell_height)` tuple.
- `plot_grid_row` and `plot_grid_column` own stable IDs, labels, and explicit
  position keys; bytewise key order uses stable ID as the tie-break.
- `plot_grid_cell` has one deterministic stable identity per
  document/row/column coordinate and keeps empty-string values after a clear,
  while the JSON projection remains sparse.
- Desktop and mobile editors diff UI snapshots into named size, row, column,
  label, cell, and removal mutations. `useBookContent` no longer accepts
  `plotGridJson` through its generic create/update API.
- One `plot-grid.mutate` authored transaction updates normalized rows, appends
  `tuple.set`/`entity.create`/`field.set`/`order.move`/`entity.purge` mutations,
  and deterministically rebuilds `node_content.plot_grid_json`. Axis deletion
  explicitly purges affected stable cells before the local FK cascade.

The current UI only appends or deletes axes. Reordering an existing axis without
an explicit `order.move` writer fails closed; no array index is silently
promoted back into sync authority. Checkpoint capture includes all four Plot
Grid tables, validates their reference graph, and restores the sparse JSON
projection from those rows before SyncGeneration activation.

Focused evidence:

```bash
pnpm exec vitest run \
  src/renderer/domain/plot-grid.test.ts \
  src/renderer/usecase/plot-grid-write.integration.test.ts \
  src/renderer/usecase/normalized-kv-alias-authority.integration.test.ts \
  src/renderer/sync/journal/order-authority.test.ts \
  src/renderer/sync/reducer/reducer.test.ts \
  src/renderer/sync/checkpoint/checkpoint.integration.test.ts \
  src/renderer/sync/protocol/domain-manifest.test.ts

pnpm exec tsx scripts/generate-sync-domain-manifest.ts --check
```

The checked-in machine-readable results are
[`acceptance/phase1-fractional-order-authority.json`](acceptance/phase1-fractional-order-authority.json)
for discrete lists and
[`acceptance/phase1-continuous-timeline-authority.json`](acceptance/phase1-continuous-timeline-authority.json)
for the continuous chapter/marker/act axis.
