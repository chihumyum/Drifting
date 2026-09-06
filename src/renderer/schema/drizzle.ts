import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
  check,
  blob,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Agent chat uses a separate versioned object stream. These tables never enter
// project protocol v1 snapshots; runtime sessions and grants remain local.
export const AgentChatBranchTable = sqliteTable('agent_chat_branch', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
  rootId: text('root_id').notNull(),
  parentBranchId: text('parent_branch_id'),
  forkTurnId: text('fork_turn_id'),
  headTurnId: text('head_turn_id'),
  title: text('title').notNull(),
  titleClock: text('title_clock').notNull(),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  readiness: text('readiness').notNull().default('pending'),
}, (t) => [index('idx_agent_chat_branch_project').on(t.projectId)]);

export const AgentChatObjectTable = sqliteTable('agent_chat_object', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
  branchId: text('branch_id'),
  kind: text('kind').notNull(),
  bodyJson: text('body_json').notNull(),
  hash: text('hash').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [index('idx_agent_chat_object_project').on(t.projectId), index('idx_agent_chat_object_branch').on(t.branchId)]);

export const AgentChatBindingTable = sqliteTable('agent_chat_binding', {
  conversationId: text('conversation_id').primaryKey().references(() => AgentConversationTable.id, { onDelete: 'cascade' }),
  localOwner: integer('local_owner', { mode: 'boolean' }).notNull(),
  sessionId: text('session_id'),
  exportedOrdinal: integer('exported_ordinal').notNull().default(-1),
  seededThrough: text('seeded_through'),
});

export const AgentChatQueueTable = sqliteTable('agent_chat_queue', {
  conversationId: text('conversation_id').primaryKey().references(() => AgentConversationTable.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
});

export const AgentChatCursorTable = sqliteTable('agent_chat_cursor', {
  id: text('id').primaryKey(),
  cursor: text('cursor'),
  backfillComplete: integer('backfill_complete', { mode: 'boolean' }).notNull().default(false),
});

export const AgentChatDeliveryTable = sqliteTable('agent_chat_delivery', {
  scopeId: text('scope_id').notNull(),
  objectId: text('object_id').notNull(),
  remoteId: text('remote_id'),
  state: text('state').notNull(),
  detail: text('detail'),
}, (t) => [primaryKey({ columns: [t.scopeId, t.objectId] })]);
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

// Stable authored key/value facts shared by project, storyline and element
// owners. The legacy *_kv_json columns are query/UI projections only. Entry
// lifecycle/LWW clocks live in sync_entity_lifecycle/sync_field_clock and list
// order lives in sync_order_register.
export const EntityKvEntryTable = sqliteTable(
  'entity_kv_entry',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [
    index('idx_entity_kv_entry_project').on(t.projectId),
    index('idx_entity_kv_entry_owner').on(
      t.projectId,
      t.ownerKind,
      t.ownerId,
      t.namespace,
    ),
    check(
      'entity_kv_entry_owner_namespace_check',
      sql`(${t.ownerKind} = 'project' and ${t.namespace} in ('facts', 'storyline-template'))
        or (${t.ownerKind} = 'storyline' and ${t.namespace} = 'facts')
        or (${t.ownerKind} = 'element-category' and ${t.namespace} = 'element-template')
        or (${t.ownerKind} = 'element' and ${t.namespace} = 'facts')`,
    ),
    check(
      'entity_kv_entry_identity_check',
      sql`length(${t.ownerId}) > 0 and length(${t.id}) > 0`,
    ),
  ],
);


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
    // Storyline + element category each have one body editor. The content
    // name aligns with element.content_json and node_content.content_json;
    // project summary remains a separate text column.
  },
  (t) => [
    index('idx_element_category_project').on(t.projectId),
    index('idx_element_category_deleted_at').on(t.deletedAt),
  ],
);

// Project Asset
// Immutable metadata for an app-owned source. Owner bindings live on element
// and library_item; provider delivery state belongs to SyncEngine tables.
export const ProjectAssetTable = sqliteTable(
  'project_asset',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    sourceMime: text('source_mime').notNull(),
    sourceSizeBytes: integer('source_size_bytes').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_project_asset_project').on(t.projectId),
    index('idx_project_asset_project_sha256').on(t.projectId, t.sourceSha256),
    check('project_asset_kind_check', sql`${t.kind} in ('image', 'pdf')`),
    check('project_asset_source_size_check', sql`${t.sourceSizeBytes} > 0`),
    check(
      'project_asset_sha256_check',
      sql`length(${t.sourceSha256}) = 64 and ${t.sourceSha256} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'project_asset_shape_check',
      sql`(
        ${t.kind} = 'image'
        and ${t.sourceMime} like 'image/%'
        and ${t.width} > 0
        and ${t.height} > 0
      ) or (
        ${t.kind} = 'pdf'
        and ${t.sourceMime} = 'application/pdf'
        and ${t.width} is null
        and ${t.height} is null
      )`,
    ),
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
    // Continuous authored coordinate for book/reading order. SQLite INTEGER
    // affinity accepts and preserves REAL values; keeping the original schema
    // declaration avoids rewriting the immutable pre-release baseline.
    // Nullable: drift nodes have no place on this axis. Chapters always carry
    // a value, including the "未归属" state.
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
    wordCountBasisKind: text('word_count_basis_kind'),
    wordCountBasisHash: text('word_count_basis_hash'),
    wordCountBasisRevision: integer('word_count_basis_revision'),
    wordCountBasisServerSeq: integer('word_count_basis_server_seq'),
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
    // `deletedAt IS NULL`. Local libraries always use this recoverable path;
    // explicitly hosted builds may apply their own entitlement policy.
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
    // Deterministic sparse UI/query projection of normalized plot_grid_* rows.
    // It is not sync authority and remains independent from prose/Yjs.
    plotGridJson: text('plot_grid_json').default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_node_content_node').on(t.nodeId)],
);

// Normalized authority for the in-chapter Plot Grid. The one JSON value on
// node_content is a deterministic UI/query projection only. Document size is
// one atomic tuple; rows, columns, and cells keep independent stable identity.
export const PlotGridDocumentTable = sqliteTable(
  'plot_grid_document',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    cellWidth: real('cell_width').notNull().default(184),
    cellHeight: real('cell_height').notNull().default(96),
  },
  (t) => [
    uniqueIndex('uniq_plot_grid_document_node').on(t.nodeId),
    check(
      'plot_grid_document_size_check',
      sql`${t.cellWidth} between 120 and 440 and ${t.cellHeight} between 56 and 380`,
    ),
  ],
);

export const PlotGridRowTable = sqliteTable(
  'plot_grid_row',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => PlotGridDocumentTable.id, { onDelete: 'cascade' }),
    positionKey: text('position_key').notNull(),
    label: text('label').notNull().default(''),
  },
  (t) => [
    uniqueIndex('uniq_plot_grid_row_document_identity').on(t.id, t.documentId),
    index('idx_plot_grid_row_order').on(t.documentId, t.positionKey, t.id),
    check('plot_grid_row_position_key_check', sql`length(${t.positionKey}) > 0`),
  ],
);

export const PlotGridColumnTable = sqliteTable(
  'plot_grid_column',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => PlotGridDocumentTable.id, { onDelete: 'cascade' }),
    positionKey: text('position_key').notNull(),
    label: text('label').notNull().default(''),
  },
  (t) => [
    uniqueIndex('uniq_plot_grid_column_document_identity').on(t.id, t.documentId),
    index('idx_plot_grid_column_order').on(t.documentId, t.positionKey, t.id),
    check('plot_grid_column_position_key_check', sql`length(${t.positionKey}) > 0`),
  ],
);

export const PlotGridCellTable = sqliteTable(
  'plot_grid_cell',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => PlotGridDocumentTable.id, { onDelete: 'cascade' }),
    rowId: text('row_id').notNull(),
    columnId: text('column_id').notNull(),
    value: text('value').notNull().default(''),
  },
  (t) => [
    uniqueIndex('uniq_plot_grid_cell_coordinate').on(
      t.documentId,
      t.rowId,
      t.columnId,
    ),
    index('idx_plot_grid_cell_row').on(t.documentId, t.rowId),
    index('idx_plot_grid_cell_column').on(t.documentId, t.columnId),
    foreignKey({
      columns: [t.rowId, t.documentId],
      foreignColumns: [PlotGridRowTable.id, PlotGridRowTable.documentId],
      name: 'fk_plot_grid_cell_row_document',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.columnId, t.documentId],
      foreignColumns: [PlotGridColumnTable.id, PlotGridColumnTable.documentId],
      name: 'fk_plot_grid_cell_column_document',
    }).onDelete('cascade'),
  ],
);

// Story-graph edges live in `entity_relation` now — rows with fromKind/toKind
// = 'node' and one authoritative project relation type id. Visual columns
// (anchors/control points/style) are intentionally not part of this model.

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
    // When a category is soft-deleted or hard-deleted, its elements detach to
    // NULL ("未分类") instead of cascading. Restoring the category does NOT
    // re-link them.
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
    // aliases is enforced in the app layer (useBookElement), not by SQL.
    aliasesJson: text('aliases_json').notNull().default('[]'),
    groupName: text('group_name'),
    portraitAssetId: text('portrait_asset_id').references(() => ProjectAssetTable.id, {
      onDelete: 'no action',
    }),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_element_deleted_at').on(t.deletedAt),
    index('idx_element_category').on(t.categoryId),
    uniqueIndex('uniq_element_portrait_asset').on(t.portraitAssetId),
  ],
);

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
    // valid for the unchanged blocks. Per-block hashes ensure mid-chapter
    // edits do not invalidate the whole section.
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

// Entity Relation Type
// Project-owned semantic vocabulary for authored relations. This row owns the
// relation name, directionality, endpoint roles, and lifecycle. Allowed endpoint kinds live in an explicit child table
// so they remain queryable and transactionally validated rather than being
// hidden inside metadata JSON.
export const EntityRelationTypeTable = sqliteTable(
  'entity_relation_type',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description').notNull().default(''),
    orientation: text('orientation').notNull(), // directed | symmetric
    systemKey: text('system_key'), // generic-association | null for authored types
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    sourceRole: text('source_role').notNull().default(''),
    targetRole: text('target_role').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_relation_type_project_name').on(t.projectId, t.normalizedName),
    uniqueIndex('uniq_relation_type_project_system_key').on(t.projectId, t.systemKey),
    uniqueIndex('uniq_relation_type_project_identity').on(t.id, t.projectId),
    index('idx_relation_type_project').on(t.projectId),
    check('relation_type_orientation', sql`${t.orientation} in ('directed', 'symmetric')`),
    check(
      'relation_type_system_key',
      sql`${t.systemKey} is null or ${t.systemKey} = 'generic-association'`,
    ),
    check(
      'relation_type_system_lock',
      sql`(${t.systemKey} is null and ${t.locked} = 0) or (${t.systemKey} is not null and ${t.locked} = 1)`,
    ),
  ],
);

export const EntityRelationTypeEndpointKindTable = sqliteTable(
  'entity_relation_type_endpoint_kind',
  {
    relationTypeId: text('relation_type_id')
      .notNull()
      .references(() => EntityRelationTypeTable.id, { onDelete: 'cascade' }),
    side: text('side').notNull(), // source | target
    entityKind: text('entity_kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.relationTypeId, t.side, t.entityKind] }),
    check('relation_type_endpoint_side', sql`${t.side} in ('source', 'target')`),
    check(
      'relation_type_endpoint_kind',
      sql`(${t.side} = 'source' and ${t.entityKind} in ('node', 'element', 'patch', 'category', 'storyline', 'comment', 'library_item')) or (${t.side} = 'target' and ${t.entityKind} in ('node', 'element', 'patch', 'category', 'storyline'))`,
    ),
  ],
);

// Entity Relation
// User-curated semantic link between two entities. Source of truth for cross-
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

    // The only semantic owner. Display names and presentation metadata are
    // resolved from this id rather than copied onto every relation row.
    relationTypeId: text('relation_type_id').notNull(),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_relation_from').on(t.fromKind, t.fromId),
    index('idx_relation_to').on(t.toKind, t.toId),
    index('idx_relation_project').on(t.projectId),
    index('idx_relation_type').on(t.relationTypeId),
    uniqueIndex('uniq_entity_relation_semantic_edge').on(
      t.projectId,
      t.fromKind,
      t.fromId,
      t.toKind,
      t.toId,
      t.relationTypeId,
    ),
    foreignKey({
      columns: [t.relationTypeId, t.projectId],
      foreignColumns: [EntityRelationTypeTable.id, EntityRelationTypeTable.projectId],
      name: 'fk_entity_relation_type_project',
    }).onDelete('cascade'),
    check(
      'entity_relation_endpoint_kinds',
      sql`${t.fromKind} in ('node', 'element', 'patch', 'category', 'storyline', 'comment', 'library_item') and ${t.toKind} in ('node', 'element', 'patch', 'category', 'storyline')`,
    ),
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
// floating TODOs, AI suggestions}.
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
// `kind` is the only payload discriminator: image/pdf bind an app-owned asset,
// url binds an external URL, and text binds a TipTap document. Picker paths and
// binary metadata never enter this table.
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
    kind: text('kind').notNull(), // 'image' | 'pdf' | 'url' | 'text'
    assetId: text('asset_id').references(() => ProjectAssetTable.id, {
      onDelete: 'no action',
    }),
    externalUrl: text('external_url'),
    bodyJson: text('body_json'),
    notesJson: text('notes_json'),
    previewImageUrl: text('preview_image_url'),
    orderKey: integer('order_key').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_library_item_project').on(t.projectId),
    index('idx_library_item_project_kind').on(t.projectId, t.kind),
    uniqueIndex('uniq_library_item_asset').on(t.assetId),
    check('library_item_kind_check', sql`${t.kind} in ('image', 'pdf', 'url', 'text')`),
    check(
      'library_item_payload_check',
      sql`(
        ${t.kind} in ('image', 'pdf')
        and ${t.assetId} is not null
        and ${t.externalUrl} is null
        and ${t.bodyJson} is null
        and ${t.previewImageUrl} is null
      ) or (
        ${t.kind} = 'url'
        and ${t.assetId} is null
        and ${t.externalUrl} is not null
        and length(trim(${t.externalUrl})) > 0
        and ${t.bodyJson} is null
      ) or (
        ${t.kind} = 'text'
        and ${t.assetId} is null
        and ${t.externalUrl} is null
        and ${t.previewImageUrl} is null
      )`,
    ),
    check(
      'library_item_body_json_check',
      sql`${t.bodyJson} is null or (json_valid(${t.bodyJson}) and json_extract(${t.bodyJson}, '$.type') = 'doc')`,
    ),
    check(
      'library_item_notes_json_check',
      sql`${t.notesJson} is null or (json_valid(${t.notesJson}) and json_extract(${t.notesJson}, '$.type') = 'doc')`,
    ),
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
    check(
      'agent_runtime_session_route_shape_check',
      sql`(${t.routeKind} = 'chat'
          and ${t.conversationId} is not null
          and ${t.goalRunId} is null
          and ${t.chapterId} is null)
        or (${t.routeKind} = 'goal' and ${t.conversationId} is null)`,
    ),
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
    // The SQL baseline owns the self-FK. Keeping this as a plain column avoids
    // Drizzle's recursive table type widening.
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
// proposals, and standing directives.
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

// General Agent Working Memory
// One rolling, user-readable Markdown document per project. It is recent
// cross-conversation work context, not long-lived author guidance and not an
// authored-story source of truth. Revision is a local CAS boundary; token
// counts make automatic rolling compaction deterministic and inspectable.
export const AgentWorkingMemoryTable = sqliteTable(
  'agent_working_memory',
  {
    projectId: text('project_id')
      .primaryKey()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    contentMd: text('content_md').notNull().default(''),
    revision: integer('revision').notNull().default(0),
    approxTokens: integer('approx_tokens').notNull().default(0),
    updatedBy: text('updated_by').notNull().default('agent'),
    lastCompactedAt: text('last_compacted_at'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('agent_working_memory_revision_nonnegative', sql`${t.revision} >= 0`),
    check('agent_working_memory_tokens_nonnegative', sql`${t.approxTokens} >= 0`),
    check('agent_working_memory_updated_by', sql`${t.updatedBy} in ('author', 'agent')`),
  ],
);

// Act (幕) — boundary-based segment of the GLOBAL reading axis (bookOrder).
// Stores only where the act STARTS (`start_order`, REAL for fractional
// midpoint boundaries); membership derives as bookOrder >= startOrder and
// < the next act's startOrder. A nullable start_order is an optional book-head
// anchor, not a required first act: when every boundary is finite, chapters
// before the first boundary belong to no act. Empty acts are legal. See
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
    startOrder: real('start_order'), // null = optional book-head anchor
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
    uniqueIndex('uniq_agent_permission_grant_active')
      .on(
        t.projectId,
        sql`ifnull(${t.sessionId}, '')`,
        t.scope,
        t.sourceKind,
        t.sourceId,
        t.providerToolName,
        t.remoteToolName,
        t.access,
        t.argumentsHash,
        t.toolDefinitionRevision,
        t.sourceConfigRevision,
      )
      .where(sql`${t.status} = 'active'`),
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

// SyncEngine is an immutable, provider-neutral object log. Domain rows and
// Yjs remain the working copy; these tables contain only protocol, reducer,
// transport, and recovery state. Secrets are represented by opaque native
// secure-storage references, never bearer values or upload-session URLs.

export const SyncAppAuthorityTable = sqliteTable(
  'sync_app_authority',
  {
    id: text('id').primaryKey().notNull().default('app'),
    mode: text('mode').notNull().default('local'),
    generation: integer('generation').notNull().default(1),
    transitionState: text('transition_state').notNull().default('stable'),
    targetMode: text('target_mode'),
    attemptId: text('attempt_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_sync_app_authority_identity').on(t.id, t.mode, t.generation),
    check('sync_app_authority_singleton_check', sql`${t.id} = 'app'`),
    check(
      'sync_app_authority_mode_check',
      sql`${t.mode} in ('local', 'google-drive', 'hosted')`,
    ),
    check('sync_app_authority_generation_check', sql`${t.generation} >= 1`),
    check(
      'sync_app_authority_transition_check',
      sql`(
        ${t.transitionState} = 'stable'
        and ${t.targetMode} is null
        and ${t.attemptId} is null
      ) or (
        ${t.transitionState} = 'connecting'
        and ${t.mode} = 'local'
        and ${t.targetMode} in ('google-drive', 'hosted')
        and ${t.attemptId} is not null
      ) or (
        ${t.transitionState} = 'switching'
        and ${t.mode} in ('google-drive', 'hosted')
        and ${t.targetMode} in ('google-drive', 'hosted')
        and ${t.targetMode} <> ${t.mode}
        and ${t.attemptId} is not null
      ) or (
        ${t.transitionState} = 'disconnecting'
        and ${t.mode} in ('google-drive', 'hosted')
        and ${t.targetMode} = 'local'
        and ${t.attemptId} is not null
      ) or (
        ${t.transitionState} = 'blocked'
        and ${t.targetMode} in ('local', 'google-drive', 'hosted')
        and ${t.targetMode} <> ${t.mode}
        and ${t.attemptId} is not null
      )`,
    ),
  ],
);

export const SyncProviderAccountTable = sqliteTable(
  'sync_provider_account',
  {
    id: text('id').primaryKey(),
    singletonKey: integer('singleton_key').notNull().default(1),
    authorityId: text('authority_id').notNull().default('app'),
    providerKind: text('provider_kind').notNull(),
    authorityGeneration: integer('authority_generation').notNull(),
    accountSubjectId: text('account_subject_id').notNull(),
    credentialSecretRef: text('credential_secret_ref').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_sync_provider_account_singleton').on(t.singletonKey),
    uniqueIndex('uniq_sync_provider_account_subject').on(
      t.providerKind,
      t.accountSubjectId,
    ),
    check('sync_provider_account_singleton_check', sql`${t.singletonKey} = 1`),
    check(
      'sync_provider_account_kind_check',
      sql`${t.providerKind} in ('google-drive', 'hosted')`,
    ),
    check(
      'sync_provider_account_generation_check',
      sql`${t.authorityGeneration} >= 1`,
    ),
    foreignKey({
      columns: [t.authorityId, t.providerKind, t.authorityGeneration],
      foreignColumns: [
        SyncAppAuthorityTable.id,
        SyncAppAuthorityTable.mode,
        SyncAppAuthorityTable.generation,
      ],
      name: 'fk_sync_provider_account_authority_generation',
    }).onDelete('restrict'),
  ],
);

export const SyncGenerationTable = sqliteTable(
  'sync_generation',
  {
    syncGenerationId: text('sync_generation_id').primaryKey(),
    projectId: text('project_id').references(() => ProjectTable.id, {
      onDelete: 'set null',
    }),
    projectSyncId: text('project_sync_id').notNull(),
    generationNumber: integer('generation_number').notNull().default(1),
    protocolVersion: integer('protocol_version').notNull().default(1),
    domainSchemaVersion: integer('domain_schema_version').notNull().default(1),
    status: text('status').notNull().default('active'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    retiredAt: text('retired_at'),
    purgedAt: text('purged_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_generation_project_sync_number').on(
      t.projectSyncId,
      t.generationNumber,
    ),
    uniqueIndex('uniq_sync_generation_identity_project_sync').on(
      t.syncGenerationId,
      t.projectSyncId,
    ),
    uniqueIndex('uniq_sync_generation_active_project')
      .on(t.projectId)
      .where(sql`${t.projectId} is not null and ${t.status} = 'active'`),
    uniqueIndex('uniq_sync_generation_staged_project')
      .on(t.projectId)
      .where(sql`${t.projectId} is not null and ${t.status} = 'staged'`),
    index('idx_sync_generation_project').on(t.projectId),
    index('idx_sync_generation_project_sync').on(t.projectSyncId),
    check('sync_generation_number_check', sql`${t.generationNumber} >= 1`),
    check('sync_generation_protocol_check', sql`${t.protocolVersion} = 1`),
    check('sync_generation_schema_check', sql`${t.domainSchemaVersion} >= 1`),
    check(
      'sync_generation_status_check',
      sql`(${t.status} in ('active', 'staged')
          and ${t.retiredAt} is null
          and ${t.purgedAt} is null)
        or (${t.status} = 'retired'
          and ${t.retiredAt} is not null
          and ${t.purgedAt} is null)
        or (${t.status} = 'purged' and ${t.purgedAt} is not null)`,
    ),
  ],
);

export const SyncProviderBindingTable = sqliteTable(
  'sync_provider_binding',
  {
    syncGenerationId: text('sync_generation_id')
      .primaryKey()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    providerAccountId: text('provider_account_id')
      .notNull()
      .references(() => SyncProviderAccountTable.id, { onDelete: 'restrict' }),
    providerNamespace: text('provider_namespace').notNull(),
    providerGenerationRef: text('provider_generation_ref'),
    state: text('state').notNull().default('connecting'),
    connectedAt: text('connected_at'),
    lastPullSuccessAt: text('last_pull_success_at'),
    lastPublishSuccessAt: text('last_publish_success_at'),
    lastConvergedAt: text('last_converged_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_sync_provider_binding_account').on(t.providerAccountId),
    index('idx_sync_provider_binding_state').on(t.state),
    check(
      'sync_provider_binding_state_check',
      sql`${t.state} in (
        'connecting', 'discovering', 'publishing-genesis', 'restoring',
        'ready', 'paused', 'needs-reauth', 'blocked-update',
        'blocked-corrupt', 'purged'
      )`,
    ),
  ],
);

export const SyncGenerationWriterStateTable = sqliteTable(
  'sync_generation_writer_state',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    installationId: text('installation_id').notNull(),
    nextDeviceSeq: integer('next_device_seq').notNull().default(1),
    hlcWallMs: integer('hlc_wall_ms').notNull().default(0),
    hlcCounter: integer('hlc_counter').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    retiredAt: text('retired_at'),
  },
  (t) => [
    primaryKey({ columns: [t.syncGenerationId, t.writerId, t.writerEpoch] }),
    uniqueIndex('uniq_sync_generation_active_writer')
      .on(t.syncGenerationId)
      .where(sql`${t.retiredAt} is null`),
    check('sync_writer_next_sequence_check', sql`${t.nextDeviceSeq} >= 1`),
    check(
      'sync_writer_hlc_check',
      sql`${t.hlcWallMs} >= 0 and ${t.hlcCounter} >= 0`,
    ),
  ],
);

export const SyncChangeSetTable = sqliteTable(
  'sync_change_set',
  {
    changeSetId: text('change_set_id').primaryKey(),
    syncGenerationId: text('sync_generation_id').notNull(),
    projectId: text('project_id').notNull(),
    projectSyncId: text('project_sync_id').notNull(),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    deviceSeq: integer('device_seq').notNull(),
    hlcWallMs: integer('hlc_wall_ms').notNull(),
    hlcCounter: integer('hlc_counter').notNull(),
    protocolVersion: integer('protocol_version').notNull().default(1),
    payloadVersion: integer('payload_version').notNull().default(1),
    mutationCount: integer('mutation_count').notNull(),
    encodedBytes: blob('encoded_bytes').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    origin: text('origin').notNull(),
    applyState: text('apply_state').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    appliedAt: text('applied_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_change_set_writer_sequence').on(
      t.syncGenerationId,
      t.writerId,
      t.writerEpoch,
      t.deviceSeq,
    ),
    uniqueIndex('uniq_sync_change_set_identity_generation').on(
      t.changeSetId,
      t.syncGenerationId,
    ),
    index('idx_sync_change_set_apply_state').on(
      t.syncGenerationId,
      t.applyState,
      t.createdAt,
    ),
    foreignKey({
      columns: [t.syncGenerationId, t.projectSyncId],
      foreignColumns: [
        SyncGenerationTable.syncGenerationId,
        SyncGenerationTable.projectSyncId,
      ],
      name: 'fk_sync_change_set_generation_project_sync',
    }).onDelete('restrict'),
    check(
      'sync_change_set_sequence_check',
      sql`${t.deviceSeq} >= 1 and ${t.hlcWallMs} >= 0 and ${t.hlcCounter} >= 0`,
    ),
    check(
      'sync_change_set_version_check',
      sql`${t.protocolVersion} = 1 and ${t.payloadVersion} = 1`,
    ),
    check('sync_change_set_mutation_count_check', sql`${t.mutationCount} > 0`),
    check(
      'sync_change_set_hash_check',
      sql`length(${t.payloadSha256}) = 64 and ${t.payloadSha256} not glob '*[^0-9a-f]*'`,
    ),
    check('sync_change_set_origin_check', sql`${t.origin} in ('local', 'remote')`),
    check(
      'sync_change_set_apply_state_check',
      sql`${t.applyState} in ('pending', 'applying', 'applied', 'quarantined')`,
    ),
  ],
);

export const SyncMutationTable = sqliteTable(
  'sync_mutation',
  {
    changeSetId: text('change_set_id')
      .notNull()
      .references(() => SyncChangeSetTable.changeSetId, { onDelete: 'restrict' }),
    mutationIndex: integer('mutation_index').notNull(),
    targetFamily: text('target_family').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    incarnation: integer('incarnation').notNull(),
    action: text('action').notNull(),
    payloadVersion: integer('payload_version').notNull().default(1),
    payloadCbor: blob('payload_cbor').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.changeSetId, t.mutationIndex] }),
    index('idx_sync_mutation_target').on(
      t.targetFamily,
      t.targetKind,
      t.targetId,
      t.incarnation,
    ),
    check('sync_mutation_index_check', sql`${t.mutationIndex} >= 0`),
    check('sync_mutation_incarnation_check', sql`${t.incarnation} >= 0`),
    check('sync_mutation_payload_version_check', sql`${t.payloadVersion} = 1`),
    check(
      'sync_mutation_family_check',
      sql`${t.targetFamily} in ('entity', 'set', 'order', 'yjs', 'asset', 'sync-generation')`,
    ),
    check(
      'sync_mutation_action_check',
      sql`${t.action} in (
        'entity.create', 'field.set', 'tuple.set', 'set.add', 'set.remove',
        'order.move', 'order.rebalance', 'entity.trash', 'entity.restore',
        'entity.purge', 'sync-generation.purge', 'yjs.update', 'asset.bind', 'asset.unbind'
      )`,
    ),
    check(
      'sync_mutation_hash_check',
      sql`length(${t.payloadSha256}) = 64 and ${t.payloadSha256} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const SyncApplyReceiptTable = sqliteTable(
  'sync_apply_receipt',
  {
    changeSetId: text('change_set_id').primaryKey(),
    syncGenerationId: text('sync_generation_id').notNull(),
    mutationCount: integer('mutation_count').notNull(),
    sourceObjectId: text('source_object_id'),
    stateSha256: text('state_sha256'),
    appliedAt: text('applied_at').notNull(),
  },
  (t) => [
    index('idx_sync_apply_receipt_generation').on(t.syncGenerationId, t.appliedAt),
    foreignKey({
      columns: [t.changeSetId, t.syncGenerationId],
      foreignColumns: [
        SyncChangeSetTable.changeSetId,
        SyncChangeSetTable.syncGenerationId,
      ],
      name: 'fk_sync_apply_receipt_change_set',
    }).onDelete('restrict'),
    check('sync_apply_receipt_mutation_count_check', sql`${t.mutationCount} > 0`),
    check(
      'sync_apply_receipt_state_hash_check',
      sql`${t.stateSha256} is null or (
        length(${t.stateSha256}) = 64 and ${t.stateSha256} not glob '*[^0-9a-f]*'
      )`,
    ),
  ],
);

/**
 * Presence of this row is the permanent absorbing state for one sync
 * generation. The immutable journal remains available for receipts/frontier,
 * but no later non-purge mutation may materialize domain state.
 */
export const SyncGenerationPurgeTable = sqliteTable(
  'sync_generation_purge',
  {
    syncGenerationId: text('sync_generation_id')
      .primaryKey()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    hlcWallMs: integer('hlc_wall_ms').notNull(),
    hlcCounter: integer('hlc_counter').notNull(),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    deviceSeq: integer('device_seq').notNull(),
    changeSetId: text('change_set_id').notNull(),
    mutationIndex: integer('mutation_index').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.changeSetId, t.mutationIndex],
      foreignColumns: [SyncMutationTable.changeSetId, SyncMutationTable.mutationIndex],
      name: 'fk_sync_generation_purge_mutation',
    }).onDelete('restrict'),
    check(
      'sync_generation_purge_clock_check',
      sql`${t.hlcWallMs} >= 0 and ${t.hlcCounter} >= 0
        and ${t.deviceSeq} >= 1 and ${t.mutationIndex} >= 0`,
    ),
  ],
);

export const SyncFieldClockTable = sqliteTable(
  'sync_field_clock',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    incarnation: integer('incarnation').notNull(),
    fieldKey: text('field_key').notNull(),
    hlcWallMs: integer('hlc_wall_ms').notNull(),
    hlcCounter: integer('hlc_counter').notNull(),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    deviceSeq: integer('device_seq').notNull(),
    changeSetId: text('change_set_id').notNull(),
    mutationIndex: integer('mutation_index').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.syncGenerationId, t.targetKind, t.targetId, t.incarnation, t.fieldKey],
    }),
    foreignKey({
      columns: [t.changeSetId, t.mutationIndex],
      foreignColumns: [SyncMutationTable.changeSetId, SyncMutationTable.mutationIndex],
      name: 'fk_sync_field_clock_mutation',
    }).onDelete('restrict'),
    check(
      'sync_field_clock_value_check',
      sql`${t.incarnation} >= 0 and ${t.hlcWallMs} >= 0 and ${t.hlcCounter} >= 0
        and ${t.deviceSeq} >= 1 and ${t.mutationIndex} >= 0`,
    ),
  ],
);

export const SyncSetTagTable = sqliteTable(
  'sync_set_tag',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    incarnation: integer('incarnation').notNull(),
    setKey: text('set_key').notNull(),
    valueKey: text('value_key').notNull(),
    valueCbor: blob('value_cbor').notNull(),
    addTag: text('add_tag').notNull(),
    addChangeSetId: text('add_change_set_id').notNull(),
    addMutationIndex: integer('add_mutation_index').notNull(),
    removedByChangeSetId: text('removed_by_change_set_id'),
    removedByMutationIndex: integer('removed_by_mutation_index'),
  },
  (t) => [
    primaryKey({
      columns: [
        t.syncGenerationId,
        t.ownerKind,
        t.ownerId,
        t.incarnation,
        t.setKey,
        t.valueKey,
        t.addTag,
      ],
    }),
    index('idx_sync_set_tag_live_value').on(
      t.syncGenerationId,
      t.ownerKind,
      t.ownerId,
      t.setKey,
      t.valueKey,
      t.removedByChangeSetId,
    ),
    foreignKey({
      columns: [t.addChangeSetId, t.addMutationIndex],
      foreignColumns: [SyncMutationTable.changeSetId, SyncMutationTable.mutationIndex],
      name: 'fk_sync_set_tag_add_mutation',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.removedByChangeSetId, t.removedByMutationIndex],
      foreignColumns: [SyncMutationTable.changeSetId, SyncMutationTable.mutationIndex],
      name: 'fk_sync_set_tag_remove_mutation',
    }).onDelete('restrict'),
    check('sync_set_tag_incarnation_check', sql`${t.incarnation} >= 0`),
    check(
      'sync_set_tag_remove_pair_check',
      sql`(${t.removedByChangeSetId} is null and ${t.removedByMutationIndex} is null)
        or (${t.removedByChangeSetId} is not null and ${t.removedByMutationIndex} >= 0)`,
    ),
  ],
);

export const SyncOrderRegisterTable = sqliteTable(
  'sync_order_register',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    listKind: text('list_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    entityId: text('entity_id').notNull(),
    incarnation: integer('incarnation').notNull(),
    positionKey: text('position_key').notNull(),
    hlcWallMs: integer('hlc_wall_ms').notNull(),
    hlcCounter: integer('hlc_counter').notNull(),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    deviceSeq: integer('device_seq').notNull(),
    changeSetId: text('change_set_id').notNull(),
    mutationIndex: integer('mutation_index').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.syncGenerationId, t.listKind, t.entityId, t.incarnation],
    }),
    index('idx_sync_order_register_position').on(
      t.syncGenerationId,
      t.listKind,
      t.ownerId,
      t.positionKey,
      t.entityId,
    ),
    foreignKey({
      columns: [t.changeSetId, t.mutationIndex],
      foreignColumns: [SyncMutationTable.changeSetId, SyncMutationTable.mutationIndex],
      name: 'fk_sync_order_register_mutation',
    }).onDelete('restrict'),
    check(
      'sync_order_register_clock_check',
      sql`${t.incarnation} >= 0 and ${t.hlcWallMs} >= 0 and ${t.hlcCounter} >= 0
        and ${t.deviceSeq} >= 1 and ${t.mutationIndex} >= 0`,
    ),
  ],
);

export const SyncEntityLifecycleTable = sqliteTable(
  'sync_entity_lifecycle',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    incarnation: integer('incarnation').notNull(),
    state: text('state').notNull(),
    hlcWallMs: integer('hlc_wall_ms').notNull(),
    hlcCounter: integer('hlc_counter').notNull(),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    deviceSeq: integer('device_seq').notNull(),
    changeSetId: text('change_set_id').notNull(),
    mutationIndex: integer('mutation_index').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.syncGenerationId, t.entityKind, t.entityId] }),
    index('idx_sync_entity_lifecycle_state').on(t.syncGenerationId, t.state),
    foreignKey({
      columns: [t.changeSetId, t.mutationIndex],
      foreignColumns: [SyncMutationTable.changeSetId, SyncMutationTable.mutationIndex],
      name: 'fk_sync_entity_lifecycle_mutation',
    }).onDelete('restrict'),
    check('sync_entity_lifecycle_state_check', sql`${t.state} in ('live', 'trashed', 'purged')`),
    check(
      'sync_entity_lifecycle_clock_check',
      sql`${t.incarnation} >= 0 and ${t.hlcWallMs} >= 0 and ${t.hlcCounter} >= 0
        and ${t.deviceSeq} >= 1 and ${t.mutationIndex} >= 0`,
    ),
  ],
);

export const SyncFrontierTable = sqliteTable(
  'sync_frontier',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    receivedSeq: integer('received_seq').notNull().default(0),
    appliedSeq: integer('applied_seq').notNull().default(0),
    publishedSeq: integer('published_seq').notNull().default(0),
    segmentHeadSha256: text('segment_head_sha256'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.syncGenerationId, t.writerId, t.writerEpoch] }),
    check(
      'sync_frontier_sequence_check',
      sql`${t.receivedSeq} >= 0 and ${t.appliedSeq} >= 0 and ${t.publishedSeq} >= 0`,
    ),
    check(
      'sync_frontier_head_hash_check',
      sql`${t.segmentHeadSha256} is null or (
        length(${t.segmentHeadSha256}) = 64
        and ${t.segmentHeadSha256} not glob '*[^0-9a-f]*'
      )`,
    ),
  ],
);

export const SyncFrontierGapTable = sqliteTable(
  'sync_frontier_gap',
  {
    id: text('id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    lane: text('lane').notNull(),
    firstSeq: integer('first_seq').notNull(),
    lastSeq: integer('last_seq').notNull(),
    state: text('state').notNull().default('open'),
    observedAt: text('observed_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_frontier_gap_range').on(
      t.syncGenerationId,
      t.writerId,
      t.writerEpoch,
      t.lane,
      t.firstSeq,
      t.lastSeq,
    ),
    index('idx_sync_frontier_gap_open').on(t.syncGenerationId, t.state),
    check('sync_frontier_gap_lane_check', sql`${t.lane} in ('received', 'applied', 'published')`),
    check(
      'sync_frontier_gap_range_check',
      sql`${t.firstSeq} >= 1 and ${t.lastSeq} >= ${t.firstSeq}`,
    ),
    check(
      'sync_frontier_gap_state_check',
      sql`(${t.state} = 'open' and ${t.resolvedAt} is null)
        or (${t.state} = 'resolved' and ${t.resolvedAt} is not null)`,
    ),
  ],
);

export const SyncLocalObjectTable = sqliteTable(
  'sync_local_object',
  {
    id: text('id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    objectKind: text('object_kind').notNull(),
    logicalKeyId: text('logical_key_id').notNull(),
    storageRef: text('storage_ref').notNull(),
    storedSha256: text('stored_sha256').notNull(),
    contentSha256: text('content_sha256'),
    sizeBytes: integer('size_bytes').notNull(),
    codec: text('codec').notNull(),
    state: text('state').notNull().default('staged'),
    createdAt: text('created_at').notNull(),
    verifiedAt: text('verified_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_local_object_logical_key').on(t.syncGenerationId, t.logicalKeyId),
    index('idx_sync_local_object_state').on(t.syncGenerationId, t.state),
    check(
      'sync_local_object_kind_check',
      sql`${t.objectKind} in (
        'segment', 'genesis', 'checkpoint', 'snapshot-commit', 'blob',
        'quarantine'
      )`,
    ),
    check(
      'sync_local_object_hash_check',
      sql`length(${t.storedSha256}) = 64
        and ${t.storedSha256} not glob '*[^0-9a-f]*'
        and (${t.contentSha256} is null or (
          length(${t.contentSha256}) = 64
          and ${t.contentSha256} not glob '*[^0-9a-f]*'
        ))`,
    ),
    check('sync_local_object_size_check', sql`${t.sizeBytes} >= 0`),
    check(
      'sync_local_object_state_check',
      sql`${t.state} in ('staged', 'verified', 'publishing', 'published', 'quarantined')`,
    ),
  ],
);

export const SyncSegmentTable = sqliteTable(
  'sync_segment',
  {
    segmentId: text('segment_id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    writerId: text('writer_id').notNull(),
    writerEpoch: text('writer_epoch').notNull(),
    firstSeq: integer('first_seq').notNull(),
    lastSeq: integer('last_seq').notNull(),
    changeSetCount: integer('change_set_count').notNull(),
    previousSegmentSha256: text('previous_segment_sha256'),
    requiredBlobIdsCbor: blob('required_blob_ids_cbor').notNull(),
    localObjectId: text('local_object_id')
      .notNull()
      .references(() => SyncLocalObjectTable.id, { onDelete: 'restrict' }),
    segmentSha256: text('segment_sha256').notNull(),
    state: text('state').notNull().default('sealed'),
    createdAt: text('created_at').notNull(),
    publishedAt: text('published_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_segment_writer_range').on(
      t.syncGenerationId,
      t.writerId,
      t.writerEpoch,
      t.firstSeq,
      t.lastSeq,
    ),
    index('idx_sync_segment_state').on(t.syncGenerationId, t.state, t.firstSeq),
    check(
      'sync_segment_range_check',
      sql`${t.firstSeq} >= 1 and ${t.lastSeq} >= ${t.firstSeq}
        and ${t.changeSetCount} = ${t.lastSeq} - ${t.firstSeq} + 1`,
    ),
    check(
      'sync_segment_hash_check',
      sql`length(${t.segmentSha256}) = 64
        and ${t.segmentSha256} not glob '*[^0-9a-f]*'
        and (${t.previousSegmentSha256} is null or (
          length(${t.previousSegmentSha256}) = 64
          and ${t.previousSegmentSha256} not glob '*[^0-9a-f]*'
        ))`,
    ),
    check(
      'sync_segment_state_check',
      sql`${t.state} in ('sealed', 'publishing', 'published', 'quarantined')`,
    ),
  ],
);

export const SyncRemoteObjectTable = sqliteTable(
  'sync_remote_object',
  {
    id: text('id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    providerObjectId: text('provider_object_id').notNull(),
    logicalKeyId: text('logical_key_id').notNull(),
    objectKind: text('object_kind').notNull(),
    storedSha256: text('stored_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    providerVersion: text('provider_version'),
    providerEtag: text('provider_etag'),
    observedCursor: text('observed_cursor'),
    firstObservedAt: text('first_observed_at').notNull(),
    lastObservedAt: text('last_observed_at').notNull(),
    removedAt: text('removed_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_remote_object_provider_id').on(t.syncGenerationId, t.providerObjectId),
    index('idx_sync_remote_object_logical_key').on(t.syncGenerationId, t.logicalKeyId),
    index('idx_sync_remote_object_removed').on(t.syncGenerationId, t.removedAt),
    check(
      'sync_remote_object_kind_check',
      sql`${t.objectKind} in (
        'segment', 'genesis', 'checkpoint', 'snapshot-commit', 'blob'
      )`,
    ),
    check(
      'sync_remote_object_hash_check',
      sql`length(${t.storedSha256}) = 64 and ${t.storedSha256} not glob '*[^0-9a-f]*'`,
    ),
    check('sync_remote_object_size_check', sql`${t.sizeBytes} >= 0`),
  ],
);

export const SyncCursorTable = sqliteTable(
  'sync_cursor',
  {
    syncGenerationId: text('sync_generation_id')
      .primaryKey()
      .references(() => SyncProviderBindingTable.syncGenerationId, { onDelete: 'restrict' }),
    providerEpoch: text('provider_epoch').notNull(),
    committedCursor: text('committed_cursor'),
    pendingBaseCursor: text('pending_base_cursor'),
    pendingPageToken: text('pending_page_token'),
    inventoryComplete: integer('inventory_complete', { mode: 'boolean' })
      .notNull()
      .default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check(
      'sync_cursor_pending_pair_check',
      sql`(${t.pendingPageToken} is null and ${t.pendingBaseCursor} is null)
        or (${t.pendingPageToken} is not null and ${t.pendingBaseCursor} is not null)`,
    ),
  ],
);

export const SyncTransferTable = sqliteTable(
  'sync_transfer',
  {
    transferId: text('transfer_id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    direction: text('direction').notNull(),
    objectKind: text('object_kind').notNull(),
    logicalKeyId: text('logical_key_id').notNull(),
    localObjectId: text('local_object_id').references(() => SyncLocalObjectTable.id, {
      onDelete: 'restrict',
    }),
    remoteObjectId: text('remote_object_id').references(() => SyncRemoteObjectTable.id, {
      onDelete: 'restrict',
    }),
    expectedStoredSha256: text('expected_stored_sha256').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    transferredBytes: integer('transferred_bytes').notNull().default(0),
    state: text('state').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    sessionSecretRef: text('session_secret_ref'),
    lastErrorCode: text('last_error_code'),
    nextAttemptAt: text('next_attempt_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_transfer_active_object')
      .on(t.syncGenerationId, t.direction, t.logicalKeyId)
      .where(sql`${t.state} in ('pending', 'running', 'retry-wait')`),
    index('idx_sync_transfer_schedule').on(t.state, t.nextAttemptAt),
    check('sync_transfer_direction_check', sql`${t.direction} in ('upload', 'download')`),
    check(
      'sync_transfer_object_kind_check',
      sql`${t.objectKind} in (
        'segment', 'genesis', 'checkpoint', 'snapshot-commit', 'blob'
      )`,
    ),
    check(
      'sync_transfer_state_check',
      sql`${t.state} in ('pending', 'running', 'retry-wait', 'completed', 'cancelled', 'failed')`,
    ),
    check(
      'sync_transfer_progress_check',
      sql`${t.totalBytes} >= 0 and ${t.transferredBytes} >= 0
        and ${t.transferredBytes} <= ${t.totalBytes} and ${t.attemptCount} >= 0`,
    ),
    check(
      'sync_transfer_hash_check',
      sql`length(${t.expectedStoredSha256}) = 64
        and ${t.expectedStoredSha256} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const SyncCheckpointTable = sqliteTable(
  'sync_checkpoint',
  {
    checkpointId: text('checkpoint_id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    protocolVersion: integer('protocol_version').notNull().default(1),
    domainSchemaVersion: integer('domain_schema_version').notNull(),
    frontierCbor: blob('frontier_cbor').notNull(),
    localObjectId: text('local_object_id')
      .notNull()
      .references(() => SyncLocalObjectTable.id, { onDelete: 'restrict' }),
    logicalKeyId: text('logical_key_id').notNull(),
    contentSha256: text('content_sha256').notNull(),
    state: text('state').notNull().default('captured'),
    changeSetCount: integer('change_set_count').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: text('created_at').notNull(),
    publishedAt: text('published_at'),
    verifiedAt: text('verified_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_checkpoint_logical_key').on(t.syncGenerationId, t.logicalKeyId),
    index('idx_sync_checkpoint_state').on(t.syncGenerationId, t.state, t.createdAt),
    check('sync_checkpoint_kind_check', sql`${t.kind} in ('genesis', 'checkpoint')`),
    check(
      'sync_checkpoint_version_check',
      sql`${t.protocolVersion} = 1 and ${t.domainSchemaVersion} >= 1`,
    ),
    check(
      'sync_checkpoint_size_check',
      sql`${t.changeSetCount} >= 0 and ${t.sizeBytes} >= 0`,
    ),
    check(
      'sync_checkpoint_hash_check',
      sql`length(${t.contentSha256}) = 64 and ${t.contentSha256} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'sync_checkpoint_state_check',
      sql`${t.state} in ('captured', 'publishing', 'published', 'verified', 'quarantined')`,
    ),
  ],
);

export const SyncBlobStateTable = sqliteTable(
  'sync_blob_state',
  {
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    blobId: text('blob_id').notNull(),
    assetId: text('asset_id'),
    logicalKeyId: text('logical_key_id').notNull(),
    contentSha256: text('content_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mime: text('mime').notNull(),
    localObjectId: text('local_object_id').references(() => SyncLocalObjectTable.id, {
      onDelete: 'restrict',
    }),
    localState: text('local_state').notNull().default('missing'),
    remoteState: text('remote_state').notNull().default('missing'),
    verifiedAt: text('verified_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.syncGenerationId, t.blobId] }),
    uniqueIndex('uniq_sync_blob_logical_key').on(t.syncGenerationId, t.logicalKeyId),
    index('idx_sync_blob_delivery').on(t.syncGenerationId, t.localState, t.remoteState),
    check(
      'sync_blob_hash_check',
      sql`length(${t.contentSha256}) = 64 and ${t.contentSha256} not glob '*[^0-9a-f]*'`,
    ),
    check('sync_blob_size_check', sql`${t.sizeBytes} >= 0`),
    check(
      'sync_blob_local_state_check',
      sql`${t.localState} in ('missing', 'staged', 'verified', 'corrupt')`,
    ),
    check(
      'sync_blob_remote_state_check',
      sql`${t.remoteState} in ('missing', 'publishing', 'available', 'removed', 'corrupt')`,
    ),
  ],
);

export const SyncRestoreAttemptTable = sqliteTable(
  'sync_restore_attempt',
  {
    attemptId: text('attempt_id').primaryKey(),
    sourceSyncGenerationId: text('source_sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    sourceCheckpointId: text('source_checkpoint_id').references(
      () => SyncCheckpointTable.checkpointId,
      { onDelete: 'restrict' },
    ),
    targetProjectId: text('target_project_id'),
    stagingRef: text('staging_ref').notNull(),
    state: text('state').notNull().default('downloading'),
    validationCode: text('validation_code'),
    activationReceipt: text('activation_receipt'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_restore_active_generation')
      .on(t.sourceSyncGenerationId)
      .where(sql`${t.state} in ('downloading', 'validating', 'staging-assets', 'activating')`),
    index('idx_sync_restore_state').on(t.state, t.updatedAt),
    check(
      'sync_restore_state_check',
      sql`${t.state} in (
        'downloading', 'validating', 'staging-assets', 'activating',
        'completed', 'failed', 'cancelled'
      )`,
    ),
  ],
);

export const SyncConnectAttemptTable = sqliteTable(
  'sync_connect_attempt',
  {
    attemptId: text('attempt_id').primaryKey(),
    authorityGeneration: integer('authority_generation').notNull(),
    kind: text('kind').notNull(),
    targetMode: text('target_mode').notNull(),
    targetAccountSubjectId: text('target_account_subject_id'),
    targetCredentialSecretRef: text('target_credential_secret_ref'),
    state: text('state').notNull().default('preparing'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    index('idx_sync_connect_attempt_state').on(t.state, t.updatedAt),
    check('sync_connect_generation_check', sql`${t.authorityGeneration} >= 1`),
    check(
      'sync_connect_kind_check',
      sql`${t.kind} in ('connect', 'switch-provider', 'disconnect', 'restore')`,
    ),
    check(
      'sync_connect_target_mode_check',
      sql`${t.targetMode} in ('local', 'google-drive', 'hosted')`,
    ),
    check(
      'sync_connect_target_account_check',
      sql`(${t.targetMode} = 'local'
          and ${t.targetAccountSubjectId} is null
          and ${t.targetCredentialSecretRef} is null)
        or (${t.targetMode} in ('google-drive', 'hosted')
          and ${t.targetAccountSubjectId} is not null
          and ${t.targetCredentialSecretRef} is not null)`,
    ),
    check(
      'sync_connect_kind_target_check',
      sql`(${t.kind} = 'disconnect' and ${t.targetMode} = 'local')
        or (${t.kind} in ('connect', 'switch-provider', 'restore')
          and ${t.targetMode} in ('google-drive', 'hosted'))`,
    ),
    check(
      'sync_connect_state_check',
      sql`${t.state} in (
        'preparing', 'discovering', 'publishing-genesis', 'restoring',
        'activating', 'completed', 'blocked', 'failed', 'cancelled'
      )`,
    ),
    check(
      'sync_connect_completion_check',
      sql`(${t.state} in ('completed', 'failed', 'cancelled')
          and ${t.completedAt} is not null)
        or (${t.state} not in ('completed', 'failed', 'cancelled')
          and ${t.completedAt} is null)`,
    ),
  ],
);

export const SyncConnectGenerationAttemptTable = sqliteTable(
  'sync_connect_generation_attempt',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => SyncConnectAttemptTable.attemptId, { onDelete: 'restrict' }),
    sourceSyncGenerationId: text('source_sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    targetSyncGenerationId: text('target_sync_generation_id').references(
      () => SyncGenerationTable.syncGenerationId,
      { onDelete: 'restrict' },
    ),
    sourceCheckpointId: text('source_checkpoint_id').references(
      () => SyncCheckpointTable.checkpointId,
      { onDelete: 'restrict' },
    ),
    commitMarkerObjectId: text('commit_marker_object_id').references(
      () => SyncRemoteObjectTable.id,
      { onDelete: 'restrict' },
    ),
    activationReceipt: text('activation_receipt'),
    state: text('state').notNull().default('pending'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    activatedAt: text('activated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.sourceSyncGenerationId] }),
    uniqueIndex('uniq_sync_connect_generation_target')
      .on(t.attemptId, t.targetSyncGenerationId)
      .where(sql`${t.targetSyncGenerationId} is not null`),
    index('idx_sync_connect_generation_state').on(t.attemptId, t.state, t.updatedAt),
    check(
      'sync_connect_generation_target_check',
      sql`${t.targetSyncGenerationId} is null
        or ${t.targetSyncGenerationId} <> ${t.sourceSyncGenerationId}`,
    ),
    check(
      'sync_connect_generation_state_check',
      sql`${t.state} in (
        'pending', 'capturing', 'publishing', 'restoring', 'committed',
        'activating', 'activated', 'failed', 'cancelled'
      )`,
    ),
    check(
      'sync_connect_generation_activation_check',
      sql`(${t.state} = 'activated'
          and ${t.activationReceipt} is not null
          and ${t.activatedAt} is not null)
        or (${t.state} <> 'activated'
          and ${t.activationReceipt} is null
          and ${t.activatedAt} is null)`,
    ),
  ],
);

export const SyncConflictTable = sqliteTable(
  'sync_conflict',
  {
    conflictId: text('conflict_id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    incarnation: integer('incarnation'),
    changeSetId: text('change_set_id').references(() => SyncChangeSetTable.changeSetId, {
      onDelete: 'restrict',
    }),
    mutationIndex: integer('mutation_index'),
    detailsCbor: blob('details_cbor').notNull(),
    state: text('state').notNull().default('open'),
    resolutionCbor: blob('resolution_cbor'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    index('idx_sync_conflict_open').on(t.syncGenerationId, t.state, t.createdAt),
    check(
      'sync_conflict_kind_check',
      sql`${t.kind} in ('semantic', 'invariant', 'object-collision', 'writer-fork')`,
    ),
    check(
      'sync_conflict_mutation_pair_check',
      sql`(${t.changeSetId} is null and ${t.mutationIndex} is null)
        or (${t.changeSetId} is not null and ${t.mutationIndex} >= 0)`,
    ),
    check(
      'sync_conflict_state_check',
      sql`(${t.state} = 'open' and ${t.resolvedAt} is null)
        or (${t.state} in ('resolved', 'dismissed') and ${t.resolvedAt} is not null)`,
    ),
  ],
);

export const SyncQuarantinedObjectTable = sqliteTable(
  'sync_quarantined_object',
  {
    quarantineId: text('quarantine_id').primaryKey(),
    syncGenerationId: text('sync_generation_id')
      .notNull()
      .references(() => SyncGenerationTable.syncGenerationId, { onDelete: 'restrict' }),
    remoteObjectId: text('remote_object_id').references(() => SyncRemoteObjectTable.id, {
      onDelete: 'restrict',
    }),
    localObjectId: text('local_object_id')
      .notNull()
      .references(() => SyncLocalObjectTable.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    observedProtocol: text('observed_protocol'),
    observedVersion: integer('observed_version'),
    storedSha256: text('stored_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    uniqueIndex('uniq_sync_quarantine_local_object').on(t.localObjectId),
    index('idx_sync_quarantine_state').on(t.syncGenerationId, t.state, t.createdAt),
    check(
      'sync_quarantine_hash_check',
      sql`length(${t.storedSha256}) = 64 and ${t.storedSha256} not glob '*[^0-9a-f]*'`,
    ),
    check('sync_quarantine_size_check', sql`${t.sizeBytes} >= 0`),
    check(
      'sync_quarantine_state_check',
      sql`(${t.state} in ('blocked-update', 'blocked-corrupt') and ${t.resolvedAt} is null)
        or (${t.state} in ('released', 'discarded') and ${t.resolvedAt} is not null)`,
    ),
  ],
);
