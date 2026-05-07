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
let currentDbPath: string | null = null;
let cleanupRegistered = false;

type DbFileStat = {
  path: string;
  exists: boolean;
  size?: number;
  mtime?: string;
  ino?: number;
};

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function shouldTraceSql(sql?: string): boolean {
  const trace = process.env.DRIFTING_DB_TRACE;
  if (!trace || trace === '0' || trace.toLowerCase() === 'false') return false;
  if (trace.toLowerCase() === 'all') return true;

  const normalized = (sql ?? '').toLowerCase();
  return trace
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((item) => normalized.includes(item));
}

function tableExists(tableName: string): boolean {
  if (!db) return false;
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function traceProjectState(label: string): void {
  if (!isTruthyEnv(process.env.DRIFTING_DB_TRACE_PROJECT_STATE)) return;
  if (!db || !tableExists('project')) {
    log.info(`[Database trace] ${label}: project table not present; db=${currentDbPath ?? '<none>'}`);
    return;
  }

  const rows = db
    .prepare('SELECT id, user_id, name, created_at, updated_at FROM project ORDER BY created_at DESC')
    .all();
  log.info(`[Database trace] ${label}: db=${currentDbPath ?? '<none>'}; projects=${rows.length}`, rows);
}

function traceSql(label: string, sql: string, params?: any[]): void {
  if (!shouldTraceSql(sql)) return;
  log.info(`[Database trace] ${label}`, {
    dbPath: currentDbPath,
    sql,
    params: params ?? [],
  });
}

function statDbFile(filePath: string): DbFileStat {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      ino: stat.ino,
    };
  } catch {
    return { path: filePath, exists: false };
  }
}

function traceDbFiles(label: string, dbPath: string): void {
  if (!isTruthyEnv(process.env.DRIFTING_DB_TRACE_FILES)) return;
  log.info(`[Database trace] ${label}`, [
    statDbFile(dbPath),
    statDbFile(`${dbPath}-wal`),
    statDbFile(`${dbPath}-shm`),
  ]);
}

function closeDatabase(reason: string): void {
  if (!db) return;
  const dbPath = currentDbPath;

  try {
    traceProjectState(`before close (${reason})`);
    if (dbPath) traceDbFiles(`before checkpoint (${reason})`, dbPath);
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
    log.info(`[Database] WAL checkpoint completed during ${reason}`, checkpoint);
    if (dbPath) traceDbFiles(`after checkpoint (${reason})`, dbPath);
  } catch (error) {
    log.error(`[Database] WAL checkpoint failed during ${reason}:`, error);
  }

  try {
    db.close();
  } finally {
    db = null;
    currentDbPath = null;
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  app.on('before-quit', () => {
    closeDatabase('before-quit');
  });
}

/**
 * Get the directory where database files should be stored
 */
function getDbDirectory(): string {
  const dbDirOverride = process.env.DRIFTING_DB_DIR;
  const dbDir = dbDirOverride
    ? path.resolve(process.cwd(), dbDirOverride)
    : path.join(app.getPath('userData'), 'databases');

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
      closeDatabase('switch database');
    }

    const dbDir = getDbDirectory();
    const dbPath = path.join(dbDir, dbName);

    log.info(`[Database] Opening database: ${dbPath}`);
    traceDbFiles('before open', dbPath);

    db = new Database(dbPath);
    currentDbPath = dbPath;

    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    // Run migrations to ensure tables exist before queries
    traceProjectState('before migrations');
    runMigrations();
    traceProjectState('after migrations');
    traceDbFiles('after migrations', dbPath);

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
  registerCleanup();

  // Initialize database
  ipcMain.handle('db:init', async (_event, dbName: string) => {
    initDatabase(dbName);
  });

  // Run a query (INSERT, UPDATE, DELETE)
  ipcMain.handle('db:run', async (_event, sql: string, params?: any[]) => {
    if (!db) throw new Error('Database not initialized');

    try {
      traceSql('db:run', sql, params);
      const stmt = db.prepare(sql);
      const result = stmt.run(...(params || []));
      if (shouldTraceSql(sql)) {
        traceProjectState('after db:run');
      }
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
      traceSql('db:query', sql, params);
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(params || []));
      if (shouldTraceSql(sql)) {
        log.info('[Database trace] db:query result', {
          dbPath: currentDbPath,
          rowCount: rows.length,
          rows,
        });
      }
      return rows;
    } catch (error) {
      log.error('[Database] Query error:', error);
      throw error;
    }
  });

  // Execute a query and return first row
  ipcMain.handle('db:get', async (_event, sql: string, params?: any[]) => {
    if (!db) throw new Error('Database not initialized');

    try {
      traceSql('db:get', sql, params);
      const stmt = db.prepare(sql);
      const row = stmt.get(...(params || []));
      if (shouldTraceSql(sql)) {
        log.info('[Database trace] db:get result', {
          dbPath: currentDbPath,
          row,
        });
      }
      return row;
    } catch (error) {
      log.error('[Database] Get error:', error);
      throw error;
    }
  });

  // Close database
  ipcMain.handle('db:close', async () => {
    closeDatabase('db:close');
  });
}
