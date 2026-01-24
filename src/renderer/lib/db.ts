import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../schema/drizzle';
import loglevel from "loglevel";

const log = loglevel.getLogger("DbLib");
// log.setLevel(loglevel.levels.ERROR);
log.setLevel(loglevel.levels.TRACE);

let dbInitialized = false;
let initPromise: Promise<void> | null = null;
let currentDbName: string | null = null;

// Internal unexported db instance
let db: ReturnType<typeof drizzle<typeof schema>>;


// DB singleton for the renderer process
export function getDb() {
  if (!dbInitialized || !db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

/**
 * Generate the database filename based on userId
 */
export function getDbName(userId: string): string {
  return `${userId}_drifting.db`;
}

/**
 * Initialize database and Drizzle proxy.
 */
export async function initDatabase(userId: string): Promise<void> {
  const targetDbName = getDbName(userId); 
  log.debug(`[DB] Target DB Name: ${targetDbName}`);
  if (dbInitialized && currentDbName === targetDbName) {
    return Promise.resolve();
  }

  if (dbInitialized && currentDbName !== targetDbName) {
    log.info(`[DB] Switching database from ${currentDbName} to ${targetDbName}`);
    await resetDatabase();
    return initDatabase(userId);
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      log.info(`[DB] Initializing database: ${targetDbName}`);

      // Initialize the backend DB connection via IPC
      await window.electronAPI.db.init(targetDbName);
      currentDbName = targetDbName;
      dbInitialized = true;

      db = drizzle(async (sql, params, method) => {
        try {
          // If the query is a SELECT / reading data
          if (method === 'all') {
            const result = await window.electronAPI.db.query(sql, params);
            return { rows: result };
          }


          if (method === 'run') {
            const result = await window.electronAPI.db.run(sql, params);
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

          const rows = await window.electronAPI.db.query(sql, params);
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
