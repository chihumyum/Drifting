import type { Project } from "./book_general";
import type { ElementRecord, ElementCategoryRecord } from "./book_element";
import type { StoryThreadRecord } from "./story_thread";
import type { BookNodeRecord } from "./book_node";



export const TABLES = {
  project: 'project',
  storyNode: 'story_node',
  nodeEdge: 'node_edge',
  bookContent: 'book_content',
  element: 'element',
  elementStage: 'element_stage',
  storyThread: 'story_thread',
  nodeThread: 'node_thread',
} as const


export const DB_SCHEMA = `
-- =============================
-- Book Element / Element Schema
-- =============================
-- Projects table
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  project_name TEXT,
  author TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_name ON project(project_name);

-- Category table (element categories)
CREATE TABLE IF NOT EXISTS element_category (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  color TEXT NULL
);
-- Create story nodes (chapter/scene/beat)
CREATE TABLE IF NOT EXISTS story_node (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,               -- chapter/scene/beat
  order_key INTEGER NOT NULL,
  status TEXT NOT NULL,             -- draft/in_progress/complete/archived
  summary TEXT,
  pos_x REAL,
  pos_y REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id) REFERENCES story_node(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_story_node_project ON story_node(project_id);
CREATE INDEX IF NOT EXISTS idx_story_node_parent ON story_node(parent_id);
CREATE INDEX IF NOT EXISTS idx_story_node_type ON story_node(type);
CREATE INDEX IF NOT EXISTS idx_story_node_order ON story_node(project_id, order_key);

-- Story threads (narrative threads/storylines)
CREATE TABLE IF NOT EXISTS story_thread (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  summary TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,  -- 0 or 1, only one main thread per project
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_thread_project ON story_thread(project_id);
CREATE INDEX IF NOT EXISTS idx_story_thread_main ON story_thread(project_id, is_main);

-- Node to thread relationship (many-to-many)
CREATE TABLE IF NOT EXISTS node_thread (
  node_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY(node_id, thread_id),
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(thread_id) REFERENCES story_thread(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_node_thread_node ON node_thread(node_id);
CREATE INDEX IF NOT EXISTS idx_node_thread_thread ON node_thread(thread_id);

-- Edges between nodes 
CREATE TABLE IF NOT EXISTS node_edge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  src_node_id TEXT NOT NULL,
  dst_node_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- chronology/causality/reference/foreshadow
  label TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, 
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_node_edge_project ON node_edge(project_id);
CREATE INDEX IF NOT EXISTS idx_node_edge_src ON node_edge(src_node_id);
CREATE INDEX IF NOT EXISTS idx_node_edge_dst ON node_edge(dst_node_id);

-- Book content table 
CREATE TABLE IF NOT EXISTS book_content (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  pm_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_content_node ON book_content(node_id);

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

-- Element to story node links (many-to-many)
CREATE TABLE IF NOT EXISTS element_node_link (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(node_id, element_id)
);
CREATE INDEX IF NOT EXISTS idx_element_node_link_node ON element_node_link(node_id);
CREATE INDEX IF NOT EXISTS idx_element_node_link_element ON element_node_link(element_id);

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
  id: 'default-project',
  project_name: 'Default Project',
  author: 'Author Name',
  description: 'This is your default project. You can create more projects later.',
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
    project_id: 'default-project',
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
    project_id: 'default-project',
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
    project_id: 'default-project',
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
    project_id: 'default-project',
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
    project_id: 'default-project',
    category_id: 'cat_concept',
    type: 'concept',
    name: 'Echo Convergence',
    content_json: JSON.stringify({}),
    summary_json: 'A periodic phenomenon where timelines partially overlap.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// Default main story thread
export const DEFAULT_STORY_THREAD: StoryThreadRecord = {
  id: 'thread_main',
  project_id: 'default-project',
  name: 'Main Story',
  color: '#3B82F6',
  summary: 'Main storyline',
  is_main: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Mock story threads
export const MOCK_STORY_THREADS: StoryThreadRecord[] = [
  {
    id: 'thread_john',
    project_id: 'default-project',
    name: 'John',
    color: '#60A5FA', // Light blue
    summary: "John's storyline",
    is_main: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'thread_emma',
    project_id: 'default-project',
    name: 'Emma',
    color: '#FDE047', // Yellow
    summary: "Emma's storyline",
    is_main: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'thread_vera',
    project_id: 'default-project',
    name: 'Vera',
    color: '#C084FC', // Purple
    summary: "Vera's storyline",
    is_main: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// Mock chapters
export const MOCK_CHAPTERS: BookNodeRecord[] = [
  {
    id: 'chapter_001',
    parent_id: null,
    title: '序章',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 1,
    status: 'draft',
    summary: '故事的开端，介绍世界观和主要角色',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_002',
    parent_id: null,
    title: '第一章：John',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 2,
    status: 'draft',
    summary: 'John在城市中的日常生活',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_003',
    parent_id: null,
    title: '第二章：Emma',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 3,
    status: 'draft',
    summary: 'Emma的背景故事',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_004',
    parent_id: null,
    title: '第三章：Vera',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 4,
    status: 'draft',
    summary: 'Vera的神秘过去',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_005',
    parent_id: null,
    title: '第四章：John',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 5,
    status: 'draft',
    summary: 'John遇到了第一个挑战',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_006',
    parent_id: null,
    title: '第五章：Emma',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 6,
    status: 'draft',
    summary: 'Emma的决定',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_007',
    parent_id: null,
    title: '第六章：Vera',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 7,
    status: 'draft',
    summary: 'Vera的秘密被揭露',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_008',
    parent_id: null,
    title: '第七章：Emma',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 8,
    status: 'draft',
    summary: 'Emma与Vera的相遇',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_009',
    parent_id: null,
    title: '第九章：所有人',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 9,
    status: 'draft',
    summary: '三条故事线汇聚',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_010',
    parent_id: null,
    title: '第十章：John',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 10,
    status: 'draft',
    summary: 'John做出了艰难的选择',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_011',
    parent_id: null,
    title: '第十一章：Emma',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 11,
    status: 'draft',
    summary: 'Emma的牺牲',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_012',
    parent_id: null,
    title: '第十二章：John & Emma',
    project_id: 'default-project',
    type: 'chapter',
    order_key: 12,
    status: 'draft',
    summary: 'John和Emma的最终对决',
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// Mock node-thread relationships
export const MOCK_NODE_THREADS = [
  // 序章 - 主线
  { node_id: 'chapter_001', thread_id: 'thread_main' },
  
  // 第一章 - John线
  { node_id: 'chapter_002', thread_id: 'thread_main' },
  { node_id: 'chapter_002', thread_id: 'thread_john' },
  
  // 第二章 - Emma线
  { node_id: 'chapter_003', thread_id: 'thread_main' },
  { node_id: 'chapter_003', thread_id: 'thread_emma' },
  
  // 第三章 - Vera线
  { node_id: 'chapter_004', thread_id: 'thread_main' },
  { node_id: 'chapter_004', thread_id: 'thread_vera' },
  
  // 第四章 - John线
  { node_id: 'chapter_005', thread_id: 'thread_john' },
  
  // 第五章 - Emma线
  { node_id: 'chapter_006', thread_id: 'thread_emma' },
  
  // 第六章 - Vera线
  { node_id: 'chapter_007', thread_id: 'thread_vera' },
  
  // 第七章 - Emma和Vera
  { node_id: 'chapter_008', thread_id: 'thread_emma' },
  { node_id: 'chapter_008', thread_id: 'thread_vera' },
  
  // 第九章 - 所有人
  { node_id: 'chapter_009', thread_id: 'thread_main' },
  { node_id: 'chapter_009', thread_id: 'thread_john' },
  { node_id: 'chapter_009', thread_id: 'thread_emma' },
  { node_id: 'chapter_009', thread_id: 'thread_vera' },
  
  // 第十章 - John线
  { node_id: 'chapter_010', thread_id: 'thread_john' },
  
  // 第十一章 - Emma线
  { node_id: 'chapter_011', thread_id: 'thread_emma' },
  
  // 第十二章 - John和Emma
  { node_id: 'chapter_012', thread_id: 'thread_main' },
  { node_id: 'chapter_012', thread_id: 'thread_john' },
  { node_id: 'chapter_012', thread_id: 'thread_emma' },
];
