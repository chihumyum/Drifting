import { ipcMain, app } from 'electron';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

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

    log.info(`[Database] Opening database: ${dbPath}`);

    db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    // Run migrations
    runMigrations();

    log.info('[Database] Database initialized successfully');
  } catch (error) {
    log.error('[Database] Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Run database migrations - Use the schema from renderer/schema/table.ts
 */
function runMigrations(): void {
  if (!db) return;

  const schemaSql = `
CREATE TABLE IF NOT EXISTS element_categories (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	description_json text DEFAULT '{}',
	color text NOT NULL
);
CREATE TABLE IF NOT EXISTS element_stages (
	id text PRIMARY KEY NOT NULL,
	element_id text NOT NULL,
	order_key integer NOT NULL,
	start_node_id text,
	end_node_id text,
	stage_name text NOT NULL,
	content_json text DEFAULT '{}',
	summary text DEFAULT '',
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (element_id) REFERENCES elements(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS element_tags (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	name text NOT NULL,
	color text,
	created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS element_tags_link (
	element_id text NOT NULL,
	tag_id text NOT NULL,
	created_at text NOT NULL,
	PRIMARY KEY(element_id, tag_id),
	FOREIGN KEY (element_id) REFERENCES elements(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (tag_id) REFERENCES element_tags(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS elements (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	category_id text,
	name text NOT NULL,
	summary text DEFAULT '',
	content_json text DEFAULT '{}',
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (category_id) REFERENCES element_categories(id) ON UPDATE no action ON DELETE set null
);
CREATE TABLE IF NOT EXISTS node_contents (
	id text PRIMARY KEY NOT NULL,
	node_id text NOT NULL,
	project_id text NOT NULL,
	content_json text DEFAULT '{}',
	outline_json text DEFAULT '[]',
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (node_id) REFERENCES story_nodes(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS idx_node_contents_node ON node_contents (node_id);
CREATE TABLE IF NOT EXISTS node_elements_link (
	id text PRIMARY KEY NOT NULL,
	node_id text NOT NULL,
	element_id text NOT NULL,
	FOREIGN KEY (node_id) REFERENCES story_nodes(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (element_id) REFERENCES elements(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS node_storylines (
	node_id text NOT NULL,
	storyline_id text NOT NULL,
	storyline_order integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(node_id, storyline_id),
	FOREIGN KEY (node_id) REFERENCES story_nodes(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (storyline_id) REFERENCES storylines(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS node_tags (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	name text NOT NULL,
	color text,
	created_at text NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS node_tags_link (
	node_id text NOT NULL,
	tag_id text NOT NULL,
	created_at text NOT NULL,
	PRIMARY KEY(node_id, tag_id),
	FOREIGN KEY (node_id) REFERENCES story_nodes(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (tag_id) REFERENCES node_tags(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS projects (
	id text PRIMARY KEY NOT NULL,
	user_id text NOT NULL,
	name text NOT NULL,
	author text NOT NULL,
	description_json text DEFAULT '{}',
	created_at text NOT NULL,
	updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS story_node_edges (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	source_node_id text NOT NULL,
	target_node_id text NOT NULL,
	label text,
	weight integer DEFAULT 1 NOT NULL,
	is_directed integer DEFAULT true NOT NULL,
	style_json text,
	control_point_offset_json text,
	source_anchor_json text,
	target_anchor_json text,
	created_at text NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (source_node_id) REFERENCES story_nodes(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (target_node_id) REFERENCES story_nodes(id) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS story_nodes (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	title text NOT NULL,
	summary text DEFAULT '',
	start integer NOT NULL,
	end integer DEFAULT 0 NOT NULL,
	story_stage_id text,
	position_x real NOT NULL,
	position_y real NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (story_stage_id) REFERENCES story_stages(id) ON UPDATE no action ON DELETE set null
);
CREATE INDEX IF NOT EXISTS idx_story_nodes_project ON story_nodes (project_id);
CREATE INDEX IF NOT EXISTS idx_story_nodes_stage ON story_nodes (story_stage_id);
CREATE TABLE IF NOT EXISTS story_stages (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	name text NOT NULL,
	description_json text DEFAULT '{}',
	order_key integer NOT NULL,
	start_node_id text,
	end_node_id text,
	color text NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS project_element_categories (
	project_id text NOT NULL,
	category_id text NOT NULL,
	created_at text NOT NULL,
	PRIMARY KEY(project_id, category_id),
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (category_id) REFERENCES element_categories(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS storylines (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	name text NOT NULL,
	color text NOT NULL,
	summary text DEFAULT '',
	description_json text DEFAULT '{}',
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
);
`;

  // Execute schema creation
  // We split by semicolon to execute mostly safely, though simple exec handles it usually.
  // Using transaction for safety
  const transaction = db.transaction(() => {
    db!.exec(schemaSql);
  });

  try {
    transaction();
    log.info('[Database] Schema setup completed');
  } catch (e) {
    log.error('[Database] Schema setup failed:', e);
    // Continue anyway as tables might exist
  }

  // Insert default project if not exists
  const now = new Date().toISOString();
  // Using new table name 'projects' and columns
  const defaultProject = db.prepare('SELECT id FROM projects WHERE id = ?').get('default-project');

  if (!defaultProject) {
    log.info('[Database] Creating default project');
    try {
      db.prepare(`
        INSERT INTO projects (id, user_id, name, author, description_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'default-project',
        'default-user', // Default user ID
        'Default Project',
        'Author Name',
        JSON.stringify({ description: 'This is your default project. You can create more projects later.' }),
        now,
        now
      );
    } catch (e) {
      log.error('[Database] Failed to insert default project:', e);
    }
  }

  // Insert default element category if not exists
  const defaultCategory = db.prepare('SELECT id FROM element_categories WHERE id = ?').get('cat_default');

  if (!defaultCategory) {
    log.info('[Database] Creating default element category');
    try {
      db.prepare(`
        INSERT INTO element_categories (id, name, description_json, color)
        VALUES (?, ?, ?, ?)
      `).run(
        'cat_default',
        'others',
        JSON.stringify({ description: 'Default category' }),
        '#CCCCCC'
      );
    } catch (e) {
      log.error('[Database] Failed to insert default category:', e);
    }
  }

  // Insert default storyline if not exists
  const defaultStoryline = db.prepare('SELECT id FROM storylines WHERE id = ?').get('storyline_main');

  if (!defaultStoryline) {
    log.info('[Database] Creating default storyline');
    try {
      db.prepare(`
        INSERT INTO storylines (id, project_id, name, color, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'storyline_main',
        'default-project',
        'Main Story',
        '#3B82F6',
        'Main storyline',
        now,
        now
      );
    } catch (e) {
      log.error('[Database] Failed to insert default storyline:', e);
    }
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
      log.error('[Database] Run error:', error);
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
      log.error('[Database] Query error:', error);
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
      log.error('[Database] Get error:', error);
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
