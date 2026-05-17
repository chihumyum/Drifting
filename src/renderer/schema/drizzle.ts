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
    start: integer('start').notNull(),
    end: integer('end').notNull().default(0), // Nullable in domain
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
    index('idx_book_node_project_start').on(t.projectId, t.start),
    index('idx_book_node_project_end').on(t.projectId, t.end),
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

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_ref_from').on(t.fromKind, t.fromId),
    index('idx_ref_to').on(t.toKind, t.toId),
    index('idx_ref_project').on(t.projectId),
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
