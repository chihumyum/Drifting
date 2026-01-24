import { ipcMain, app } from 'electron';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import log from "loglevel";
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../renderer/schema/drizzle';

log.setLevel(log.levels.INFO);

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
    log.info('[Database] Initializing database:', dbName);
    if (db) {
      db.close();
      db = null;
    }

    const dbDir = getDbDirectory();
    const dbPath = path.join(dbDir, dbName);

    // [DEV] 强制删除旧数据库，每次重启/重载都重建
    // 如果需要保留数据，请注释掉下面这段代码
    if (fs.existsSync(dbPath)) {
      log.warn('[Database] DEV MODE: Deleting existing database for fresh rebuild');
      try {
        fs.unlinkSync(dbPath);
        const walFile = `${dbPath}-wal`;
        const shmFile = `${dbPath}-shm`;
        if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
        if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
      } catch (err) {
        log.error('[Database] Failed to delete database files:', err);
      }
    }

    log.info(`[Database] Opening database: ${dbPath}`);

    db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    // Run migrations
    runMigrations();

    log.info('[Database(main)] Database initialized successfully');
  } catch (error) {
    log.error('[Database(main)] Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Run database migrations using Drizzle ORM
 * For production: Use migrate() to apply migrations from drizzle/ folder
 * For development: Can use drizzle-kit push to sync schema directly
 */
function runMigrations(): void {
  if (!db) return;

  try {
    const drizzleDb = drizzle(db, { schema });
    
    // Apply migrations from drizzle/ folder
    // Comment this out if you prefer to rebuild from scratch during development
    let migrationsFolder = path.join(__dirname, '../../drizzle');

    if (app.isPackaged) {
      migrationsFolder = path.join(process.resourcesPath, 'drizzle');
    }
    migrate(drizzleDb, { migrationsFolder });
    
    log.info('[Database] Migrations applied successfully');
  } catch (e) {
    log.error('[Database] Migration failed:', e);
    throw e;
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