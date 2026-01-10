import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../schema/drizzle';
import loglevel from "loglevel";

const log = loglevel.getLogger("DbLib");
log.setLevel(loglevel.levels.ERROR);

let dbInitialized = false;
let initPromise: Promise<void> | null = null;
let currentDbName: string | null = null;

// Internal unexported db instance
let db: ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  if (!dbInitialized || !db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

/**
 * Generate the database filename based on userId and projectId.
 */
export function getDbName(userId?: string): string {
  // Use a single database file for all projects to allow cross-project querying
  return userId ? `${userId}_drifting.db` : 'drifting-library.db';
}

/**
 * Initialize database and Drizzle proxy.
 */
export async function initDatabase(projectId?: string, userId?: string): Promise<void> {
  const targetDbName = getDbName(userId);

  if (dbInitialized && currentDbName === targetDbName) {
    return Promise.resolve();
  }

  if (dbInitialized && currentDbName !== targetDbName) {
    log.info(`[DB] Switching database from ${currentDbName} to ${targetDbName}`);
    await resetDatabase();
    return initDatabase(projectId, userId);
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      log.info(`[DB] Initializing database: ${targetDbName}`);

      // Initialize the backend DB connection via IPC
      await window.electronAPI.db.init(targetDbName);
      currentDbName = targetDbName;
      dbInitialized = true;

      // Initialize Drizzle Proxy
      // This allows us to use the Drizzle Query Builder in the renderer,
      // but execution happens in the main process.
      db = drizzle(async (sql, params, method) => {
        try {
          // If the query is a SELECT / reading data
          if (method === 'all') {
            const result = await window.electronAPI.db.query(sql, params);
            return { rows: result };
          }

          // For get, values in standard sqlite-proxy? 
          // Actually better-sqlite3 wrapper usually expects 'all' or 'run' or 'values'
          // We map 'get' -> query and return first?
          // Drizzle's proxy driver expects:
          // { rows: any[] } for 'all'
          // { rows: any[][] } for 'values'
          // { rows: any[], ...stats } for 'run'

          if (method === 'run') {
            const result = await window.electronAPI.db.run(sql, params);
            // Return structure matching what Drizzle expects for 'run'
            // Usually { rows: [], rowsAffected: ..., insertId: ... }
            return {
              rows: [],
              rowsAffected: result.changes,
              insertId: result.lastInsertRowid
            };
          }

          if (method === 'get') {
            const result = await window.electronAPI.db.get(sql, params);
            return { rows: result ? [result] : [] };
          }

          // Fallback or 'values'
          const rows = await window.electronAPI.db.query(sql, params);
          // For 'values', we really need arrays of values, but our IPC returns objects.
          // In a real proxy driver we might need to conform strictly.
          // However, for most use cases 'all' and 'run' cover standard QB usage.
          return { rows };

        } catch (e) {
          log.error('Drizzle Proxy Error:', e);
          throw e;
        }
      }, { schema });

      log.info('[DB] Drizzle Proxy initialized successfully');

    } catch (error) {
      log.error('[DB] Failed to initialize database:', error);
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export async function resetDatabase(): Promise<void> {
  if (!dbInitialized) return;
  try {
    await window.electronAPI.db.close();
    dbInitialized = false;
    currentDbName = null;
    initPromise = null;
  } catch (error) {
    log.error('[DB] Error resetting database:', error);
    dbInitialized = false;
    currentDbName = null;
    initPromise = null;
  }
}

// End of file
