import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

// Projects
// Domain: Project
export const projects = sqliteTable('projects', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(), // should reference to userId in server pg
    name: text('name').notNull(),
    author: text('author').notNull(),
    descriptionJson: text('description_json').default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Element Categories
// project(1) <-> elementCategory(N)
// elementCategory(1) <-> element(N)
// Domain: BookElementCategory
export const elementCategories = sqliteTable('element_categories', {
    id: text('id').primaryKey(),
    name: text('name').notNull(), // Unique in domain logic potentially
    descriptionJson: text('description_json').default('{}'),
    color: text('color').notNull(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Story Stages
// project(1) <-> storyStage(N)
// storyStage(1) <-> node(N)
// Domain: StoryStage
export const storyStages = sqliteTable('story_stages', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    descriptionJson: text('description_json').default('{}'),
    orderKey: integer('order_key').notNull(),
    // storyStages are allowed to contain 0 node
    startNodeId: text('start_node_id'), // Can be null initially?
    endNodeId: text('end_node_id'),
    color: text('color').notNull(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Storylines
// project(1) <-> storyline(N)
// storyline(1) <-> node(N)
// Domain: Storyline
export const storylines = sqliteTable('storylines', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    summary: text('summary').default(''),
    descriptionJson: text('description_json').default('{}'),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Story Nodes  
// Domain: BookNode
export const storyNodes = sqliteTable('story_nodes', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').default(''),
    start: integer('start').notNull(),
    end: integer('end').notNull().default(0), // Nullable in domain
    storyStageId: text('story_stage_id').references(() => storyStages.id, { onDelete: 'set null' }),
    positionX: real('position_x').notNull(),
    positionY: real('position_y').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (table) => [
    index('idx_story_nodes_project').on(table.projectId),
    index('idx_story_nodes_stage').on(table.storyStageId),
]);

// Node Contents (Separate to avoid loading huge JSONs when listing nodes)
// Domain: NodeContent
export const nodeContents = sqliteTable('node_contents', {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull().references(() => storyNodes.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    contentJson: text('content_json').default('{}'),
    outlineJson: text('outline_json').default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (table) => [
    index('idx_node_contents_node').on(table.nodeId),
]);

// Node Edges
// Domain: BookNodeEdge
export const storyNodeEdges = sqliteTable('story_node_edges', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id').notNull().references(() => storyNodes.id, { onDelete: 'cascade' }),
    targetNodeId: text('target_node_id').notNull().references(() => storyNodes.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    weight: integer('weight').notNull().default(1),
    isDirected: integer('is_directed', { mode: 'boolean' }).notNull().default(true),
    styleJson: text('style_json'), // Stores stroke, width, etc.
    controlPointOffsetJson: text('control_point_offset_json'),
    sourceAnchorJson: text('source_anchor_json'),
    targetAnchorJson: text('target_anchor_json'),
    createdAt: text('created_at').notNull(),
});

// Elements (BookElement)
// Domain: BookElement
export const elements = sqliteTable('elements', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').references(() => elementCategories.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    summary: text('summary').default(''),
    contentJson: text('content_json').default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Element Stages
// Domain: BookElementStage
export const elementStages = sqliteTable('element_stages', {
    id: text('id').primaryKey(),
    elementId: text('element_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
    orderKey: integer('order_key').notNull(),
    startNodeId: text('start_node_id'),
    endNodeId: text('end_node_id'),
    stageName: text('stage_name').notNull(),
    contentJson: text('content_json').default('{}'),
    summary: text('summary').default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});

// Tags
// Domain: NodeTag & ElementTag (Shared structure, separate tables or normalized?)
// Domain has separate interfaces. Let's keep them separate for clarity unless they are truly identical.
export const nodeTags = sqliteTable('node_tags', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: text('created_at').notNull(),
});

export const elementTags = sqliteTable('element_tags', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(), // ElementTag domain has projectId? Yes.
    name: text('name').notNull(),
    color: text('color'),
    createdAt: text('created_at').notNull(),
});

// Junction Tables

// Project <-> Element Category (Joined)
export const projectElementCategories = sqliteTable('project_element_categories', {
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').notNull().references(() => elementCategories.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.categoryId] }),
}));

// Node <-> Storyline (Many-to-Many)
export const nodeStorylines = sqliteTable('node_storylines', {
    nodeId: text('node_id').notNull().references(() => storyNodes.id, { onDelete: 'cascade' }),
    storylineId: text('storyline_id').notNull().references(() => storylines.id, { onDelete: 'cascade' }),
    storylineOrder: integer('storyline_order').notNull().default(0),
}, (table) => ({
    pk: primaryKey({ columns: [table.nodeId, table.storylineId] }),
}));

// Node <-> Tag
export const nodeTagsLink = sqliteTable('node_tags_link', {
    nodeId: text('node_id').notNull().references(() => storyNodes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id').notNull().references(() => nodeTags.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.nodeId, table.tagId] }),
}));

// Element <-> Tag
export const elementTagsLink = sqliteTable('element_tags_link', {
    elementId: text('element_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
    tagId: text('tag_id').notNull().references(() => elementTags.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.elementId, table.tagId] }),
}));

// Node <-> Element (Mentions/Links)
// Domain: BookNodeElementLink
export const nodeElementsLink = sqliteTable('node_elements_link', {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull().references(() => storyNodes.id, { onDelete: 'cascade' }),
    elementId: text('element_id').notNull().references(() => elements.id, { onDelete: 'cascade' }),
});
