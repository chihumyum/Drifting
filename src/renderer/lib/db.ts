// Database interface for Electron
// This replaces the web worker-based implementation with IPC to main process
import loglevel from "loglevel";

const log = loglevel.getLogger("DbLib");
log.setLevel(loglevel.levels.ERROR);

let dbInitialized = false;
let initPromise: Promise<void> | null = null;
let currentDbName: string | null = null;

/**
 * Generate the database filename based on userId and projectId.
 * Format: {userId}_{projectId}.db or {projectId}.db if no userId (offline demo mode)
 */
export function getDbName(userId?: string, projectId?: string): string {
  const pid = projectId ?? 'default-project';
  return userId ? `${userId}_${pid}.db` : `${pid}.db`;
}

/**
 * Initialize database for a specific user and project.
 * If the database is already initialized with the same name, returns immediately.
 * If initialized with a different name, resets and reinitializes.
 */
export async function initDatabase(projectId?: string, userId?: string): Promise<void> {
  const targetDbName = getDbName(userId, projectId);

  // If already initialized with the same database, return immediately
  if (dbInitialized && currentDbName === targetDbName) {
    return Promise.resolve();
  }

  // If initialized with a different database, need to close first
  if (dbInitialized && currentDbName !== targetDbName) {
    log.info(`[DB] Switching database from ${currentDbName} to ${targetDbName}`);
    await resetDatabase();
    return initDatabase(projectId, userId);
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      log.info(`[DB] Initializing database: ${targetDbName}`);
      await window.electronAPI.db.init(targetDbName);
      currentDbName = targetDbName;
      dbInitialized = true;
      log.info('[DB] Database initialized successfully');
    } catch (error) {
      log.error('[DB] Failed to initialize database:', error);
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Reset the database connection.
 * This closes the current database and allows switching to a different one.
 */
export async function resetDatabase(): Promise<void> {
  if (!dbInitialized) return;

  try {
    await window.electronAPI.db.close();
    dbInitialized = false;
    currentDbName = null;
    initPromise = null;
    log.info('[DB] Database connection reset');
  } catch (error) {
    log.error('[DB] Error resetting database:', error);
    // Reset state anyway
    dbInitialized = false;
    currentDbName = null;
    initPromise = null;
  }
}

/**
 * Get the current database name (for debugging/info).
 */
export function getCurrentDbName(): string | null {
  return currentDbName;
}

/**
 * Execute a SQL statement that doesn't return data (INSERT, UPDATE, DELETE)
 */
export async function run(sql: string, params?: any[]): Promise<number> {
  if (!dbInitialized) {
    await initDatabase();
  }
  if (!dbInitialized) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  try {
    const result = await window.electronAPI.db.run(sql, params);
    return result.changes;
  } catch (error) {
    log.error('[DB] Run error:', error);
    throw error;
  }
}

/**
 * Execute a SQL query that returns multiple rows
 */
export async function query<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]> {
  if (!dbInitialized) {
    await initDatabase();
  }
  if (!dbInitialized) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  try {
    return await window.electronAPI.db.query(sql, params);
  } catch (error) {
    log.error('[DB] Query error:', error);
    throw error;
  }
}

/**
 * Execute a SQL query that returns a single row
 */
export async function get<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T | undefined> {
  if (!dbInitialized) {
    await initDatabase();
  }
  if (!dbInitialized) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  try {
    return await window.electronAPI.db.get(sql, params);
  } catch (error) {
    log.error('[DB] Get error:', error);
    throw error;
  }
}

// Export type for params (for compatibility with web-old code)
export type BindParams = any[];

// Migration function (no-op in Electron - migrations are done in main process on init)
export async function migrate(): Promise<void> {
  // Migrations are handled in the main process when db is initialized
  return Promise.resolve();
}
