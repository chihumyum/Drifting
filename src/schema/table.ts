import type { Project } from "./book_general";
import type { ElementRecord, ElementCategoryRecord } from "./book_element";



export const TABLES = {
  project: 'project',
  storyNode: 'story_node',
  nodeEdge: 'node_edge',
  nodeBlock: 'node_block',
  element: 'element',
  elementStage: 'element_stage',
} as const


export const DB_SCHEMA = `
-- =============================
-- Book Element / Element Schema
-- =============================
-- Projects table
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_name ON project(name);
-- Category table (element categories)
CREATE TABLE IF NOT EXISTS element_category (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  color TEXT NULL
);

-- Core element (element) table
CREATE TABLE IF NOT EXISTS element (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category_id TEXT,                 -- FK to element_category (may be null / delayed assignment)
  type TEXT NOT NULL,               -- semantic type (e.g. character/location/object)
  name TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(category_id) REFERENCES element_category(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_element_project ON element(project_id);
CREATE INDEX IF NOT EXISTS idx_element_category ON element(category_id);
CREATE INDEX IF NOT EXISTS idx_element_type ON element(type);

-- Element tags
CREATE TABLE IF NOT EXISTS element_tag (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(element_id, name)
);
CREATE INDEX IF NOT EXISTS idx_element_tag_element ON element_tag(element_id);
CREATE INDEX IF NOT EXISTS idx_element_tag_name ON element_tag(name);

-- Element stages (evolution across the story)
CREATE TABLE IF NOT EXISTS element_stage (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  start_node_id TEXT,                -- references story_node.id (optional / nullable)
  end_node_id TEXT,                  -- references story_node.id (optional / nullable)
  name TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(element_id, stage_index)
);
CREATE INDEX IF NOT EXISTS idx_element_stage_element ON element_stage(element_id);
CREATE INDEX IF NOT EXISTS idx_element_stage_stage_index ON element_stage(element_id, stage_index);

-- Mapping stages to chapters (span coverage)
CREATE TABLE IF NOT EXISTS chapter_element_stage (
  chapter_id TEXT NOT NULL,
  element_stage_id TEXT NOT NULL,
  PRIMARY KEY(chapter_id, element_stage_id),
  FOREIGN KEY(element_stage_id) REFERENCES element_stage(id) ON DELETE CASCADE
);

-- Element occurrence inside text blocks
CREATE TABLE IF NOT EXISTS element_occurrence (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  node_id TEXT NOT NULL,             -- story node id
  block_id TEXT NOT NULL,            -- text block id
  spans_json TEXT NOT NULL,          -- serialized spans / ranges
  created_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_element ON element_occurrence(element_id);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_node ON element_occurrence(node_id);

-- Seed default categories (id generated at runtime if not present); name uniqueness prevents duplication
-- INSERT OR IGNORE INTO element_category (id, name, description_json, color) VALUES (...)
`;



export const DEFAULT_PROJECT: Project = {
  id: 'project_mock_1',
  name: 'My First Story',
  author: 'Author Name',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

export const DEFAULT_ELEMENT_CATEGORY: ElementCategoryRecord = {
  id: 'cat_default',
  name: 'others',
  description_json: JSON.stringify({ description: 'Default category' }),
  color: '#CCCCCC',
};

export const MOCK_ELEMENT_CATEGORIES: ElementCategoryRecord[] = [
  {
    id: 'cat_character',
    name: 'character',
    description_json: JSON.stringify({ description: 'Characters / actors' }),
    color: '#FF6B6B',
  },
  {
    id: 'cat_location',
    name: 'location',
    description_json: JSON.stringify({ description: 'Locations / places' }),
    color: '#4ECDC4',
  },
  {
    id: 'cat_object',
    name: 'object',
    description_json: JSON.stringify({ description: 'Important objects / items' }),
    color: '#FFD93D',
  },
  {
    id: 'cat_faction',
    name: 'faction',
    description_json: JSON.stringify({ description: 'Groups / organizations' }),
    color: '#1A535C',
  },
  {
    id: 'cat_concept',
    name: 'concept',
    description_json: JSON.stringify({ description: 'Abstract concepts / phenomena' }),
    color: '#9368B7',
  },
];

export const MOCK_ELEMENTS: ElementRecord[] = [
  {
    id: 'element_mock_1',
    project_id: 'project_mock_1',
    category_id: 'cat_character',
    type: 'character',
    name: 'Aria Thorn',
    content_json: JSON.stringify({}),
    summary_json: 'Central protagonist seeking the lost citadel.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'element_mock_2',
    project_id: 'project_mock_1',
    category_id: 'cat_location',
    type: 'location',
    name: 'Elder Oakspire',
    content_json: JSON.stringify({}),
    summary_json: 'A sentient tree holding fragmented memories of the realm.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'element_mock_3',
    project_id: 'project_mock_1',
    category_id: 'cat_object',
    type: 'object',
    name: 'Shard Compass',
    content_json: JSON.stringify({}),
    summary_json: 'An artifact that points toward emotional fractures in reality.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'element_mock_4',
    project_id: 'project_mock_1',
    category_id: 'cat_faction',
    type: 'faction',
    name: 'Order of the Veil',
    content_json: JSON.stringify({}),
    summary_json: 'A clandestine faction guarding forbidden chronomancy.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'element_mock_5',
    project_id: 'project_mock_1',
    category_id: 'cat_concept',
    type: 'concept',
    name: 'Echo Convergence',
    content_json: JSON.stringify({}),
    summary_json: 'A periodic phenomenon where timelines partially overlap.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];
