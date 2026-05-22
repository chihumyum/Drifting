import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
  blob,
} from 'drizzle-orm/sqlite-core';
// schema definition in users' local sqlite database.

// project
// Domain: Project
export const ProjectTable = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  descriptionJson: text('description_json').default('{}'),
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
    descriptionJson: text('description_json').default('{}'),
    elementTemplateJson: text('element_template_json').default('{}'),
    color: text('color').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    layoutMode: text('layout_mode').notNull().default('auto'), // 'auto' | 'pinned'
    gridX: integer('grid_x'),
    gridY: integer('grid_y'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_element_category_project').on(t.projectId)],
);

// Story Stages
// project(1) <-> storyStage(N)
// storyStage(1) <-> node(N)
// Domain: StoryStage
export const StoryStageTable = sqliteTable(
  'story_stages',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    descriptionJson: text('description_json').default('{}'),
    orderKey: integer('order_key').notNull(),
    color: text('color').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_unique_stage_per_project').on(t.projectId, t.orderKey),
    index('idx_story_stage_project').on(t.projectId),
  ],
);

// Storylines
// project(1) <-> storyline(N)
// storyline(N) <-> node(N)
// Domain: Storyline
export const StorylineTable = sqliteTable('storylines', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => ProjectTable.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  summary: text('summary').notNull().default(''),
  orderKey: integer('order_key').notNull(),
  descriptionJson: text('description_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Story Nodes
// Domain: BookNode
export const BookNodeTable = sqliteTable(
  'book_node',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    // Pure sortable integer for book/reading order. Was `start` back when
    // node tiles had a `start`/`end` "video clip" metaphor; the metaphor was
    // dropped — tiles are fixed-width now and order is the only thing this
    // value encodes.
    bookOrder: integer('book_order').notNull(),
    // Author-defined position on the narrative timeline (separate axis from
    // book order — allows flashbacks / non-linear chronology). Nullable: a
    // node may not yet be placed on the narrative axis.
    narrativeOrder: integer('narrative_order'),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    storyStageId: text('story_stage_id').references(() => StoryStageTable.id, {
      onDelete: 'set null',
    }),
    // Nullable: drift nodes (free-floating inspiration notes) have no main
    // storyline. When a storyline is deleted, affected nodes are reassigned to
    // one of their other storylines, or fall back to drift if none remain.
    mainStorylineId: text('main_storyline_id').references(() => StorylineTable.id, {
      onDelete: 'set null',
    }),
    // Materialized word count, derived from this node's content.
    // Updated on every save; defaults to 0 for nodes that have never been edited.
    wordCount: integer('word_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // graph view positions
    positionX: real('position_x').notNull(),
    positionY: real('position_y').notNull(),
  },
  (t) => [
    index('idx_book_node_project').on(t.projectId),
    index('idx_book_node_stage').on(t.storyStageId),
    index('idx_book_node_project_book_order').on(t.projectId, t.bookOrder),
    index('idx_book_node_project_narrative_order').on(t.projectId, t.narrativeOrder),
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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_node_content_node').on(t.nodeId)],
);

// Node Edges
// for graph view UI persistence
// Domain: BookNodeEdge
export const NodeEdgeTable = sqliteTable(
  'book_node_edge',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id')
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    targetNodeId: text('target_node_id')
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    // Free-form user-defined category. GraphView groups edges by `kind`
    // for its filter chips; null = uncategorized. There is no fixed
    // vocabulary — authors mint kinds as they need them (e.g. "引用",
    // "回响", "同人物"); a hash of the string drives the default color.
    kind: text('kind'),
    weight: integer('weight').notNull().default(1),
    isDirected: integer('is_directed', { mode: 'boolean' }).notNull().default(true),
    styleJson: text('style_json'), // Stores stroke, width, etc.
    controlPointOffsetJson: text('control_point_offset_json'),
    sourceAnchorJson: text('source_anchor_json'),
    targetAnchorJson: text('target_anchor_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_edge_project_source').on(t.projectId, t.sourceNodeId),
    index('idx_edge_project_target').on(t.projectId, t.targetNodeId),
  ],
);

// Book element
// Domain: BookElement
//
// groupName is a lightweight secondary grouping within a category — just a
// label, no separate entity. Elements sharing the same (categoryId, groupName)
// are rendered together inside the category. Null = "ungrouped" bucket, which
// SuperElementView renders last. Rename by SQL update; delete by setting to
// null. If we ever need ordering or colors, promote to ElementGroupTable.
export const BookElementTable = sqliteTable('element', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => ProjectTable.id, { onDelete: 'cascade' }),
  categoryId: text('category_id')
    .notNull()
    .references(() => ElementCategoryTable.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  summary: text('summary').notNull().default(''),
  contentJson: text('content_json').notNull().default('{}'),
  groupName: text('group_name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Node <-> Storyline (Many-to-Many)
export const NodeStorylineLinkTable = sqliteTable(
  'node_storyline_link',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    storylineId: text('storyline_id')
      .notNull()
      .references(() => StorylineTable.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.storylineId] }),
    index('idx_node_storyline_node').on(table.nodeId),
    index('idx_node_storyline_storyline').on(table.storylineId),
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

// Entity Reference
// A directed reference: "the document (fromKind, fromId) references the entity (toKind, toId)".
// Both ends are polymorphic across nodes / elements / patches. The reference can be
// inline (sitting in the from-document's content) or manual (an asserted relation
// without any content mark). The target may be the whole entity or a specific block.
//
//   fromBlockId   | toBlockId      | meaning
//   --------------|----------------|----------------------------------
//   non-null      | null           | mention in fromBlock points to whole entity
//   non-null      | non-null       | mention in fromBlock deep-links to a block
//   null          | null           | manual whole-to-whole relation (no content)
//   null          | non-null       | manual whole-to-block relation (rare)
//
// origin records who created the reference: 'manual' (user), 'auto' (auto-detect),
// 'ai' (applied AI suggestion). FK enforcement is skipped on the polymorphic columns;
// cleanup of orphaned rows is done explicitly when an entity is deleted.
export const EntityReferenceTable = sqliteTable(
  'entity_reference',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),

    fromKind: text('from_kind').notNull(), // 'node' | 'element' | 'patch'
    fromId: text('from_id').notNull(),
    fromBlockId: text('from_block_id'),
    fromSpansJson: text('from_spans_json'),

    toKind: text('to_kind').notNull(), // 'node' | 'element' | 'patch'
    toId: text('to_id').notNull(),
    toBlockId: text('to_block_id'),

    origin: text('origin').notNull().default('manual'), // 'manual' | 'auto' | 'ai'
    confidence: real('confidence'),
    // Free-form user category for the relation itself (NOT the endpoint type
    // — that's fromKind/toKind). Mirrors BookNodeEdge.kind: nullable string,
    // no fixed vocabulary. SuperElementView's manual-create modal feeds
    // this; auto / ai-origin refs leave it null by default.
    kind: text('kind'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_ref_from').on(t.fromKind, t.fromId),
    index('idx_ref_to').on(t.toKind, t.toId),
    index('idx_ref_project').on(t.projectId),
  ],
);

// Memo
// Project-level note / TODO. Whether a memo is treated as a task is the
// author's choice via `resolution`:
//   'no_action'  — pure note, no checkbox shown on the card
//   'unresolved' — promoted to TODO; card shows a checkbox affordance
//   'resolved'   — completed; hidden from the main list, surfaced in
//                  the collapsed "已解决" archive group
// Linkage to other entities (chapter / drift / element / storyline / category)
// goes through `entity_reference` with fromKind='memo'.
export const MemoTable = sqliteTable(
  'memo',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    bodyJson: text('body_json').notNull().default('{}'),
    resolution: text('resolution').notNull().default('no_action'),
    priority: text('priority'),
    dueAt: text('due_at'),
    orderKey: integer('order_key').notNull().default(0),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_memo_project').on(t.projectId),
    index('idx_memo_project_resolution').on(t.projectId, t.resolution),
  ],
);

// Material
// Project-level reference asset. A material has one of four kinds — image, pdf,
// url, or markdown — and a source describing where it lives:
//   'local' — uri is a file:// path; localPath is the absolute on-disk path
//   'url'   — uri is the http(s) URL itself
// Markdown materials store their content inline in bodyJson (TipTap doc).
// notesJson is the author's free-form annotations attached to the material.
// Linkage goes through `entity_reference` with fromKind='material'.
export const MaterialTable = sqliteTable(
  'material',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    kind: text('kind').notNull(), // 'image' | 'pdf' | 'url' | 'markdown'
    source: text('source').notNull().default('local'), // 'local' | 'url'
    uri: text('uri').notNull().default(''),
    localPath: text('local_path'),
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
    index('idx_material_project').on(t.projectId),
    index('idx_material_project_kind').on(t.projectId, t.kind),
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
