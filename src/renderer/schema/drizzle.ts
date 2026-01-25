import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
export const ElementCategoryTable = sqliteTable('element_category', {
    id: text('id').primaryKey(),
    name: text('name').notNull(), // Unique in domain logic potentially
    descriptionJson: text('description_json').default('{}'),
    color: text('color').notNull(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    uniqueIndex('idx_unique_category_per_project').on(t.projectId, t.name),
    index('idx_element_category_project').on(t.projectId),
]);

// Story Stages
// project(1) <-> storyStage(N)
// storyStage(1) <-> node(N)
// Domain: StoryStage
export const StoryStageTable = sqliteTable('story_stages', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    descriptionJson: text('description_json').default('{}'),
    orderKey: integer('order_key').notNull(),
    color: text('color').notNull(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    uniqueIndex('idx_unique_stage_per_project').on(t.projectId, t.orderKey),
    index('idx_story_stage_project').on(t.projectId),
]);

// Storylines
// project(1) <-> storyline(N)
// storyline(N) <-> node(N)
// Domain: Storyline
export const StorylineTable = sqliteTable('storylines', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
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
export const BookNodeTable = sqliteTable('book_node', {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    start: integer('start').notNull(),
    end: integer('end').notNull().default(0), // Nullable in domain
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    storyStageId: text('story_stage_id').references(() => StoryStageTable.id, { onDelete: 'set null' }), 
    // TODO: need to reassign all nodes before deleting main storyline
    mainStorylineId: text('main_storyline_id').notNull().references(() => StorylineTable.id, { onDelete: 'restrict' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // graph view positions
    positionX: real('position_x').notNull(),
    positionY: real('position_y').notNull(),
}, (t) => [
    index('idx_book_node_project').on(t.projectId),
    index('idx_book_node_stage').on(t.storyStageId),
    index('idx_book_node_project_start').on(t.projectId, t.start),
    index('idx_book_node_project_end').on(t.projectId, t.end),
]);

// Node Contents (Separate to avoid loading huge JSONs when listing nodes)
// Domain: NodeContent
export const NodeContentTable = sqliteTable('node_content', {
    nodeId: text('node_id').primaryKey().notNull().references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    contentJson: text('content_json').default('{}'),
    outlineJson: text('outline_json').default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    index('idx_node_content_node').on(t.nodeId),
]);

// Node Edges
// for graph view UI persistence
// Domain: BookNodeEdge
export const NodeEdgeTable = sqliteTable('book_node_edge', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id').notNull().references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    targetNodeId: text('target_node_id').notNull().references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    weight: integer('weight').notNull().default(1),
    isDirected: integer('is_directed', { mode: 'boolean' }).notNull().default(true),
    styleJson: text('style_json'), // Stores stroke, width, etc.
    controlPointOffsetJson: text('control_point_offset_json'),
    sourceAnchorJson: text('source_anchor_json'),
    targetAnchorJson: text('target_anchor_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    index('idx_edge_project_source').on(t.projectId, t.sourceNodeId),
    index('idx_edge_project_target').on(t.projectId, t.targetNodeId),
]);

// Book element
// Domain: BookElement
export const BookElementTable = sqliteTable('element', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').notNull().references(() => ElementCategoryTable.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    summary: text('summary').notNull().default(''),
    contentJson: text('content_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Element Stages
// Domain: BookElementStage
export const ElementStageTable = sqliteTable('element_stage', {
    id: text('id').primaryKey(),
    elementId: text('element_id').notNull().references(() => BookElementTable.id, { onDelete: 'cascade' }),
    stageName: text('stage_name').notNull(),
    summary: text('summary').default(''),
    contentJson: text('content_json').default('{}'),
    orderKey: integer('order_key').notNull(),
    startNodeId: text('start_node_id').references(() => BookNodeTable.id, { onDelete: 'set null' }),
    endNodeId: text('end_node_id').references(() => BookNodeTable.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});


// Node <-> Storyline (Many-to-Many)
export const NodeStorylineLinkTable = sqliteTable('node_storyline_link', {
    nodeId: text('node_id').notNull().references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    storylineId: text('storyline_id').notNull().references(() => StorylineTable.id, { onDelete: 'cascade' }),
}, (table) => [
    primaryKey({ columns: [table.nodeId, table.storylineId] }),
    index('idx_node_storyline_node').on(table.nodeId),
    index('idx_node_storyline_storyline').on(table.storylineId),
]);

// Node Tags
export const NodeTagTable = sqliteTable('node_tag', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    uniqueIndex('idx_unique_node_tag_per_project').on(t.projectId, t.name),
    index('idx_node_tag_project').on(t.projectId),
]);

export const NodeTagLinkTable = sqliteTable('node_tag_link', {
    nodeId: text('node_id').notNull().references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    tagId: text('tag_id').notNull().references(() => NodeTagTable.id, { onDelete: 'cascade' }),
}, (t) => [
    primaryKey({ columns: [t.nodeId, t.tagId] }),
]);

export const ElementTagTable = sqliteTable('element_tag', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => ProjectTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    uniqueIndex('idx_unique_element_tag_per_project').on(t.projectId, t.name),
    index('idx_element_tag_project').on(t.projectId),
]);

export const ElementTagLinkTable = sqliteTable('element_tag_link', {
    elementId: text('element_id').notNull().references(() => BookElementTable.id, { onDelete: 'cascade' }),
    tagId: text('tag_id').notNull().references(() => ElementTagTable.id, { onDelete: 'cascade' }),
}, (t) => [
    primaryKey({ columns: [t.elementId, t.tagId] }),
]);




// Node <-> Element (Mentions)
// Domain: BookNodeElementLink
export const NodeElementBacklinkTable = sqliteTable('node_element_backlink', {
    nodeId: text('node_id').notNull().references(() => BookNodeTable.id, { onDelete: 'cascade' }),
    elementId: text('element_id').notNull().references(() => BookElementTable.id, { onDelete: 'cascade' }),
}, (t) => [
    primaryKey({ columns: [t.nodeId, t.elementId] }),
]);
