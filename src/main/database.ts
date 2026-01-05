import { ipcMain, app } from 'electron';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;

/**
 * Get the directory where database files should be stored
 */
function getDbDirectory(): string {
  const userDataPath = app.getPath('userData');
  const dbDir = path.join(userDataPath, 'databases');
  
  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  return dbDir;
}

/**
 * Initialize database with the given name
 */
function initDatabase(dbName: string): void {
  try {
    // Close existing database if any
    if (db) {
      db.close();
      db = null;
    }

    const dbDir = getDbDirectory();
    const dbPath = path.join(dbDir, dbName);
    
    console.log(`[Database] Opening database: ${dbPath}`);
    
    db = new Database(dbPath);
    
    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');
    
    // Run migrations
    runMigrations();
    
    console.log('[Database] Database initialized successfully');
  } catch (error) {
    console.error('[Database] Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Run database migrations - Use the schema from renderer/schema/table.ts
 */
function runMigrations(): void {
  if (!db) return;

  // Import the schema from renderer side
  db.exec(`
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
  start INTEGER NOT NULL,
  end INTEGER,
  summary TEXT,
  story_stage_id TEXT,
  pos_x REAL,
  pos_y REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
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
  pm_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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
  thread_order INTEGER NOT NULL DEFAULT 0,
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
  kind TEXT NOT NULL,
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
  category_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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
  start_node_id TEXT,
  end_node_id TEXT,
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

-- Element occurrence inside text blocks (for auto-linking)
CREATE TABLE IF NOT EXISTS element_occurrence (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  spans_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_element ON element_occurrence(element_id);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_node ON element_occurrence(node_id);
  `);

  // Insert default project if not exists
  const now = new Date().toISOString();
  const defaultProject = db.prepare('SELECT id FROM project WHERE id = ?').get('default-project');
  
  if (!defaultProject) {
    console.log('[Database] Creating default project');
    db.prepare(`
      INSERT INTO project (id, project_name, author, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'default-project',
      'Default Project',
      'Author Name',
      'This is your default project. You can create more projects later.',
      now,
      now
    );
  }

  // Insert default element category if not exists
  const defaultCategory = db.prepare('SELECT id FROM element_category WHERE id = ?').get('cat_default');
  
  if (!defaultCategory) {
    console.log('[Database] Creating default element category');
    db.prepare(`
      INSERT INTO element_category (id, name, description_json, color, sync_status, last_modified, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'cat_default',
      'others',
      JSON.stringify({ description: 'Default category' }),
      '#CCCCCC',
      'synced',
      Date.now(),
      0
    );
  }

  // Insert default story thread if not exists
  const defaultThread = db.prepare('SELECT id FROM story_thread WHERE id = ?').get('thread_main');
  
  if (!defaultThread) {
    console.log('[Database] Creating default story thread');
    db.prepare(`
      INSERT INTO story_thread (id, project_id, name, color, summary, created_at, updated_at, sync_status, last_modified, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'thread_main',
      'default-project',
      'Main Story',
      '#3B82F6',
      'Main storyline',
      now,
      now,
      'synced',
      Date.now(),
      0
    );
  }
}

/**
 * Setup IPC handlers for database operations
 */
export function setupDatabase(): void {
  // Initialize database
  ipcMain.handle('db:init', async (_event, dbName: string) => {
    initDatabase(dbName);
  });

  // Run a query (INSERT, UPDATE, DELETE)
  ipcMain.handle('db:run', async (_event, sql: string, params?: any[]) => {
    if (!db) throw new Error('Database not initialized');
    
    try {
      const stmt = db.prepare(sql);
      const result = stmt.run(...(params || []));
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    } catch (error) {
      console.error('[Database] Run error:', error);
      throw error;
    }
  });

  // Execute a query and return all rows
  ipcMain.handle('db:query', async (_event, sql: string, params?: any[]) => {
    if (!db) throw new Error('Database not initialized');
    
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...(params || []));
    } catch (error) {
      console.error('[Database] Query error:', error);
      throw error;
    }
  });

  // Execute a query and return first row
  ipcMain.handle('db:get', async (_event, sql: string, params?: any[]) => {
    if (!db) throw new Error('Database not initialized');
    
    try {
      const stmt = db.prepare(sql);
      return stmt.get(...(params || []));
    } catch (error) {
      console.error('[Database] Get error:', error);
      throw error;
    }
  });

  // Close database
  ipcMain.handle('db:close', async () => {
    if (db) {
      db.close();
      db = null;
    }
  });
}
