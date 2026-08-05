import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
  blob,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
// schema definition in users' local sqlite database.

// project
// Domain: Project
//
// kvJson: this project's own list of key/value facts (book goal, writing
// style, reference works, etc). Stored as a JSON array of { key, value }
// strings — see domain/kv.ts. New projects are seeded with a small default
// set; users can add/remove/edit freely after.
//
// storylineTemplateKvJson: project-level KV template seeded into every new
// storyline created under this project (e.g. POV, protagonist). Editing
// here only affects future storylines — existing rows are untouched.
// Same shape as kvJson.
export const ProjectTable = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  summary: text('summary').notNull().default(''),
  kvJson: text('kv_json').notNull().default('[]'),
  storylineTemplateKvJson: text('storyline_template_kv_json').notNull().default('[]'),
  userId: text('user_id').notNull(), // should reference to userId in server pg
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});


// Element Category
// project(1) <-> elementCategory(N)
// elementCategory(1) <-> element(N)
// Domain: BookElementCategory
//
// elementTemplateJson holds the default TipTap doc seeded into a newly-created
// element whose categoryId points at this row. Empty doc ({}) means "no
// template" and the element starts blank. Editing here only affects future
// elements — existing elements are untouched (see useBookElement.createElement).
//
// layoutMode/gridX/gridY drive SuperElementView placement. 'auto' = solver
// picks the slot (skyline packer, see lib/super-element-layout). 'pinned' =
// user dragged this category and gridX/gridY hold its grid-cell anchor; the
// solver treats pinned categories as obstacles when packing the rest.
export const ElementCategoryTable = sqliteTable(
  'element_category',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    contentJson: text('content_json').default('{}'),
    elementTemplateJson: text('element_template_json').default('{}'),
    // KV template seeded into every new element of this category (e.g.
    // 别名 / 出生地 / 阵营). Same JSON array shape as Project.kvJson — see
    // domain/kv.ts. Editing only affects future elements.
    elementTemplateKvJson: text('element_template_kv_json').notNull().default('[]'),
    color: text('color').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    layoutMode: text('layout_mode').notNull().default('auto'), // 'auto' | 'pinned'
    gridX: integer('grid_x'),
    gridY: integer('grid_y'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // Renamed from `description_json` in migration 0029. Storyline + element
    // category each have one body editor; the column carried the wrong noun
    // for what it stored. New name aligns with element.content_json and
    // node_content.content_json. Project summary is a separate text column.
  },
  (t) => [
    index('idx_element_category_project').on(t.projectId),
    index('idx_element_category_deleted_at').on(t.deletedAt),
  ],
);

// Project Asset
// Cloud-backed binary assets owned by a project. R2 is the canonical source;
// Native clients keep per-device local cache files derived from these object keys.
export const ProjectAssetTable = sqliteTable(
  'project_asset',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('image'),
    role: text('role').notNull().default('element_portrait'),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    status: text('status').notNull().default('pending'),
    sourceObjectKey: text('source_object_key'),
    displayObjectKey: text('display_object_key'),
    thumbnailObjectKey: text('thumbnail_object_key'),
    sourceMime: text('source_mime'),
    displayMime: text('display_mime'),
    thumbnailMime: text('thumbnail_mime'),
    sourceSizeBytes: integer('source_size_bytes'),
    displaySizeBytes: integer('display_size_bytes'),
    thumbnailSizeBytes: integer('thumbnail_size_bytes'),
    sourceSha256: text('source_sha256'),
    width: integer('width'),
    height: integer('height'),
    completedAt: text('completed_at'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_project_asset_project').on(t.projectId),
    index('idx_project_asset_owner').on(t.ownerKind, t.ownerId),
    index('idx_project_asset_status').on(t.status),
  ],
);

// Durable native asset uploads. This table is intentionally device-local and
// never enters entity sync. It stores only app-owned file/cache coordinates and
// workflow metadata; short-lived presigned URLs and credentials are never
// persisted. The polymorphic owner is checked by the upload coordinator.
export const AssetUploadJobTable = sqliteTable(
  'asset_upload_job',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').notNull(),
    role: text('role').notNull(),
    stage: text('stage').notNull().default('queued'),
    sourcePath: text('source_path').notNull(),
    sourceMime: text('source_mime'),
    sourceSizeBytes: integer('source_size_bytes'),
    displayMime: text('display_mime'),
    displaySizeBytes: integer('display_size_bytes'),
    thumbnailMime: text('thumbnail_mime'),
    thumbnailSizeBytes: integer('thumbnail_size_bytes'),
    width: integer('width'),
    height: integer('height'),
    assetId: text('asset_id'),
    previousAssetId: text('previous_asset_id'),
    deletePreviousAssetOnCancel: integer('delete_previous_asset_on_cancel', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_asset_upload_job_owner').on(t.projectId, t.ownerKind, t.ownerId),
    index('idx_asset_upload_job_project_stage').on(t.projectId, t.stage),
  ],
);

// Storylines
// project(1) <-> storyline(N)
// storyline(N) <-> node(N)
// Domain: Storyline
//
// kvJson: this storyline's own KV facts (本章 POV / 关键人物 / 时间线 …).
// Seeded from the parent project's storylineTemplateKvJson at creation;
// after that the storyline owns its copy. JSON array, see domain/kv.ts.
//
// nodeContentTemplateJson: TipTap doc JSON seeded into NodeContent.contentJson
// when a new node is created under this storyline. '{}' means "no template"
// and the new node starts with an empty doc. Edits affect future nodes only.
export const StorylineTable = sqliteTable(
  'storylines',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    summary: text('summary').notNull().default(''),
    orderKey: integer('order_key').notNull(),
    contentJson: text('content_json').notNull().default('{}'),
    kvJson: text('kv_json').notNull().default('[]'),
    nodeContentTemplateJson: text('node_content_template_json').notNull().default('{}'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_storyline_deleted_at').on(t.deletedAt)],
);

// Story Nodes
// Domain: BookNode
export const BookNodeTable = sqliteTable(
  'book_node',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    // Pure sortable integer for book/reading order. Nullable: drift nodes
    // have no place on the reading order axis and store NULL here. Chapters
    // always carry a value (even when their primary storyline link has been
    // removed — the "未归属" state preserves the order).
    bookOrder: integer('book_order'),
    // Author-defined position on the narrative timeline (separate axis from
    // book order — allows flashbacks / non-linear chronology). Nullable: a
    // node may not yet be placed on the narrative axis.
    narrativeOrder: integer('narrative_order'),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    // Materialized word count, derived from this node's content.
    // Updated on every save; defaults to 0 for nodes that have never been edited.
    wordCount: integer('word_count').notNull().default(0),
    // Author-facing chapter status, selected directly from the editor menu.
    // Stored as plain text — the enum lives in the domain layer (see WritingStatus).
    writingStatus: text('writing_status').notNull().default('draft'),
    // Explicit discriminator between 'chapter' and 'drift'. Replaces the
    // historical "mainStorylineId nullability" implicit discriminator. A
    // chapter without a primary storyline link is now a legal state ("未归属"
    // / unaffiliated chapter); the type was previously forced to drift.
    // See domain/book-node.ts for the WritingStatus enum split.
    kind: text('kind').notNull().default('drift'),
    // Optional containing drift group (left-panel folder). NULL = root level /
    // ungrouped. Drift-only: chapters always NULL — grouping is a drift
    // affordance. Plain column, no declarative FK: PRAGMA foreign_keys is off
    // and group delete reparents children up in useDriftGroup (not SET NULL).
    driftGroupId: text('drift_group_id'),
    // Soft-delete marker. Non-null = in trash. List queries must filter
    // `deletedAt IS NULL`. Pro/Studio feature — Free tier still hard-deletes.
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // story graph view positions
    positionX: real('position_x').notNull(),
    positionY: real('position_y').notNull(),
  },
  (t) => [
    index('idx_book_node_project').on(t.projectId),
    index('idx_book_node_project_book_order').on(t.projectId, t.bookOrder),
    index('idx_book_node_project_narrative_order').on(t.projectId, t.narrativeOrder),
    index('idx_book_node_project_kind').on(t.projectId, t.kind),
    index('idx_book_node_drift_group').on(t.driftGroupId),
    index('idx_book_node_deleted_at').on(t.deletedAt),
  ],
);

// Drift group (左栏分组) — nested folder for organizing drift nodes in the
// left panel. Multi-level via `parent_group_id` (NULL = root-level group).
// Drift-only: chapters never carry a group. Membership lives on
// book_node.drift_group_id. Cascades are client-side (useDriftGroup reparents
// a deleted group's child groups + drifts up to its parent); the only
// declarative FK is project_id (cascade) so a project delete sweeps its
// groups. `sort_order` is reserved for a future manual right-click reorder —
// NULL in v1, where groups render by createdAt ascending.
export const DriftGroupTable = sqliteTable(
  'drift_group',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    parentGroupId: text('parent_group_id'), // null = root-level group
    color: text('color'),
    sortOrder: real('sort_order'), // reserved for manual reorder; null in v1
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_drift_group_project').on(t.projectId),
    index('idx_drift_group_parent').on(t.parentGroupId),
  ],
);

// Node Contents (Separate to avoid loading huge JSONs when listing nodes)
// Domain: NodeContent
export const NodeContentTable = sqliteTable(
  'node_content',
  {
    nodeId: text('node_id')
      .primaryKey()
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    contentJson: text('content_json').default('{}'),
    outlineJson: text('outline_json').default('[]'),
    // In-chapter plot planner grid (mini-Excel scratchpad). Sparse JSON,
    // authored upstream of prose — NOT derived from it and NOT part of the
    // dependency analysis. Lives here for the same per-node 1:1 cache reasons as
    // outlineJson. See domain/plot-grid.ts for the shape.
    plotGridJson: text('plot_grid_json').default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_node_content_node').on(t.nodeId)],
);

// Story-graph edges live in `entity_relation` now — rows with fromKind/toKind
// = 'node' and the user-defined relation category in `kind`. Visual columns
// (anchors/control points/style) from the legacy `book_node_edge` table were
// never read by the renderer and were dropped by migration 0021.

// Book element
// Domain: BookElement
//
// groupName is a lightweight secondary grouping within a category — just a
// label, no separate entity. Elements sharing the same (categoryId, groupName)
// are rendered together inside the category. Null = "ungrouped" bucket, which
// SuperElementView renders last. Rename by SQL update; delete by setting to
// null. If we ever need ordering or colors, promote to ElementGroupTable.
export const BookElementTable = sqliteTable(
  'element',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    // Nullable since the trash refactor (migration 0028): when a category is
    // soft-deleted or hard-deleted, its elements detach to NULL ("未分类")
    // instead of cascading. Restoring the category does NOT re-link them.
    categoryId: text('category_id').references(() => ElementCategoryTable.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    summary: text('summary').notNull().default(''),
    contentJson: text('content_json').notNull().default('{}'),
    // Element's own KV facts. Seeded at creation from the parent category's
    // elementTemplateKvJson; once seeded, the element owns its copy. JSON
    // array, same shape as Project.kvJson — see domain/kv.ts.
    kvJson: text('kv_json').notNull().default('[]'),
    // Alternate names this entity is referred to by ("Lady Mira", "M.",
    // "the heir"). Stored as JSON-encoded string[]. Drives auto-linking and
    // copilot context: aliases participate in mention detection, dedup, and
    // patch attribution the same way `name` does. Uniqueness across name +
    // aliases is enforced in the app layer (useBookElement), not by SQL —
    // see migration 0030.
    aliasesJson: text('aliases_json').notNull().default('[]'),
    groupName: text('group_name'),
    portraitAssetId: text('portrait_asset_id').references(() => ProjectAssetTable.id, {
      onDelete: 'set null',
    }),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_element_deleted_at').on(t.deletedAt),
    index('idx_element_category').on(t.categoryId),
    index('idx_element_portrait_asset').on(t.portraitAssetId),
  ],
);

// Node <-> Storyline (Many-to-Many)
// Node <-> Storyline (Many-to-Many)
// `isPrimary` marks the node's primary storyline — the one whose lane the
// node sits in on BottomTimeline / StoryGraphView, and the storyline its
// bookOrder is keyed to. At most one row per node may have isPrimary=true,
// enforced by the partial unique index below + write-path guards.
//
// Chapters typically have one isPrimary row. They may also have additional
// (non-primary) link rows for secondary memberships. Drift nodes are never
// allowed to have link rows at all — see write-path guards in useBookNode.
export const NodeStorylineLinkTable = sqliteTable(
  'node_storyline_link',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    storylineId: text('storyline_id')
      .notNull()
      .references(() => StorylineTable.id, { onDelete: 'cascade' }),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.storylineId] }),
    index('idx_node_storyline_node').on(table.nodeId),
    index('idx_node_storyline_storyline').on(table.storylineId),
    // At most one primary storyline per node. Partial unique — only rows with
    // is_primary = true participate.
    uniqueIndex('uniq_node_primary_storyline')
      .on(table.nodeId)
      .where(sql`${table.isPrimary} = 1`),
  ],
);

// Element Patch
// Author-written addendum to an element, anchored at a chapter (or specific
// block within a chapter). Patches are additive content — they never override
// the element's canonical fields. UI groups them on the element page and
// surfaces block-level patches as marginalia inside the chapter.
//
//   sourceNodeId | sourceBlockId | meaning
//   -------------|---------------|----------------------------
//   non-null     | null          | chapter-level: "from this chapter onwards"
//   non-null     | non-null      | block-level: annotation on a specific block
//   null         | null          | floating: no chapter affiliation yet
//   null         | non-null      | (invalid — enforced in app layer)
export const ElementPatchTable = sqliteTable(
  'element_patch',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    elementId: text('element_id')
      .notNull()
      .references(() => BookElementTable.id, { onDelete: 'cascade' }),

    sourceNodeId: text('source_node_id').references(() => BookNodeTable.id, {
      onDelete: 'set null',
    }),
    sourceBlockId: text('source_block_id'),
    // Snapshot of the sourceBlock's plain text at the moment the patch was
    // accepted. Surfaced in the UI when the original block has since been
    // deleted from the chapter, so the user can still read what the patch
    // was based on. Nullable because rows created before this column
    // existed have no snapshot, and patches manually authored from the
    // chapter sidebar (no Copilot pipeline) don't carry one either.
    sourceBlockText: text('source_block_text'),

    // Precise text-fragment anchor (JSON of CommentTextAnchor: startBlockId,
    // startOffset, endBlockId, endOffset, text) when the patch was created by
    // selecting a span of prose in the chapter. NULL for floating / block-only
    // / chapter-only patches. Drives invalidation: if the anchored `text` can
    // no longer be found in the source chapter, the patch is invalidated.
    textAnchorJson: text('text_anchor_json'),
    // Set (ISO timestamp) when the anchored source text was deleted/rewritten
    // out of the source chapter, NULL while the anchor still resolves. Stored
    // as TEXT (not a real timestamp) so it round-trips through the JSON sync
    // payload unchanged. Invalidated patches are EXCLUDED from Agent
    // canon context (deleted evidence ⇒ no longer a sanctioned evolution) but
    // still shown — badged — in the element editor so the user can act on them.
    invalidatedAt: text('invalidated_at'),

    title: text('title'),
    contentJson: text('content_json').notNull().default('{}'),

    orderKey: integer('order_key').notNull().default(0),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_patch_element').on(t.elementId),
    index('idx_patch_source_node').on(t.sourceNodeId),
    index('idx_patch_project').on(t.projectId),
  ],
);

// Block Section
// Per-chapter rolling summary of a contiguous range of blocks ("blocks 15-27:
// tavern fight escalates into Bjorn's challenge"). Produced as a side-effect
// of a Copilot debounce run (whichever capabilities consume the dirty block
// batch trigger one summary call afterwards), and consumed by later debounces
// to give the model recent-context without re-feeding raw prose.
//
// Validity is tracked by `blockSignature` — a stable hash of the section's
// blockIds + the current text of each block at write time. Read paths
// recompute the signature and discard the row when it doesn't match (the
// prose has changed since the summary was written).
//
// Multiple producers eventually: 'copilot-rolling' is the current source;
// future 'reverse-outline' / 'manual' will join. blockIdsJson is JSON-encoded
// ordered string[] for the same reason aliasesJson is — SQLite can't index
// inside an array, and we don't need it to.
export const BlockSectionTable = sqliteTable(
  'block_section',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    // Chapter this section belongs to. Cascade on chapter delete — a summary
    // without its chapter is meaningless.
    chapterId: text('chapter_id')
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    blockIdsJson: text('block_ids_json').notNull(),
    // Per-block content fingerprints stored at write time. JSON object
    // shaped { [blockId]: textHash }. On read, the coverage map recomputes
    // each block's current hash and compares — blocks whose hash changed
    // become "uncovered" individually, but the section's summary is still
    // valid for the unchanged blocks. Replaces the old single-section
    // `block_signature` column (migration 0032 / server 0031). This is what
    // makes mid-chapter edits not invalidate the whole section.
    blockHashesJson: text('block_hashes_json').notNull().default('{}'),
    summary: text('summary').notNull().default(''),
    // 'copilot-rolling' | 'reverse-outline' | 'manual'. Stored as text so a
    // new producer can land without a migration.
    source: text('source').notNull().default('copilot-rolling'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_block_section_project').on(t.projectId),
    index('idx_block_section_chapter').on(t.chapterId),
  ],
);

// Entity Relation
// User-curated directed link between two entities. Source of truth for cross-
// entity associations the user explicitly asserts: comment→node, library_item→
// element, node→node (story-graph edges), element↔element, etc.
//
// "Curated" not "manual" — provenance (who created the row) is irrelevant to
// the table's purpose; an AI-suggested relation accepted by the user would
// land here too. Distinct from `inline_mention`, which is a derived index of
// @-mentions sitting inside an entity's manuscript content.
//
// Polymorphic both ways. FK is not enforced on the kind/id columns; orphans
// are cleaned up explicitly when an endpoint entity is deleted.
export const EntityRelationTable = sqliteTable(
  'entity_relation',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),

    // fromKind ∈ EntityKind (all 7) — comment / library_item can link OUT.
    // toKind   ∈ StructuralEntityKind (5) — comment / library_item are never targets.
    // See domain/entity-kinds.ts for the canonical vocabulary + guards.
    fromKind: text('from_kind').notNull(),
    fromId: text('from_id').notNull(),
    toKind: text('to_kind').notNull(),
    toId: text('to_id').notNull(),

    // Free-form user category for the relation itself (NOT the endpoint type
    // — that's fromKind/toKind). Nullable string, no fixed vocabulary; the
    // StoryGraph and SuperElement views surface it as filter chips and feed
    // it from their respective manual-create modals.
    kind: text('kind'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_relation_from').on(t.fromKind, t.fromId),
    index('idx_relation_to').on(t.toKind, t.toId),
    index('idx_relation_project').on(t.projectId),
  ],
);

// Inline Mention
// Derived index of entityLink marks projected from manuscript content. One row
// per (fromBlock, toEntity) pair; multiple spans in the same block collapse
// into fromSpansJson. Rebuilt on every save of the source document by
// reference-projection.service.
//
// Strictly structural on both ends — comment / library_item don't have
// manuscripts to host marks, and inline marks always target whole entities
// (never deep-linking to a specific block).
//
// Not a source of truth — `entity_relation` is. Deleting an inline_mention
// row by hand is meaningless; it'll come back on the next projection.
export const InlineMentionTable = sqliteTable(
  'inline_mention',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),

    // Both endpoints must be StructuralEntityKind. See domain/entity-kinds.ts.
    fromKind: text('from_kind').notNull(),
    fromId: text('from_id').notNull(),
    fromBlockId: text('from_block_id').notNull(),
    fromSpansJson: text('from_spans_json').notNull(),

    toKind: text('to_kind').notNull(),
    toId: text('to_id').notNull(),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_mention_from').on(t.fromKind, t.fromId),
    index('idx_mention_to').on(t.toKind, t.toId),
    index('idx_mention_project').on(t.projectId),
  ],
);

// Comment
// Single home for {block-anchored notes, chapter-anchored TODOs, project-level
// floating TODOs, AI suggestions}. Replaced the former `manuscript_comment` +
// `memo` split — see drizzle/0034 for the consolidation.
//
// Anchor matrix (target_* are nullable; the row uses whichever depth it needs):
//   target_kind   target_id   target_block_id   meaning
//   'node'        chapterId   blockId           block-anchored (manuscript)
//   'node'        chapterId   null              chapter-anchored, no block
//   null          null        null              floating (project-level TODO)
//
// `kind` distinguishes the comment's role: 'note' is the classic Word-style
// marginal annotation; 'todo' surfaces in the right-sidebar TODO list and is
// what agent pipelines consume as actionable instructions.
//
// Still independent from ElementPatch: patches are additive canonical content
// for an element; comments carry review/annotation state and feed action
// records via comment_action.
export const CommentTable = sqliteTable(
  'comment',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('note'), // 'note' | 'todo'
    targetKind: text('target_kind'), // nullable: StructuralEntityKind or null when floating
    targetId: text('target_id'),
    targetBlockId: text('target_block_id'),
    anchorJson: text('anchor_json').notNull().default('{}'),
    authorKind: text('author_kind').notNull().default('user'), // user | ai | copilot | external
    authorId: text('author_id'),
    authorName: text('author_name'),
    bodyJson: text('body_json').notNull().default('{}'),
    status: text('status').notNull().default('open'), // open | resolved | converted
    priority: text('priority'),
    source: text('source').notNull().default('manual'), // manual | copilot | api
    metadataJson: text('metadata_json'),
    // JSON array of block ids this comment anchors to (a consecutive range).
    // targetBlockId stays the primary/first (card position + back-compat); this
    // is the full span, written by manual selection and automated writers.
    targetBlockIdsJson: text('target_block_ids_json').notNull().default('[]'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_comment_project').on(t.projectId),
    index('idx_comment_target').on(t.targetKind, t.targetId),
    index('idx_comment_block').on(t.targetKind, t.targetId, t.targetBlockId),
    index('idx_comment_project_status').on(t.projectId, t.status),
    index('idx_comment_project_kind_status').on(t.projectId, t.kind, t.status),
  ],
);

// Comment Action
// Append-only-ish action record for operations initiated from a comment.
// Carries patch/apply/reject/copilot-suggestion actions; share this surface
// without changing Comment itself.
export const CommentActionTable = sqliteTable(
  'comment_action',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    commentId: text('comment_id')
      .notNull()
      .references(() => CommentTable.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    label: text('label'),
    payloadJson: text('payload_json').notNull().default('{}'),
    status: text('status').notNull().default('pending'), // pending | applied | failed
    resultJson: text('result_json'),
    createdByKind: text('created_by_kind').notNull().default('user'),
    createdById: text('created_by_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    appliedAt: text('applied_at'),
  },
  (t) => [
    index('idx_comment_action_comment').on(t.commentId),
    index('idx_comment_action_project').on(t.projectId),
    index('idx_comment_action_status').on(t.status),
  ],
);

// Library Item (formerly Material)
// Project-level "stuff I keep around": reference assets (image / pdf / url /
// markdown attachment) and free-form text notes that don't belong to any
// chapter and aren't tasks. Kinds:
//   'image' | 'pdf' | 'url' | 'markdown' — file or URL reference (uri set)
//   'text'                                — free-form note (bodyJson set,
//                                            uri/localPath/mime all empty)
// Source describes where the underlying payload lives:
//   'local' — legacy local-only item; uri/localPath point at the picked file
//   'url'   — uri is the http(s) URL itself
//   'r2'    — uri is asset://<project_asset.id>; local files are cache only
// 'markdown' attachments and 'text' notes store their TipTap doc in bodyJson.
// notesJson is the author's free-form annotations attached to the item.
// Linkage to chapters / elements / etc. goes through `entity_relation` with
// fromKind='library_item'.
export const LibraryItemTable = sqliteTable(
  'library_item',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    kind: text('kind').notNull(), // 'image' | 'pdf' | 'url' | 'markdown' | 'text'
    source: text('source').notNull().default('local'), // 'local' | 'url' | 'r2'
    uri: text('uri').notNull().default(''),
    localPath: text('local_path'),
    assetId: text('asset_id').references(() => ProjectAssetTable.id, { onDelete: 'set null' }),
    mime: text('mime'),
    sizeBytes: integer('size_bytes'),
    bodyJson: text('body_json'),
    notesJson: text('notes_json'),
    thumbnailUri: text('thumbnail_uri'),
    orderKey: integer('order_key').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_library_item_project').on(t.projectId),
    index('idx_library_item_project_kind').on(t.projectId, t.kind),
    index('idx_library_item_asset').on(t.assetId),
  ],
);

// Agent conversation (local-only chat history for the right-sidebar Agent).
// Display transcript lives here as a JSON blob; the SDK's own session file is
// the source of truth for *resuming* context — sdkSessionId points at it.
// Not synced cross-device (transcripts can be large / contain unpublished
// prose). Cascade-deletes with the project.
export const AgentConversationTable = sqliteTable(
  'agent_conversation',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    // The SDK session to `resume` for context continuity; null until the first
    // turn reports one. If the SDK's transcript file is gone, resuming starts
    // fresh — the conversation stays viewable from messagesJson regardless.
    sdkSessionId: text('sdk_session_id'),
    // Provider-neutral runtime session currently attached to this conversation.
    // Kept alongside sdkSessionId during the compatibility window: old Claude
    // conversations can still be inspected while new turns recover from the
    // canonical runtime tables below.
    runtimeSessionId: text('runtime_session_id'),
    // Which credentials the conversation last ran under ('byok' | 'hosted').
    mode: text('mode').notNull().default('byok'),
    // Serialized display transcript (AgentChatMessage[] — see domain).
    messagesJson: text('messages_json').notNull().default('[]'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_agent_conversation_project').on(t.projectId),
    index('idx_agent_conversation_project_updated').on(t.projectId, t.updatedAt),
    index('idx_agent_conversation_deleted_at').on(t.deletedAt),
    uniqueIndex('uniq_agent_conversation_project_identity').on(t.id, t.projectId),
  ],
);

// Canonical, provider-neutral Agent runtime persistence. Unlike
// AgentConversation.messagesJson (a compatibility/display cache), these rows
// are normalized recovery state. Runtime events are immutable and append-only.
export const AgentRuntimeSessionTable = sqliteTable(
  'agent_runtime_session',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    routeKind: text('route_kind').notNull(),
    conversationId: text('conversation_id').references(() => AgentConversationTable.id, {
      onDelete: 'cascade',
    }),
    goalRunId: text('goal_run_id'),
    chapterId: text('chapter_id'),
    provider: text('provider').notNull(),
    model: text('model'),
    // Bumped whenever provider-side resumable state is replaced. Recovery must
    // never attach an acknowledgement from an older epoch to a newer session.
    providerEpoch: integer('provider_epoch').notNull().default(0),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [
    index('idx_agent_runtime_session_project').on(t.projectId),
    index('idx_agent_runtime_session_conversation').on(t.conversationId),
    index('idx_agent_runtime_session_goal').on(t.projectId, t.goalRunId),
    index('idx_agent_runtime_session_recovery').on(t.projectId, t.status, t.updatedAt),
    uniqueIndex('uniq_agent_runtime_session_project_identity').on(t.id, t.projectId),
  ],
);

export const AgentRuntimeTurnTable = sqliteTable(
  'agent_runtime_turn',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => AgentRuntimeSessionTable.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().default('accepted'),
    promptMessageId: text('prompt_message_id'),
    acceptedAt: text('accepted_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_turn_session_ordinal').on(t.sessionId, t.ordinal),
    uniqueIndex('uniq_agent_runtime_turn_session_identity').on(t.id, t.sessionId),
    index('idx_agent_runtime_turn_session_status').on(t.sessionId, t.status),
  ],
);

export const AgentRuntimeMessageTable = sqliteTable(
  'agent_runtime_message',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => AgentRuntimeSessionTable.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').references(() => AgentRuntimeTurnTable.id, {
      onDelete: 'cascade',
    }),
    ordinal: integer('ordinal').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('accepted'),
    contentJson: text('content_json').notNull(),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_message_session_ordinal').on(t.sessionId, t.ordinal),
    index('idx_agent_runtime_message_turn_ordinal').on(t.turnId, t.ordinal),
  ],
);

export const AgentRuntimeEventTable = sqliteTable(
  'agent_runtime_event',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => AgentRuntimeSessionTable.id, { onDelete: 'cascade' }),
    turnId: text('turn_id')
      .notNull()
      .references(() => AgentRuntimeTurnTable.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    eventType: text('event_type').notNull(),
    payloadJson: text('payload_json').notNull(),
    wallTimeMs: integer('wall_time_ms').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_event_turn_seq').on(t.turnId, t.seq),
    index('idx_agent_runtime_event_session').on(t.sessionId),
  ],
);

export const AgentRuntimeToolCallTable = sqliteTable(
  'agent_runtime_tool_call',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => AgentRuntimeSessionTable.id, { onDelete: 'cascade' }),
    turnId: text('turn_id')
      .notNull()
      .references(() => AgentRuntimeTurnTable.id, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    name: text('name').notNull(),
    access: text('access').notNull(),
    status: text('status').notNull().default('requested'),
    idempotencyKey: text('idempotency_key').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    resultJson: text('result_json'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_tool_call_turn_call').on(t.turnId, t.callId),
    uniqueIndex('uniq_agent_runtime_tool_call_idempotency').on(t.idempotencyKey),
    uniqueIndex('uniq_agent_runtime_tool_call_write_provenance').on(
      t.id,
      t.sessionId,
      t.turnId,
      t.callId,
      t.idempotencyKey,
      t.access,
      t.name,
    ),
    index('idx_agent_runtime_tool_call_turn_status').on(t.turnId, t.status),
  ],
);

export const AgentRuntimeReadReceiptTable = sqliteTable(
  'agent_runtime_read_receipt',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    callId: text('call_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolAccess: text('tool_access').notNull().default('read'),
    idempotencyKey: text('idempotency_key').notNull(),
    resultBlob: blob('result_blob').notNull(),
    resultHash: text('result_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_read_receipt_tool_call').on(t.toolCallId),
    uniqueIndex('uniq_agent_runtime_read_receipt_idempotency').on(t.idempotencyKey),
    uniqueIndex('uniq_agent_runtime_read_receipt_provenance').on(
      t.id,
      t.projectId,
      t.sessionId,
      t.turnId,
      t.toolCallId,
    ),
    index('idx_agent_runtime_read_receipt_session_created').on(t.sessionId, t.createdAt),
    foreignKey({
      columns: [t.sessionId, t.projectId],
      foreignColumns: [AgentRuntimeSessionTable.id, AgentRuntimeSessionTable.projectId],
      name: 'fk_agent_runtime_read_receipt_session_project',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.turnId, t.sessionId],
      foreignColumns: [AgentRuntimeTurnTable.id, AgentRuntimeTurnTable.sessionId],
      name: 'fk_agent_runtime_read_receipt_turn_session',
    }).onDelete('cascade'),
    foreignKey({
      columns: [
        t.toolCallId,
        t.sessionId,
        t.turnId,
        t.callId,
        t.idempotencyKey,
        t.toolAccess,
        t.toolName,
      ],
      foreignColumns: [
        AgentRuntimeToolCallTable.id,
        AgentRuntimeToolCallTable.sessionId,
        AgentRuntimeToolCallTable.turnId,
        AgentRuntimeToolCallTable.callId,
        AgentRuntimeToolCallTable.idempotencyKey,
        AgentRuntimeToolCallTable.access,
        AgentRuntimeToolCallTable.name,
      ],
      name: 'fk_agent_runtime_read_receipt_tool_provenance',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeReadObservationTable = sqliteTable(
  'agent_runtime_read_observation',
  {
    id: text('id').primaryKey(),
    receiptId: text('receipt_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    revision: text('revision').notNull(),
    stateVector: blob('state_vector'),
    stateHash: text('state_hash'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_read_observation_ordinal').on(t.receiptId, t.ordinal),
    uniqueIndex('uniq_agent_runtime_read_observation_entity').on(
      t.receiptId,
      t.entityKind,
      t.entityId,
    ),
    uniqueIndex('uniq_agent_runtime_read_observation_provenance').on(
      t.id,
      t.receiptId,
      t.projectId,
      t.sessionId,
      t.turnId,
      t.toolCallId,
      t.entityKind,
      t.entityId,
      t.revision,
    ),
    index('idx_agent_runtime_read_observation_entity_revision').on(
      t.projectId,
      t.entityKind,
      t.entityId,
      t.revision,
    ),
    foreignKey({
      columns: [t.receiptId, t.projectId, t.sessionId, t.turnId, t.toolCallId],
      foreignColumns: [
        AgentRuntimeReadReceiptTable.id,
        AgentRuntimeReadReceiptTable.projectId,
        AgentRuntimeReadReceiptTable.sessionId,
        AgentRuntimeReadReceiptTable.turnId,
        AgentRuntimeReadReceiptTable.toolCallId,
      ],
      name: 'fk_agent_runtime_read_observation_receipt_provenance',
    }).onDelete('cascade'),
  ],
);

/**
 * Content-addressed backing bytes for oversized Agent tool results. References
 * below carry ownership/provenance; this table only owns immutable UTF-8 bytes.
 */
export const AgentRuntimeResultBlobTable = sqliteTable(
  'agent_runtime_result_blob',
  {
    contentHash: text('content_hash').primaryKey(),
    contentBlob: blob('content_blob').notNull(),
    byteCount: integer('byte_count').notNull(),
    charCount: integer('char_count').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_agent_runtime_result_blob_created').on(t.createdAt)],
);

/**
 * Durable resultRef ownership and original tool provenance. The full payload
 * remains local-only runtime state and is cascade-deleted with its session.
 */
export const AgentRuntimeResultArtifactTable = sqliteTable(
  'agent_runtime_result_artifact',
  {
    ref: text('ref').primaryKey(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    callId: text('call_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolAccess: text('tool_access').notNull().default('read'),
    idempotencyKey: text('idempotency_key').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    contentHash: text('content_hash')
      .notNull()
      .references(() => AgentRuntimeResultBlobTable.contentHash),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_result_artifact_tool_call').on(t.toolCallId),
    uniqueIndex('uniq_agent_runtime_result_artifact_provenance').on(
      t.ref,
      t.projectId,
      t.sessionId,
      t.turnId,
      t.toolCallId,
    ),
    index('idx_agent_runtime_result_artifact_session_created').on(
      t.projectId,
      t.sessionId,
      t.createdAt,
    ),
    index('idx_agent_runtime_result_artifact_content').on(t.contentHash),
    foreignKey({
      columns: [t.sessionId, t.projectId],
      foreignColumns: [AgentRuntimeSessionTable.id, AgentRuntimeSessionTable.projectId],
      name: 'fk_agent_runtime_result_artifact_session_project',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.turnId, t.sessionId],
      foreignColumns: [AgentRuntimeTurnTable.id, AgentRuntimeTurnTable.sessionId],
      name: 'fk_agent_runtime_result_artifact_turn_session',
    }).onDelete('cascade'),
    foreignKey({
      columns: [
        t.toolCallId,
        t.sessionId,
        t.turnId,
        t.callId,
        t.idempotencyKey,
        t.toolAccess,
        t.toolName,
      ],
      foreignColumns: [
        AgentRuntimeToolCallTable.id,
        AgentRuntimeToolCallTable.sessionId,
        AgentRuntimeToolCallTable.turnId,
        AgentRuntimeToolCallTable.callId,
        AgentRuntimeToolCallTable.idempotencyKey,
        AgentRuntimeToolCallTable.access,
        AgentRuntimeToolCallTable.name,
      ],
      name: 'fk_agent_runtime_result_artifact_tool_provenance',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeWriteEffectTable = sqliteTable(
  'agent_runtime_write_effect',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    routeKind: text('route_kind').notNull(),
    conversationId: text('conversation_id'),
    goalRunId: text('goal_run_id'),
    chapterId: text('chapter_id'),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    callId: text('call_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolAccess: text('tool_access').notNull().default('write'),
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * Immutable central authorization recorded before mutation. NULL is
     * reserved for effects created before this authorization contract existed.
     */
    authorizationKind: text('authorization_kind'),
    authorizationRequestId: text('authorization_request_id'),
    authorizationArgumentsHash: text('authorization_arguments_hash'),
    authorizedAt: text('authorized_at'),
    phase: text('phase').notNull().default('claimed'),
    argumentsJson: text('arguments_json').notNull(),
    expectedRevisionJson: text('expected_revision_json'),
    observedRevisionJson: text('observed_revision_json'),
    preimageJson: text('preimage_json'),
    forwardJson: text('forward_json'),
    inverseJson: text('inverse_json'),
    reversibility: text('reversibility'),
    effectJson: text('effect_json'),
    resultJson: text('result_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    claimedAt: text('claimed_at').notNull(),
    confirmedAt: text('confirmed_at'),
    mutationStartedAt: text('mutation_started_at'),
    effectCommittedAt: text('effect_committed_at'),
    resultCommittedAt: text('result_committed_at'),
    uncertainAt: text('uncertain_at'),
    failedAt: text('failed_at'),
    declinedAt: text('declined_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_write_effect_tool_call').on(t.toolCallId),
    uniqueIndex('uniq_agent_runtime_write_effect_idempotency').on(t.idempotencyKey),
    uniqueIndex('uniq_agent_runtime_write_effect_turn_call').on(t.turnId, t.callId),
    uniqueIndex('uniq_agent_runtime_write_effect_provenance').on(
      t.id,
      t.sessionId,
      t.turnId,
      t.toolCallId,
    ),
    uniqueIndex('uniq_agent_runtime_write_effect_freshness_provenance').on(
      t.id,
      t.projectId,
      t.sessionId,
      t.turnId,
      t.toolCallId,
    ),
    index('idx_agent_runtime_write_effect_session_phase').on(t.sessionId, t.phase),
    foreignKey({
      columns: [t.sessionId, t.projectId],
      foreignColumns: [AgentRuntimeSessionTable.id, AgentRuntimeSessionTable.projectId],
      name: 'fk_agent_runtime_write_effect_session_project',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.turnId, t.sessionId],
      foreignColumns: [AgentRuntimeTurnTable.id, AgentRuntimeTurnTable.sessionId],
      name: 'fk_agent_runtime_write_effect_turn_session',
    }).onDelete('cascade'),
    foreignKey({
      columns: [
        t.toolCallId,
        t.sessionId,
        t.turnId,
        t.callId,
        t.idempotencyKey,
        t.toolAccess,
        t.toolName,
      ],
      foreignColumns: [
        AgentRuntimeToolCallTable.id,
        AgentRuntimeToolCallTable.sessionId,
        AgentRuntimeToolCallTable.turnId,
        AgentRuntimeToolCallTable.callId,
        AgentRuntimeToolCallTable.idempotencyKey,
        AgentRuntimeToolCallTable.access,
        AgentRuntimeToolCallTable.name,
      ],
      name: 'fk_agent_runtime_write_effect_tool_provenance',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.conversationId, t.projectId],
      foreignColumns: [AgentConversationTable.id, AgentConversationTable.projectId],
      name: 'fk_agent_runtime_write_effect_conversation_project',
    }).onDelete('cascade'),
  ],
);

/**
 * Immutable domain receipt for certified element-patch commands. It is written
 * in the same SQLite transaction as element_patch and the sync outbox, closing
 * the crash window between a renderer mutation and the outer write-effect row.
 */
export const AgentRuntimeElementPatchReceiptTable = sqliteTable(
  'agent_runtime_element_patch_receipt',
  {
    id: text('id').primaryKey(),
    effectId: text('effect_id')
      .notNull()
      .references(() => AgentRuntimeWriteEffectTable.id, {
        onDelete: 'cascade',
      }),
    commandId: text('command_id').notNull(),
    direction: text('direction').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    toolName: text('tool_name').notNull(),
    patchId: text('patch_id').notNull(),
    expectedRevision: text('expected_revision'),
    resultRevision: text('result_revision'),
    postimageJson: text('postimage_json'),
    postimageHash: text('postimage_hash'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_element_patch_receipt_command').on(t.commandId, t.direction),
    uniqueIndex('uniq_agent_runtime_element_patch_receipt_effect').on(t.effectId, t.direction),
    index('idx_agent_runtime_element_patch_receipt_patch').on(t.projectId, t.patchId),
    foreignKey({
      columns: [t.sessionId, t.projectId],
      foreignColumns: [AgentRuntimeSessionTable.id, AgentRuntimeSessionTable.projectId],
      name: 'fk_agent_runtime_element_patch_receipt_session_project',
    }).onDelete('cascade'),
  ],
);

/**
 * Immutable receipt for certified non-prose entity commands. The typed
 * pre/post images are runtime recovery data, never authored entity metadata.
 */
export const AgentRuntimeEntityWriteReceiptTable = sqliteTable(
  'agent_runtime_entity_write_receipt',
  {
    id: text('id').primaryKey(),
    effectId: text('effect_id')
      .notNull()
      .references(() => AgentRuntimeWriteEffectTable.id, {
        onDelete: 'cascade',
      }),
    commandId: text('command_id').notNull(),
    direction: text('direction').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    toolName: text('tool_name').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    expectedRevision: text('expected_revision'),
    resultRevision: text('result_revision'),
    preimageJson: text('preimage_json'),
    preimageHash: text('preimage_hash'),
    postimageJson: text('postimage_json'),
    postimageHash: text('postimage_hash'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_entity_write_receipt_command').on(t.commandId, t.direction),
    uniqueIndex('uniq_agent_runtime_entity_write_receipt_effect').on(t.effectId, t.direction),
    index('idx_agent_runtime_entity_write_receipt_entity').on(
      t.projectId,
      t.entityKind,
      t.entityId,
    ),
    foreignKey({
      columns: [t.sessionId, t.projectId],
      foreignColumns: [AgentRuntimeSessionTable.id, AgentRuntimeSessionTable.projectId],
      name: 'fk_agent_runtime_entity_write_receipt_session_project',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeWriteExpectationTable = sqliteTable(
  'agent_runtime_write_expectation',
  {
    id: text('id').primaryKey(),
    effectId: text('effect_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    writeTurnId: text('write_turn_id').notNull(),
    writeToolCallId: text('write_tool_call_id').notNull(),
    observationId: text('observation_id').notNull(),
    readReceiptId: text('read_receipt_id').notNull(),
    readTurnId: text('read_turn_id').notNull(),
    readToolCallId: text('read_tool_call_id').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    expectedRevision: text('expected_revision').notNull(),
    expectedStateVector: blob('expected_state_vector'),
    expectedStateHash: text('expected_state_hash'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_write_expectation_observation').on(t.effectId, t.observationId),
    uniqueIndex('uniq_agent_runtime_write_expectation_entity').on(
      t.effectId,
      t.entityKind,
      t.entityId,
    ),
    index('idx_agent_runtime_write_expectation_effect').on(t.effectId),
    foreignKey({
      columns: [t.effectId, t.projectId, t.sessionId, t.writeTurnId, t.writeToolCallId],
      foreignColumns: [
        AgentRuntimeWriteEffectTable.id,
        AgentRuntimeWriteEffectTable.projectId,
        AgentRuntimeWriteEffectTable.sessionId,
        AgentRuntimeWriteEffectTable.turnId,
        AgentRuntimeWriteEffectTable.toolCallId,
      ],
      name: 'fk_agent_runtime_write_expectation_effect_provenance',
    }).onDelete('cascade'),
    foreignKey({
      columns: [
        t.observationId,
        t.readReceiptId,
        t.projectId,
        t.sessionId,
        t.readTurnId,
        t.readToolCallId,
        t.entityKind,
        t.entityId,
        t.expectedRevision,
      ],
      foreignColumns: [
        AgentRuntimeReadObservationTable.id,
        AgentRuntimeReadObservationTable.receiptId,
        AgentRuntimeReadObservationTable.projectId,
        AgentRuntimeReadObservationTable.sessionId,
        AgentRuntimeReadObservationTable.turnId,
        AgentRuntimeReadObservationTable.toolCallId,
        AgentRuntimeReadObservationTable.entityKind,
        AgentRuntimeReadObservationTable.entityId,
        AgentRuntimeReadObservationTable.revision,
      ],
      name: 'fk_agent_runtime_write_expectation_observation_provenance',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeWriteReviewTable = sqliteTable(
  'agent_runtime_write_review',
  {
    id: text('id').primaryKey(),
    effectId: text('effect_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    status: text('status').notNull().default('pending'),
    decisionNoteJson: text('decision_note_json'),
    revertEffectJson: text('revert_effect_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    acceptedAt: text('accepted_at'),
    rejectedAt: text('rejected_at'),
    revertStartedAt: text('revert_started_at'),
    settledAt: text('settled_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_write_review_effect').on(t.effectId),
    uniqueIndex('uniq_agent_runtime_write_review_provenance').on(t.id, t.effectId),
    index('idx_agent_runtime_write_review_session_status').on(t.sessionId, t.status),
    foreignKey({
      columns: [t.effectId, t.sessionId, t.turnId, t.toolCallId],
      foreignColumns: [
        AgentRuntimeWriteEffectTable.id,
        AgentRuntimeWriteEffectTable.sessionId,
        AgentRuntimeWriteEffectTable.turnId,
        AgentRuntimeWriteEffectTable.toolCallId,
      ],
      name: 'fk_agent_runtime_write_review_effect_provenance',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeWriteReviewBlockTable = sqliteTable(
  'agent_runtime_write_review_block',
  {
    reviewId: text('review_id').notNull(),
    effectId: text('effect_id').notNull(),
    blockId: text('block_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().default('pending'),
    decisionNoteJson: text('decision_note_json'),
    revertEffectJson: text('revert_effect_json'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    revertStartedAt: text('revert_started_at'),
    settledAt: text('settled_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reviewId, t.blockId] }),
    uniqueIndex('uniq_agent_runtime_write_review_block_ordinal').on(t.reviewId, t.ordinal),
    index('idx_agent_runtime_write_review_block_status').on(t.reviewId, t.status),
    foreignKey({
      columns: [t.reviewId, t.effectId],
      foreignColumns: [AgentRuntimeWriteReviewTable.id, AgentRuntimeWriteReviewTable.effectId],
      name: 'fk_agent_runtime_write_review_block_review',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeCheckpointTable = sqliteTable(
  'agent_runtime_checkpoint',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => AgentRuntimeSessionTable.id, { onDelete: 'cascade' }),
    throughTurnOrdinal: integer('through_turn_ordinal').notNull(),
    messageCount: integer('message_count').notNull(),
    contextJson: text('context_json').notNull(),
    contextHash: text('context_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_checkpoint_session_turn').on(t.sessionId, t.throughTurnOrdinal),
    index('idx_agent_runtime_checkpoint_session_created').on(t.sessionId, t.createdAt),
  ],
);

// Durable orchestration for tasks that cross model-budget slices or renderer
// restarts. These rows never replace authored content; they only track the
// Agent's explicit objective, progress, and live constraints.
export const AgentRuntimeTaskTable = sqliteTable(
  'agent_runtime_task',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    objective: text('objective').notNull(),
    scopeKind: text('scope_kind').notNull().default('explicit_targets'),
    workKind: text('work_kind').notNull().default('edit'),
    status: text('status').notNull().default('active'),
    revision: integer('revision').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_task_scope_identity').on(t.id, t.projectId, t.sessionId),
    uniqueIndex('uniq_agent_runtime_task_open_session')
      .on(t.projectId, t.sessionId)
      .where(sql`${t.status} IN ('active', 'paused', 'blocked')`),
    index('idx_agent_runtime_task_scope_status').on(
      t.projectId,
      t.sessionId,
      t.status,
      t.updatedAt,
    ),
    foreignKey({
      columns: [t.sessionId, t.projectId],
      foreignColumns: [AgentRuntimeSessionTable.id, AgentRuntimeSessionTable.projectId],
      name: 'fk_agent_runtime_task_session_project',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeTaskChapterManifestTable = sqliteTable(
  'agent_runtime_task_chapter_manifest',
  {
    taskId: text('task_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    resolvedChapterId: text('resolved_chapter_id').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.taskId, t.ordinal],
      name: 'pk_agent_runtime_task_chapter_manifest',
    }),
    uniqueIndex('uniq_agent_runtime_task_manifest_chapter').on(t.taskId, t.resolvedChapterId),
    index('idx_agent_runtime_task_manifest_scope').on(
      t.projectId,
      t.sessionId,
      t.taskId,
      t.ordinal,
    ),
    foreignKey({
      columns: [t.taskId, t.projectId, t.sessionId],
      foreignColumns: [
        AgentRuntimeTaskTable.id,
        AgentRuntimeTaskTable.projectId,
        AgentRuntimeTaskTable.sessionId,
      ],
      name: 'fk_agent_runtime_task_manifest_scope',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeTaskStepTable = sqliteTable(
  'agent_runtime_task_step',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    workKind: text('work_kind').notNull().default('edit'),
    targetKind: text('target_kind'),
    targetName: text('target_name'),
    resolvedTargetId: text('resolved_target_id'),
    status: text('status').notNull().default('pending'),
    resultNote: text('result_note'),
    resultRef: text('result_ref'),
    reviewResultJson: text('review_result_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_task_step_ordinal').on(t.taskId, t.ordinal),
    uniqueIndex('uniq_agent_runtime_task_step_scope_identity').on(
      t.id,
      t.taskId,
      t.projectId,
      t.sessionId,
    ),
    uniqueIndex('uniq_agent_runtime_task_step_in_progress')
      .on(t.taskId)
      .where(sql`${t.status} = 'in_progress'`),
    index('idx_agent_runtime_task_step_status').on(t.taskId, t.status, t.ordinal),
    foreignKey({
      columns: [t.taskId, t.projectId, t.sessionId],
      foreignColumns: [
        AgentRuntimeTaskTable.id,
        AgentRuntimeTaskTable.projectId,
        AgentRuntimeTaskTable.sessionId,
      ],
      name: 'fk_agent_runtime_task_step_scope',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeTaskConstraintTable = sqliteTable(
  'agent_runtime_task_constraint',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    body: text('body').notNull(),
    source: text('source').notNull().default('agent'),
    status: text('status').notNull().default('active'),
    // The checked-in migration owns the self-FK. Keeping this as a plain
    // column avoids Drizzle's recursive table type widening.
    supersededById: text('superseded_by_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    settledAt: text('settled_at'),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_task_constraint_scope_identity').on(
      t.id,
      t.taskId,
      t.projectId,
      t.sessionId,
    ),
    index('idx_agent_runtime_task_constraint_status').on(t.taskId, t.status, t.createdAt),
    foreignKey({
      columns: [t.taskId, t.projectId, t.sessionId],
      foreignColumns: [
        AgentRuntimeTaskTable.id,
        AgentRuntimeTaskTable.projectId,
        AgentRuntimeTaskTable.sessionId,
      ],
      name: 'fk_agent_runtime_task_constraint_scope',
    }).onDelete('cascade'),
  ],
);

export const AgentRuntimeTaskCommandTable = sqliteTable(
  'agent_runtime_task_command',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    callId: text('call_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolAccess: text('tool_access').notNull().default('write'),
    taskId: text('task_id').notNull(),
    argumentsHash: text('arguments_hash').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_runtime_task_command_call').on(t.turnId, t.callId),
    index('idx_agent_runtime_task_command_task').on(t.taskId, t.createdAt),
    foreignKey({
      columns: [t.taskId, t.projectId, t.sessionId],
      foreignColumns: [
        AgentRuntimeTaskTable.id,
        AgentRuntimeTaskTable.projectId,
        AgentRuntimeTaskTable.sessionId,
      ],
      name: 'fk_agent_runtime_task_command_scope',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.turnId, t.sessionId],
      foreignColumns: [AgentRuntimeTurnTable.id, AgentRuntimeTurnTable.sessionId],
      name: 'fk_agent_runtime_task_command_turn_session',
    }).onDelete('cascade'),
    foreignKey({
      columns: [
        t.toolCallId,
        t.sessionId,
        t.turnId,
        t.callId,
        t.idempotencyKey,
        t.toolAccess,
        t.toolName,
      ],
      foreignColumns: [
        AgentRuntimeToolCallTable.id,
        AgentRuntimeToolCallTable.sessionId,
        AgentRuntimeToolCallTable.turnId,
        AgentRuntimeToolCallTable.callId,
        AgentRuntimeToolCallTable.idempotencyKey,
        AgentRuntimeToolCallTable.access,
        AgentRuntimeToolCallTable.name,
      ],
      name: 'fk_agent_runtime_task_command_tool_provenance',
    }).onDelete('cascade'),
  ],
);

// Agent Memory
// A small, evolving store of author-level guidance that the General Agent
// reads as auxiliary context. Distinct from canon
// (the story world) and project facts (the structured governing KV): it holds
// the standing, cross-cutting meta — personal writing preferences, vetoed
// proposals, and standing directives. Anchored/block-local guidance lives in
// `comment` (source='manual', kind='exception'); this table is for the
// un-anchored / standing kind.
//   kind:   'preference' | 'veto' | 'directive'  (reserve 'episode' for session memory)
//   status: 'pending' | 'active' | 'dismissed'   — ONLY 'active' is ever fed to
//           an agent/judge; 'pending' awaits explicit author confirmation.
//   source: 'author' | 'agent'
// Mutating usecases and the Agent runtime persist the row plus sync outbox in
// one transaction. updatedAt and deletedAt also preserve local provenance.
export const AgentMemoryTable = sqliteTable(
  'agent_memory',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'preference' | 'veto' | 'directive'
    body: text('body').notNull().default(''),
    // Optional anchor (StructuralEntityKind) — veto/directive may point at an
    // entity; null for a standing, un-anchored memory.
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    targetBlockId: text('target_block_id'),
    source: text('source').notNull().default('agent'), // 'author' | 'agent'
    originRef: text('origin_ref'), // conversation / finding id it was captured from
    status: text('status').notNull().default('pending'), // 'pending' | 'active' | 'dismissed'
    supersedesId: text('supersedes_id'), // the older memory this one replaces
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_agent_memory_project').on(t.projectId),
    index('idx_agent_memory_project_status').on(t.projectId, t.status),
    index('idx_agent_memory_project_kind_status').on(t.projectId, t.kind, t.status),
    index('idx_agent_memory_target').on(t.targetKind, t.targetId),
  ],
);

// Act (幕) — boundary-based segment of the GLOBAL reading axis (bookOrder).
// Stores only where the act STARTS (`start_order`, REAL for fractional
// midpoint boundaries); membership derives as bookOrder >= startOrder and
// < the next act's startOrder. Exactly one act per project may carry
// start_order = NULL — the opener, covering from the book head. Empty acts
// (a planned 幕 with no chapters yet) are legal by construction. See
// domain/book-act.ts for derivation + the 打散 boundary-repair contract.
export const BookActTable = sqliteTable(
  'book_act',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    startOrder: real('start_order'), // null = book head (the opener act)
    // Optional bound drift node — the act's free-form notes / 大纲. SET NULL
    // is declarative only (PRAGMA foreign_keys off); unbind on drift delete /
    // drift→chapter conversion happens in useBookAct.unbindActsForDrift.
    driftNodeId: text('drift_node_id').references(() => BookNodeTable.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_book_act_project').on(t.projectId),
    index('idx_book_act_drift').on(t.driftNodeId),
  ],
);

// Timeline marker — user-pinned label on the NARRATIVE axis (narrativeOrder),
// optionally binding a drift node as its content (see domain/timeline-marker.ts
// for the binding contract). drift_node_id's SET NULL is declarative only —
// PRAGMA foreign_keys is off in this app, so drift delete / drift→chapter
// conversion unbind explicitly via unbindMarkersForDrift.
export const TimelineMarkerTable = sqliteTable(
  'timeline_marker',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    narrativeOrder: real('narrative_order').notNull(),
    label: text('label').notNull().default(''),
    driftNodeId: text('drift_node_id').references(() => BookNodeTable.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_timeline_marker_project').on(t.projectId),
    index('idx_timeline_marker_drift').on(t.driftNodeId),
  ],
);

// Device-local MCP configuration. Executable paths, loopback endpoints and
// extension authority are not authored manuscript state and never enter the
// sync outbox. Secret header/environment values live in the native keychain;
// these JSON fields contain only public values or keychain reference names.
export const AgentMcpServerTable = sqliteTable(
  'agent_mcp_server',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    transport: text('transport').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    command: text('command'),
    argsJson: text('args_json').notNull().default('[]'),
    cwd: text('cwd'),
    publicEnvJson: text('public_env_json').notNull().default('{}'),
    secretEnvJson: text('secret_env_json').notNull().default('{}'),
    url: text('url'),
    publicHeadersJson: text('public_headers_json').notNull().default('{}'),
    secretHeadersJson: text('secret_headers_json').notNull().default('{}'),
    toolPolicyJson: text('tool_policy_json').notNull().default('{}'),
    configRevision: text('config_revision').notNull(),
    healthStatus: text('health_status').notNull().default('disabled'),
    healthMessage: text('health_message').notNull().default(''),
    serverInfoJson: text('server_info_json').notNull().default('{}'),
    discoveredToolsJson: text('discovered_tools_json').notNull().default('[]'),
    lastCheckedAt: text('last_checked_at'),
    lastConnectedAt: text('last_connected_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_agent_mcp_server_project_name').on(t.projectId, t.name),
    uniqueIndex('uniq_agent_mcp_server_scope_identity').on(t.id, t.projectId),
    index('idx_agent_mcp_server_project_enabled').on(t.projectId, t.enabled),
  ],
);

// Exact-argument durable authority for dynamic tools. A grant is bound to the
// project, source/config revision, provider-visible tool, executable definition
// revision, access class and SHA-256 argument hash. Any drift fails closed.
export const AgentPermissionGrantTable = sqliteTable(
  'agent_permission_grant',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    scope: text('scope').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id').notNull(),
    providerToolName: text('provider_tool_name').notNull(),
    remoteToolName: text('remote_tool_name').notNull(),
    access: text('access').notNull(),
    argumentsHash: text('arguments_hash').notNull(),
    toolDefinitionRevision: text('tool_definition_revision').notNull(),
    sourceConfigRevision: text('source_config_revision').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('idx_agent_permission_grant_match').on(
      t.projectId,
      t.sourceKind,
      t.sourceId,
      t.providerToolName,
      t.argumentsHash,
      t.status,
    ),
    index('idx_agent_permission_grant_project_status').on(t.projectId, t.status, t.createdAt),
    index('idx_agent_permission_grant_session').on(t.sessionId, t.status),
  ],
);

// Entity snapshot history — the local "time machine" trail. One row per
// captured save-point of a prose entity (node/element/storyline/category):
// the full Yjs state, a contentJson preview (stale-OK, for the history UI),
// and a JSON bag of the entity's restorable metadata fields at capture time.
// Captured at most every 15 min per entity when the body actually changed
// (see services/snapshot-history.service.ts), thinned Time-Machine style and
// dropped after 30 days. Mirrors the server's `entity_snapshot` table so the
// same capture can be pushed to the cloud for synced users.
export const EntitySnapshotHistoryTable = sqliteTable(
  'entity_snapshot_history',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    entityKind: text('entity_kind').notNull(), // 'node' | 'element' | 'storyline' | 'category'
    entityId: text('entity_id').notNull(),
    stateBlob: blob('state_blob').notNull(),
    contentJson: text('content_json'),
    metaJson: text('meta_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_entity_snapshot_entity').on(t.entityKind, t.entityId, t.createdAt),
    index('idx_entity_snapshot_project').on(t.projectId),
  ],
);

export const yjsUpdates = sqliteTable(
  'yjs_updates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    docId: text('document_id').notNull(),
    updateBlob: blob('update_blob').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_yjs_updates_doc').on(t.docId)],
);

export const yjsSnapshots = sqliteTable(
  'yjs_snapshots',
  {
    docId: text('document_id').primaryKey(),
    stateBlob: blob('state_blob').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_yjs_snapshot_doc').on(t.docId)],
);

/**
 * Monotonic document generation used for optimistic Agent prose writes.
 *
 * `yjs_updates.id` is not a revision: compaction may delete every covered
 * update row. This counter is intentionally independent from the append log
 * and survives snapshots/compaction so a stale prepared command can never
 * become current again merely because old update rows were pruned.
 */
export const YjsDocumentRevisionTable = sqliteTable('yjs_document_revision', {
  docId: text('document_id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Durable author of every semantic Yjs revision.
 *
 * This is intentionally separate from the compactable update log. An Agent
 * must still be able to attribute a stale read after snapshots prune the
 * underlying update rows. Exact Agent identity is present for General Agent
 * commands; user, remote, system and legacy revisions remain explicit instead
 * of being guessed from the absence of an Agent receipt.
 */
export const YjsDocumentRevisionProvenanceTable = sqliteTable(
  'yjs_document_revision_provenance',
  {
    docId: text('document_id').notNull(),
    revision: integer('revision').notNull(),
    sourceKind: text('source_kind').notNull(),
    agentSessionId: text('agent_session_id'),
    agentTurnId: text('agent_turn_id'),
    agentCallId: text('agent_call_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.docId, t.revision] }),
    index('idx_yjs_revision_provenance_doc_revision').on(t.docId, t.revision),
  ],
);

/**
 * Durable idempotency/reconciliation receipt for provider-neutral prose
 * commands. The referenced update row may later be compacted, so updateId is a
 * watermark rather than a foreign key.
 */
export const YjsProseCommandReceiptTable = sqliteTable(
  'yjs_prose_command_receipt',
  {
    id: text('id').primaryKey(),
    commandId: text('command_id').notNull(),
    direction: text('direction').notNull(),
    docId: text('document_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    baseRevision: integer('base_revision').notNull(),
    committedRevision: integer('committed_revision').notNull(),
    baseStateVector: blob('base_state_vector').notNull(),
    baseStateHash: text('base_state_hash').notNull(),
    resultStateVector: blob('result_state_vector').notNull(),
    resultStateHash: text('result_state_hash').notNull(),
    updateHash: text('update_hash').notNull(),
    updateId: integer('update_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_yjs_prose_command_direction').on(t.commandId, t.direction),
    index('idx_yjs_prose_command_doc_revision').on(t.docId, t.committedRevision),
  ],
);

// Yjs sync cursor: tracks push/pull progress per document
export const yjsSyncCursor = sqliteTable('yjs_sync_cursor', {
  docId: text('doc_id').primaryKey(),
  lastServerSeq: integer('last_server_seq').notNull().default(0),
  lastPushedLocalId: integer('last_pushed_local_id').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

export const LocalSyncMutationTable = sqliteTable(
  'local_sync_mutation',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type').notNull(),
    mutationType: text('mutation_type').notNull(),
    entityId: text('entity_id').notNull(),
    projectId: text('project_id').notNull(),
    parentId: text('parent_id'),
    payloadJson: text('payload_json'),
    mutationTs: integer('mutation_ts').notNull(),
    status: text('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_local_sync_mutation_status_id').on(t.status, t.id),
    index('idx_local_sync_mutation_project').on(t.projectId),
    index('idx_local_sync_mutation_entity').on(t.entityType, t.entityId, t.mutationType),
  ],
);
