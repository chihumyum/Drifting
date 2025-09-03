export const TABLES = {
  project: 'project',
  storyNode: 'story_node',
  nodeEdge: 'node_edge',
  nodeBlock: 'node_block',
  entry: 'entry',
  entryStage: 'entry_stage',
  entryAppearance: 'entry_appearance',
  nodeEntryLink: 'node_entry_link',
} as const

export type NodeType = 'chapter' | 'scene' | 'beat';
export type NodeStatus = 'draft' | 'in_progress' | 'complete' | 'archived';
export type EdgeKind = 'chronology' | 'causality' | 'reference' | 'foreshadow';
export type EntryType = 'character' | 'location' | 'object' | 'faction' | 'concept';
export type EntryRole = 'protagonist' | 'antagonist' | 'supporting' | 'mentioned' | 'present';

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface StoryNode {
  id: string;
  project_id: string;
  type: NodeType;
  title: string;
  order_key: number;
  summary?: string;
  status: NodeStatus;
  created_at: string;
  updated_at: string;
}

export interface NodeEdge {
  id: string;
  project_id: string;
  src_node_id: string;
  dst_node_id: string;
  kind: EdgeKind;
  label?: string;
  weight: number;
  created_at: string;
}

export interface NodeBlock {
  id: string;
  node_id: string;
  order_index: number;
  pm_json: string;
  plain_text: string;
  created_at: string;
  updated_at: string;
}

export interface Entry {
  id: string;
  project_id: string;
  type: EntryType;
  name: string;
  aliases_json: string;
  attributes_json: string;
  canonical_summary?: string;
  created_at: string;
  updated_at: string;
}

export interface EntryStage {
  id: string;
  entry_id: string;
  start_order: number;
  end_order: number;
  attributes_patch_json: string;
  stage_summary?: string;
  created_at: string;
}

export interface EntryAppearance {
  id: string;
  entry_id: string;
  node_id: string;
  block_id: string;
  spans_json: string;
  count: number;
  created_at: string;
}

export interface NodeEntryLink {
  id: string;
  node_id: string;
  entry_id: string;
  role: EntryRole;
  weight: number;
  created_at: string;
}

export const DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS story_node (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('chapter', 'scene', 'beat')),
    title TEXT NOT NULL,
    order_key REAL NOT NULL,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'complete', 'archived')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_story_node_project_order ON story_node(project_id, order_key);
  CREATE INDEX IF NOT EXISTS idx_story_node_type ON story_node(type);

  CREATE TABLE IF NOT EXISTS node_edge (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    src_node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    dst_node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('chronology', 'causality', 'reference', 'foreshadow')),
    label TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_node_edge_src ON node_edge(src_node_id);
  CREATE INDEX IF NOT EXISTS idx_node_edge_dst ON node_edge(dst_node_id);
  CREATE INDEX IF NOT EXISTS idx_node_edge_kind ON node_edge(kind);

  CREATE TABLE IF NOT EXISTS node_block (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    pm_json TEXT NOT NULL,
    plain_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_node_block_node_order ON node_block(node_id, order_index);

  CREATE TABLE IF NOT EXISTS entry (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('character', 'location', 'object', 'faction', 'concept')),
    name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    canonical_summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_entry_project_type ON entry(project_id, type);
  CREATE INDEX IF NOT EXISTS idx_entry_name ON entry(name);

  CREATE TABLE IF NOT EXISTS entry_stage (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    start_order REAL NOT NULL,
    end_order REAL NOT NULL,
    attributes_patch_json TEXT NOT NULL DEFAULT '{}',
    stage_summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_entry_stage_entry_order ON entry_stage(entry_id, start_order, end_order);

  CREATE TABLE IF NOT EXISTS entry_appearance (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    block_id TEXT NOT NULL REFERENCES node_block(id) ON DELETE CASCADE,
    spans_json TEXT NOT NULL DEFAULT '[]',
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_entry_appearance_entry ON entry_appearance(entry_id);
  CREATE INDEX IF NOT EXISTS idx_entry_appearance_node ON entry_appearance(node_id);
  CREATE INDEX IF NOT EXISTS idx_entry_appearance_block ON entry_appearance(block_id);

  CREATE TABLE IF NOT EXISTS node_entry_link (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('protagonist', 'antagonist', 'supporting', 'mentioned', 'present')),
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_node_entry_link_node ON node_entry_link(node_id);
  CREATE INDEX IF NOT EXISTS idx_node_entry_link_entry ON node_entry_link(entry_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS fts_block USING fts5(
    node_id,
    block_id,
    content,
    content='node_block',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS fts_block_insert AFTER INSERT ON node_block BEGIN
    INSERT INTO fts_block(node_id, block_id, content) VALUES (new.node_id, new.id, new.plain_text);
  END;

  CREATE TRIGGER IF NOT EXISTS fts_block_update AFTER UPDATE ON node_block BEGIN
    UPDATE fts_block SET content = new.plain_text WHERE block_id = new.id;
  END;

  CREATE TRIGGER IF NOT EXISTS fts_block_delete AFTER DELETE ON node_block BEGIN
    DELETE FROM fts_block WHERE block_id = old.id;
  END;
`;



