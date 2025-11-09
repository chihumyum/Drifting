import type { Project, NodeTagRecord, NodeTagLinkRecord } from "./book_general";
import type { ElementRecord, ElementCategoryRecord } from "./book_element";
import type { StoryThreadRecord } from "./story_thread";
import type { BookNodeRecord } from "./book_node";
import type { BookContentRecord } from "./book_content";



export const TABLES = {
  project: 'project',
  storyStage: 'story_stage',
  storyNode: 'story_node',
  nodeTag: 'node_tag',
  nodeTagLink: 'node_tag_link',
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
  color TEXT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

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
  pm_json TEXT,  -- ProseMirror document JSON for thread description/notes
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

-- Node to thread relationship (many-to-many)
CREATE TABLE IF NOT EXISTS node_thread (
  node_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  thread_order INTEGER NOT NULL DEFAULT 0,  -- Determines node's primary thread (0 = primary)
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
  outline_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 同步字段
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_content_node ON book_content(node_id);
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

-- =============================
-- 同步队列表 (Sync Queue)
-- =============================
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                      -- 'create' | 'update' | 'delete'
  entity TEXT NOT NULL,                    -- 'node' | 'thread' | 'element' | etc.
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'thread_emma',
    project_id: 'default-project',
    name: 'Emma',
    color: '#FDE047', // Yellow
    summary: "Emma's storyline",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'thread_vera',
    project_id: 'default-project',
    name: 'Vera',
    color: '#C084FC', // Purple
    summary: "Vera's storyline",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// Mock chapters
export const MOCK_CHAPTERS: BookNodeRecord[] = [
  {
    id: 'chapter_001',
    title: '序章',
    project_id: 'default-project',
    start: 1,
    end: 8,
    summary: '故事的开端，介绍世界观和主要角色',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
    last_modified: Date.now(),
    is_deleted: 0,
  },
  {
    id: 'chapter_002',
    title: '第一章：John',
    project_id: 'default-project',
    start: 10,
    end: 16,
    summary: 'John在城市中的日常生活',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_003',
    title: '第二章：Emma',
    project_id: 'default-project',
    start: 12,
    end: 19,
    summary: 'Emma的背景故事',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_004',
    title: '第三章：Vera',
    project_id: 'default-project',
    start: 15,
    end: 22,
    summary: 'Vera的神秘过去',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_005',
    title: '第四章：John',
    project_id: 'default-project',
    start: 25,
    end: 30,
    summary: 'John遇到了第一个挑战',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_006',
    title: '第五章：Emma',
    project_id: 'default-project',
    start: 28,
    end: 35,
    summary: 'Emma的决定',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_007',
    title: '第六章：Vera',
    project_id: 'default-project',
    start: 32,
    end: 38,
    summary: 'Vera的秘密被揭露',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_008',
    title: '第七章：Emma',
    project_id: 'default-project',
    start: 40,
    end: 47,
    summary: 'Emma与Vera的相遇',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_009',
    title: '第九章：所有人',
    project_id: 'default-project',
    start: 50,
    end: 58,
    summary: '三条故事线汇聚',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_010',
    title: '第十章：John',
    project_id: 'default-project',
    start: 60,
    end: 66,
    summary: 'John做出了艰难的选择',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_011',
    title: '第十一章：Emma',
    project_id: 'default-project',
    start: 68,
    end: 75,
    summary: 'Emma的牺牲',
    story_stage_id: null,
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'chapter_012',
    title: '第十二章：John & Emma',
    project_id: 'default-project',
    start: 78,
    end: 86,
    summary: 'John和Emma的最终对决',
    story_stage_id: null,
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

// Mock node tags
export const MOCK_NODE_TAGS: NodeTagRecord[] = [
  {
    id: 'tag_action',
    project_id: 'default-project',
    name: '动作',
    color: '#EF4444',
    created_at: new Date().toISOString(),
  },
  {
    id: 'tag_dialogue',
    project_id: 'default-project',
    name: '对话',
    color: '#3B82F6',
    created_at: new Date().toISOString(),
  },
  {
    id: 'tag_flashback',
    project_id: 'default-project',
    name: '回忆',
    color: '#8B5CF6',
    created_at: new Date().toISOString(),
  },
  {
    id: 'tag_climax',
    project_id: 'default-project',
    name: '高潮',
    color: '#F59E0B',
    created_at: new Date().toISOString(),
  },
  {
    id: 'tag_resolution',
    project_id: 'default-project',
    name: '结局',
    color: '#10B981',
    created_at: new Date().toISOString(),
  },
];

// Mock node-tag relationships
export const MOCK_NODE_TAG_LINKS: NodeTagLinkRecord[] = [
  // chapter_001 - 对话
  { node_id: 'chapter_001', tag_id: 'tag_dialogue', created_at: new Date().toISOString() },
  
  // chapter_002 - 对话
  { node_id: 'chapter_002', tag_id: 'tag_dialogue', created_at: new Date().toISOString() },
  
  // chapter_003 - 对话, 回忆
  { node_id: 'chapter_003', tag_id: 'tag_dialogue', created_at: new Date().toISOString() },
  { node_id: 'chapter_003', tag_id: 'tag_flashback', created_at: new Date().toISOString() },
  
  // chapter_004 - 回忆
  { node_id: 'chapter_004', tag_id: 'tag_flashback', created_at: new Date().toISOString() },
  
  // chapter_005 - 动作
  { node_id: 'chapter_005', tag_id: 'tag_action', created_at: new Date().toISOString() },
  
  // chapter_007 - 对话, 动作
  { node_id: 'chapter_007', tag_id: 'tag_dialogue', created_at: new Date().toISOString() },
  { node_id: 'chapter_007', tag_id: 'tag_action', created_at: new Date().toISOString() },
  
  // chapter_009 - 高潮
  { node_id: 'chapter_009', tag_id: 'tag_climax', created_at: new Date().toISOString() },
  
  // chapter_010 - 动作, 高潮
  { node_id: 'chapter_010', tag_id: 'tag_action', created_at: new Date().toISOString() },
  { node_id: 'chapter_010', tag_id: 'tag_climax', created_at: new Date().toISOString() },
  
  // chapter_012 - 高潮, 结局
  { node_id: 'chapter_012', tag_id: 'tag_climax', created_at: new Date().toISOString() },
  { node_id: 'chapter_012', tag_id: 'tag_resolution', created_at: new Date().toISOString() },
];

// Mock book contents (for half of the chapters)
export const MOCK_BOOK_CONTENTS: BookContentRecord[] = [
  {
    id: 'content_001',
    node_id: 'chapter_001',
    pm_json: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '序章' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '这是故事的开端...' }],
        },
      ],
    }),
    outline_json: JSON.stringify([
      { id: 'outline_001_0', level: 1, text: '序章', position: 0 }
    ]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'content_002',
    node_id: 'chapter_002',
    pm_json: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '初遇' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'John在城市中漫步...' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '咖啡店' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '他走进一家咖啡店...' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '对话' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '陌生人主动搭讪...' }],
        },
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '离开' }],
        },
      ],
    }),
    outline_json: JSON.stringify([
      { id: 'outline_002_0', level: 1, text: '初遇', position: 0 },
      { id: 'outline_002_1', level: 2, text: '咖啡店', position: 1 },
      { id: 'outline_002_2', level: 2, text: '对话', position: 2 },
      { id: 'outline_002_3', level: 1, text: '离开', position: 3 }
    ]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'content_004',
    node_id: 'chapter_004',
    pm_json: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Vera回忆起过去的片段...' }],
        },
      ],
    }),
    outline_json: JSON.stringify([]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'content_006',
    node_id: 'chapter_006',
    pm_json: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '决定' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Emma做出了重要的决定...' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '考虑' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '她权衡利弊...' }],
        },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: '家人' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '家人的意见...' }],
        },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: '事业' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '事业的考量...' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '行动' }],
        },
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '新的开始' }],
        },
      ],
    }),
    outline_json: JSON.stringify([
      { id: 'outline_006_0', level: 1, text: '决定', position: 0 },
      { id: 'outline_006_1', level: 2, text: '考虑', position: 1 },
      { id: 'outline_006_2', level: 3, text: '家人', position: 2 },
      { id: 'outline_006_3', level: 3, text: '事业', position: 3 },
      { id: 'outline_006_4', level: 2, text: '行动', position: 4 },
      { id: 'outline_006_5', level: 1, text: '新的开始', position: 5 }
    ]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'content_008',
    node_id: 'chapter_008',
    pm_json: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '相遇' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Emma与Vera的相遇改变了一切...' }],
        },
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '对话' }],
        },
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: '告别' }],
        },
      ],
    }),
    outline_json: JSON.stringify([
      { id: 'outline_008_0', level: 1, text: '相遇', position: 0 },
      { id: 'outline_008_1', level: 1, text: '对话', position: 1 },
      { id: 'outline_008_2', level: 1, text: '告别', position: 2 }
    ]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'content_010',
    node_id: 'chapter_010',
    pm_json: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'John面临着艰难的抉择...' }],
        },
      ],
    }),
    outline_json: JSON.stringify([]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

