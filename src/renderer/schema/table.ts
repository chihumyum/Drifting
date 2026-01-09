import type { Project } from "./book_general";
import type { ElementRecord, ElementCategoryRecord } from "./book_element";
import type { StorylineRecord } from "./storyline";



export const TABLES = {
  project: 'project',
  storyStage: 'story_stage',
  storyNode: 'story_node',
  nodeTag: 'node_tag',
  nodeTagLink: 'node_tag_link',
  nodeEdge: 'node_edge',
  bookContent: 'book_content',
  element: 'element',
  elementCategory: 'element_category',
  projectElementCategory: 'project_element_category',
  elementStage: 'element_stage',
  storyline: 'storyline',
  nodeStoryline: 'node_storyline',
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
-- Now global/shared across projects, linked via project_element_category
CREATE TABLE IF NOT EXISTS element_category (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  color TEXT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_element_category_name ON element_category(name);

-- Project to Element Category relationship (many-to-many)
CREATE TABLE IF NOT EXISTS project_element_category (
  project_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, category_id),
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY(category_id) REFERENCES element_category(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_element_category_project ON project_element_category(project_id);
CREATE INDEX IF NOT EXISTS idx_project_element_category_category ON project_element_category(category_id);

-- Story stages (higher level than nodes/chapters)
CREATE TABLE IF NOT EXISTS story_stage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  order_key INTEGER NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_stage_project ON story_stage(project_id);
CREATE INDEX IF NOT EXISTS idx_story_stage_order ON story_stage(project_id, order_key);

-- Node tags (user-defined tags for categorizing nodes)
CREATE TABLE IF NOT EXISTS node_tag (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_node_tag_project ON node_tag(project_id);

-- Node-tag link (many-to-many)
CREATE TABLE IF NOT EXISTS node_tag_link (
  node_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(node_id, tag_id),
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES node_tag(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_node_tag_link_node ON node_tag_link(node_id);
CREATE INDEX IF NOT EXISTS idx_node_tag_link_tag ON node_tag_link(tag_id);

-- Story nodes (chapters/nodes - basic writing units)
CREATE TABLE IF NOT EXISTS story_node (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  start INTEGER NOT NULL,           -- Position on timeline (chapter order / story time start)
  end INTEGER,                       -- Timeline end position (null = use default width)
  summary TEXT,
  story_stage_id TEXT,              -- FK to story_stage (nullable)
  pos_x REAL,
  pos_y REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 同步字段
  sync_status TEXT NOT NULL DEFAULT 'synced',  -- 'synced' | 'pending' | 'syncing' | 'failed'
  last_modified INTEGER,                       -- 最后修改时间戳（用于冲突解决）
  is_deleted INTEGER NOT NULL DEFAULT 0,       -- 软删除标记（0=未删除, 1=已删除）
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY(story_stage_id) REFERENCES story_stage(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_story_node_project ON story_node(project_id);
CREATE INDEX IF NOT EXISTS idx_story_node_stage ON story_node(story_stage_id);
CREATE INDEX IF NOT EXISTS idx_story_node_timeline ON story_node(project_id, start, end);
CREATE INDEX IF NOT EXISTS idx_story_node_sync ON story_node(sync_status) WHERE is_deleted = 0;

-- Story threads (narrative threads/storylines)
CREATE TABLE IF NOT EXISTS story_thread (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  summary TEXT,
  pm_json TEXT,  -- ProseMirror document JSON for storyline description/notes
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 同步字段
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_thread_project ON story_thread(project_id);
CREATE INDEX IF NOT EXISTS idx_story_thread_sync ON story_thread(sync_status) WHERE is_deleted = 0;

-- Node to storyline relationship (many-to-many)
CREATE TABLE IF NOT EXISTS node_thread (
  node_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  thread_order INTEGER NOT NULL DEFAULT 0,  -- Determines node's primary storyline (0 = primary)
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
  project_id TEXT NOT NULL,
  pm_json TEXT NOT NULL DEFAULT '{}',
  outline_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 同步字段
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_content_node ON book_content(node_id);
CREATE INDEX IF NOT EXISTS idx_book_content_project ON book_content(project_id);
CREATE INDEX IF NOT EXISTS idx_book_content_sync ON book_content(sync_status) WHERE is_deleted = 0;

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
  -- 同步字段
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(category_id) REFERENCES element_category(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_element_project ON element(project_id);
CREATE INDEX IF NOT EXISTS idx_element_category ON element(category_id);
CREATE INDEX IF NOT EXISTS idx_element_sync ON element(sync_status) WHERE is_deleted = 0;
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
  project_id TEXT NOT NULL,          -- denormalized for performance
  block_id TEXT NOT NULL,            -- text block id
  spans_json TEXT NOT NULL,          -- serialized spans / ranges
  created_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_element ON element_occurrence(element_id);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_node ON element_occurrence(node_id);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_project ON element_occurrence(project
);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_element ON element_occurrence(element_id);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_node ON element_occurrence(node_id);

-- =============================
-- 同步队列表 (Sync Queue)
-- =============================
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                      -- 'create' | 'update' | 'delete'
  entity TEXT NOT NULL,                    -- 'node' | 'storyline' | 'element' | etc.
  local_id TEXT NOT NULL,                  -- 本地实体的 ID
  project_id TEXT,                         -- 关联的项目 ID（可选）
  data TEXT,                               -- JSON 序列化的数据
  priority TEXT NOT NULL,                  -- 'high' | 'normal' | 'low'
  retry_count INTEGER NOT NULL DEFAULT 0,  -- 重试次数
  max_retries INTEGER NOT NULL DEFAULT 3,  -- 最大重试次数
  status TEXT NOT NULL,                    -- 'pending' | 'syncing' | 'completed' | 'failed'
  error TEXT,                              -- 错误信息
  created_at INTEGER NOT NULL,             -- 创建时间戳
  updated_at INTEGER NOT NULL              -- 更新时间戳
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_priority ON sync_queue(priority, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity, local_id);

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



// Default main storyline
export const DEFAULT_STORYLINE: StorylineRecord = {
  id: 'storyline_main',
  project_id: 'default-project',
  name: 'Main Story',
  color: '#3B82F6',
  summary: 'Main storyline',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
