import type { Project } from "./book_general";
import type { ElementRecord, ElementCategoryRecord } from "./book_element";



export const TABLES = {
  project: 'project',
  storyNode: 'story_node',
  nodeEdge: 'node_edge',
  nodeBlock: 'node_block',
  entity: 'entity',
  entityStage: 'entity_stage',
} as const


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
    pos_x REAL,
    pos_y REAL,
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

  CREATE TABLE IF NOT EXISTS entity (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    canonical_summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_entity_project_type ON entity(project_id, type);
  CREATE INDEX IF NOT EXISTS idx_entity_name ON entity(name);

  CREATE TABLE IF NOT EXISTS entity_stage (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    start_order REAL NOT NULL,
    end_order REAL NOT NULL,
    attributes_patch_json TEXT NOT NULL DEFAULT '{}',
    stage_summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_entity_stage_entity_order ON entity_stage(entity_id, start_order, end_order);

  CREATE TABLE IF NOT EXISTS entity_appearance (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    block_id TEXT NOT NULL REFERENCES node_block(id) ON DELETE CASCADE,
    spans_json TEXT NOT NULL DEFAULT '[]',
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_entity_appearance_entity ON entity_appearance(entity_id);
  CREATE INDEX IF NOT EXISTS idx_entity_appearance_node ON entity_appearance(node_id);
  CREATE INDEX IF NOT EXISTS idx_entity_appearance_block ON entity_appearance(block_id);

  CREATE TABLE IF NOT EXISTS node_entity_link (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES story_node(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('protagonist', 'antagonist', 'supporting', 'mention', 'mentioned', 'present')),
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_node_entity_link_node ON node_entity_link(node_id);
  CREATE INDEX IF NOT EXISTS idx_node_entity_link_entity ON node_entity_link(entity_id);

  CREATE TABLE IF NOT EXISTS entity_category (
    name TEXT PRIMARY KEY,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Tags and entity-tag association
  CREATE TABLE IF NOT EXISTS tag (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS entity_tag (
    entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL REFERENCES tag(name) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_id, tag_name)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_tag_tag ON entity_tag(tag_name);

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



export const DEFAULT_PROJECT: Project = {
  id: 'project_mock_1',
  name: 'My First Story',
  author: 'Author Name',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

export const DEFAULT_ENTITY_CATEGORY: ElementCategoryRecord = {
  name: 'others',
  color: '#CCCCCC',
  created_at: new Date().toISOString(),
}

export const MOCK_ENTITY_CATEGORIES: ElementCategoryRecord[] = [
  {
    name: 'character',
    color: '#FF6B6B',
    created_at: new Date().toISOString(),
  },
  {
    name: 'location',
    color: '#4ECDC4',
    created_at: new Date().toISOString(),
  },
  {
    name: 'object',
    color: '#FFD93D',
    created_at: new Date().toISOString(),
  },
  {
    name: 'faction',
    color: '#1A535C',
    created_at: new Date().toISOString(),
  },
  {
    name: 'concept',
    color: '#9368B7',
    created_at: new Date().toISOString(),
  },
];
export const MOCK_ENTITIES: ElementRecord[] = [
  {
    id: 'entity_mock_1',
    project_id: 'project_mock_1',
    type: 'character',
    name: 'Aria Thorn',
    aliases_json: JSON.stringify(['The Wanderer', 'AT']),
    attributes_json: JSON.stringify({ role: 'protagonist', temperament: 'curious', age: 19 }),
    canonical_summary: 'Central protagonist seeking the lost citadel.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_2',
    project_id: 'project_mock_1',
    type: 'location',
    name: 'Elder Oakspire',
    aliases_json: JSON.stringify(['The Whispering Tree']),
    attributes_json: JSON.stringify({ type: 'ancient_tree', region: 'Northwood', mystical: true }),
    canonical_summary: 'A sentient tree holding fragmented memories of the realm.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_3',
    project_id: 'project_mock_1',
    type: 'object',
    name: 'Shard Compass',
    aliases_json: JSON.stringify(['Fractured Navigator']),
    attributes_json: JSON.stringify({ material: 'obsidian + silver', attuned: true }),
    canonical_summary: 'An artifact that points toward emotional fractures in reality.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_4',
    project_id: 'project_mock_1',
    type: 'faction',
    name: 'Order of the Veil',
    aliases_json: JSON.stringify(['Veilkeepers']),
    attributes_json: JSON.stringify({ influence: 'regional', secrecy_level: 8 }),
    canonical_summary: 'A clandestine faction guarding forbidden chronomancy.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_5',
    project_id: 'project_mock_1',
    type: 'concept',
    name: 'Echo Convergence',
    aliases_json: JSON.stringify(['Resonance Event']),
    attributes_json: JSON.stringify({ cycle: 'once / century', stability: 'volatile' }),
    canonical_summary: 'A periodic phenomenon where timelines partially overlap.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];
