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

// Project Rule (Shadow Mode)
// Domain: ProjectRule — a project-owned review rule the shadow CI checks chapters
// against. The author writes rules FREEFORM (rawContent: a kv-ish line or prose);
// an LLM normalizer compiles each into checklistJson — a list of atomic
// assertions, each with an inferred `type` (mechanical kinds like word-count /
// must-appear, or 'semantic'). compiledFromHash holds the hash of rawContent at
// compile time, so a rule recompiles only when its source changes.
//
// scopeJson is AUTHOR-owned metadata (null = whole project) narrowing which
// chapters/storylines/elements the rule applies to. There is no soft/advisory
// tier — ANY violation drives the chapter to 'revising' (the author can still
// resolve or finish manually).
//
// source 'project' = authored here; 'drift' = discovered from a drift node and
// pending until enabled. sourceDriftHash drives incremental re-discovery (only
// re-classify a drift whose content changed). Facts/summary are NOT rules — they
// are auxiliary ground-truth pulled at evaluation time.
export const ProjectRuleTable = sqliteTable('project_rule', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  rawContent: text('raw_content').notNull().default(''),
  checklistJson: text('checklist_json').notNull().default('[]'),
  // Enhancement-compiler outputs: `kind` routes judging; `judgingGuide` is the LLM-
  // authored, author-editable judging template injected into the Shadow judge's prompt.
  kind: text('kind').notNull().default('other'),
  judgingGuide: text('judging_guide').notNull().default(''),
  compiledFromHash: text('compiled_from_hash').notNull().default(''),
  scopeJson: text('scope_json'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  source: text('source').notNull().default('project'),
  sourceDriftId: text('source_drift_id'),
  sourceDriftHash: text('source_drift_hash'),
  orderKey: integer('order_key').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Shadow Job
// Domain: ShadowJob — one record per chapter shadow-review run, kept for
// observability. The right-rail Shadow panel lists these; a cell expands to its
// `trace_json` (the structured evidence-gathering / decision trail). Local-only
// (never synced): these are runtime telemetry, not authored content.
//   status:   running | done | failed
//   decision: finished | draft | null (null while running / on failure)
//   traceJson: ShadowTraceStep[] — phase steps, per-rule evidence rounds, verdicts
export const ShadowJobTable = sqliteTable(
  'shadow_job',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    chapterId: text('chapter_id').notNull(),
    chapterTitle: text('chapter_title').notNull().default(''),
    status: text('status').notNull().default('running'),
    decision: text('decision'),
    findingCount: integer('finding_count').notNull().default(0),
    error: text('error'),
    traceJson: text('trace_json').notNull().default('[]'),
    // The canon entities the FC judge ACTUALLY consulted this review (resolved
    // {kind,id,label}). The precise `(chapter)→entities` dependency edges — the
    // compiler `-MMD` to the inline-mention `grep #include`.
    consultedJson: text('consulted_json').notNull().default('[]'),
    // Was a consultation set MEASURED this review? Disambiguates an empty
    // consulted_json: false = legacy/un-measured (staleness falls back to prose
    // mentions); true = measured, and an empty set means "no entity deps" (don't
    // fall back). Set true by setShadowConsulted at the end of a real review.
    consultedCaptured: integer('consulted_captured', { mode: 'boolean' }).notNull().default(false),
    // Value-state of the consulted canon AT THIS REVIEW — {kind,id,label,summary?,facts?}[].
    // The baseline a later re-review diffs CURRENT canon against to produce the old→new
    // dep-hint fed to the judge. consultedJson holds identity; this holds the values.
    consultedSnapshotJson: text('consulted_snapshot_json').notNull().default('[]'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_shadow_job_project').on(t.projectId),
    index('idx_shadow_job_chapter').on(t.chapterId),
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
  contentJson: text('content_json').notNull().default('{}'),
  kvJson: text('kv_json').notNull().default('[]'),
  nodeContentTemplateJson: text('node_content_template_json').notNull().default('{}'),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  index('idx_storyline_deleted_at').on(t.deletedAt),
]);

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
    // Author-facing chapter status. Manual: user marks 'finished' from the
    // editor menu (the future AI-review pipeline will route that through
    // waiting_review → revising before landing on finished). Stored as plain
    // text — the enum lives in the domain layer (see WritingStatus).
    writingStatus: text('writing_status').notNull().default('draft'),
    // Explicit discriminator between 'chapter' and 'drift'. Replaces the
    // historical "mainStorylineId nullability" implicit discriminator. A
    // chapter without a primary storyline link is now a legal state ("未归属"
    // / unaffiliated chapter); the type was previously forced to drift.
    // See domain/book-node.ts for the WritingStatus enum split.
    kind: text('kind').notNull().default('drift'),
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
    index('idx_book_node_deleted_at').on(t.deletedAt),
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
export const BookElementTable = sqliteTable('element', {
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
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  index('idx_element_deleted_at').on(t.deletedAt),
  index('idx_element_category').on(t.categoryId),
]);

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
    // payload unchanged. Invalidated patches are EXCLUDED from Shadow / agent
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
    source: text('source').notNull().default('manual'), // manual | shadow | copilot | api
    metadataJson: text('metadata_json'),
    // JSON array of block ids this comment anchors to (a consecutive range).
    // targetBlockId stays the primary/first (card position + back-compat); this
    // is the full span, written by both manual multi-block selection and shadow.
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
//   'local' — uri is a file:// path; localPath is the absolute on-disk path
//   'url'   — uri is the http(s) URL itself
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
    index('idx_library_item_project').on(t.projectId),
    index('idx_library_item_project_kind').on(t.projectId, t.kind),
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
