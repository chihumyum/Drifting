import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  blob,
} from 'drizzle-orm/sqlite-core';
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
  descriptionJson: text('description_json').default('{}'),
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
    descriptionJson: text('description_json').default('{}'),
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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_element_category_project').on(t.projectId)],
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
  kvJson: text('kv_json').notNull().default('[]'),
  nodeContentTemplateJson: text('node_content_template_json').notNull().default('{}'),
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
    // value encodes. Nullable: drift nodes (mainStorylineId == null) have no
    // place on the reading order axis and store NULL here.
    bookOrder: integer('book_order'),
    // Author-defined position on the narrative timeline (separate axis from
    // book order — allows flashbacks / non-linear chronology). Nullable: a
    // node may not yet be placed on the narrative axis.
    narrativeOrder: integer('narrative_order'),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    // Nullable: drift nodes (free-floating inspiration notes) have no main
    // storyline. When a storyline is deleted, affected nodes are reassigned to
    // one of their other storylines, or fall back to drift if none remain.
    mainStorylineId: text('main_storyline_id').references(() => StorylineTable.id, {
      onDelete: 'set null',
    }),
    // Materialized word count, derived from this node's content.
    // Updated on every save; defaults to 0 for nodes that have never been edited.
    wordCount: integer('word_count').notNull().default(0),
    // Author-facing chapter status. Manual: user marks 'finished' from the
    // editor menu (the future AI-review pipeline will route that through
    // waiting_review → revising before landing on finished). Stored as plain
    // text — the enum lives in the domain layer (see WritingStatus).
    writingStatus: text('writing_status').notNull().default('draft'),
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

// Story-graph edges live in `entity_reference` now — manual whole-to-whole
// rows with fromKind/toKind = 'node' and the user-defined relation category
// in `kind`. The legacy book_node_edge table was folded into entity_reference
// by migration 0021; its visual columns (anchors/control points/style) were
// never read by the renderer, so they were dropped.

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
  // Element's own KV facts. Seeded at creation from the parent category's
  // elementTemplateKvJson; once seeded, the element owns its copy. JSON
  // array, same shape as Project.kvJson — see domain/kv.ts.
  kvJson: text('kv_json').notNull().default('[]'),
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
// FK enforcement is skipped on the polymorphic columns; cleanup of orphaned
// rows is done explicitly when an entity is deleted.
export const EntityReferenceTable = sqliteTable(
  'entity_reference',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),

    // fromKind ∈ EntityKind (all 7) — memo / material can link OUT.
    // toKind   ∈ StructuralEntityKind (5) — memo / material are never targets.
    // See domain/entity-kinds.ts for the canonical vocabulary + guards.
    fromKind: text('from_kind').notNull(),
    fromId: text('from_id').notNull(),
    fromBlockId: text('from_block_id'),
    fromSpansJson: text('from_spans_json'),

    toKind: text('to_kind').notNull(),
    toId: text('to_id').notNull(),
    toBlockId: text('to_block_id'),

    // Free-form user category for the relation itself (NOT the endpoint type
    // — that's fromKind/toKind). Nullable string, no fixed vocabulary; the
    // StoryGraph and SuperElement views surface it as filter chips and feed
    // it from their respective manual-create modals.
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

// Manuscript Comment
// Word-style marginal comment anchored to a block in a content-bearing entity.
// It is intentionally independent from Memo and ElementPatch:
// - Memo is project-level thinking / TODO, linked through entity_reference.
// - ElementPatch is additive canonical content for an element.
// - ManuscriptComment is review/annotation state that may later carry AI,
//   external, copilot, or patch-suggestion metadata through comment_action.
export const ManuscriptCommentTable = sqliteTable(
  'manuscript_comment',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').notNull(), // StructuralEntityKind — see domain/entity-kinds.ts
    targetId: text('target_id').notNull(),
    targetBlockId: text('target_block_id').notNull(),
    anchorJson: text('anchor_json').notNull().default('{}'),
    authorKind: text('author_kind').notNull().default('user'), // user | ai | copilot | external
    authorId: text('author_id'),
    authorName: text('author_name'),
    bodyJson: text('body_json').notNull().default('{}'),
    status: text('status').notNull().default('open'), // open | resolved | converted
    priority: text('priority'),
    source: text('source').notNull().default('manual'), // manual | shadow | copilot | api
    metadataJson: text('metadata_json'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_comment_project').on(t.projectId),
    index('idx_comment_target').on(t.targetKind, t.targetId),
    index('idx_comment_block').on(t.targetKind, t.targetId, t.targetBlockId),
    index('idx_comment_project_status').on(t.projectId, t.status),
  ],
);

// Comment Action
// Append-only-ish action record for operations initiated from a comment.
// v1 writes convert_to_memo; future patch/apply/reject/copilot actions can
// share this surface without changing ManuscriptComment itself.
export const CommentActionTable = sqliteTable(
  'comment_action',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => ProjectTable.id, { onDelete: 'cascade' }),
    commentId: text('comment_id')
      .notNull()
      .references(() => ManuscriptCommentTable.id, { onDelete: 'cascade' }),
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
