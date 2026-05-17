import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../schema/drizzle';
import loglevel from 'loglevel';

const log = loglevel.getLogger('DbLib');
// log.setLevel(loglevel.levels.WARN);
log.setLevel(loglevel.levels.TRACE);

let dbInitialized = false;
let initPromise: Promise<void> | null = null;
let currentDbName: string | null = null;
let transactionQueueTail: Promise<void> = Promise.resolve();

// Internal unexported db instance
let db: ReturnType<typeof drizzle<typeof schema>>;

function toArrayRow(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object') {
    return Object.values(row as Record<string, unknown>);
  }
  return [];
}

function toArrayRows(rows: unknown[]): unknown[][] {
  return rows.map((row) => toArrayRow(row));
}

// DB singleton for the renderer process
export function getDb() {
  if (!dbInitialized || !db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export type DbClient = ReturnType<typeof getDb>;
export type DbTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];
export type DbExecutor = DbClient | DbTransaction;

async function enqueueTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const previous = transactionQueueTail;
  let release!: () => void;

  transactionQueueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function serializeTopLevelTransactions<TDb extends ReturnType<typeof drizzle<typeof schema>>>(
  target: TDb,
): TDb {
  const rawTransaction = target.transaction.bind(target);

  target.transaction = ((transaction, config) =>
    enqueueTransaction(() => rawTransaction(transaction as never, config))) as TDb['transaction'];

  return target;
}

/**
 * Generate the database filename based on userId or return a provided db filename.
 */
export function getDbName(userIdOrDbName: string): string {
  if (userIdOrDbName.endsWith('.db')) {
    return userIdOrDbName;
  }
  return `${userIdOrDbName}_drifting.db`;
}

/**
 * Initialize database and Drizzle proxy.
 */
export async function initDatabase(userId: string): Promise<void> {
  const targetDbName = getDbName(userId);
  if (dbInitialized && currentDbName === targetDbName) {
    return Promise.resolve();
  }
  log.debug(
    `[DB] Target DB Name: ${targetDbName}; Current DB Name: ${currentDbName}; Initialized: ${dbInitialized}`,
  );

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

      db = serializeTopLevelTransactions(
        drizzle(
          async (sql, params, method) => {
            try {
              // If the query is a SELECT / reading data
              if (method === 'all') {
                const result = await window.electronAPI.db.query(sql, params);
                return { rows: toArrayRows(result) };
              }

              if (method === 'run') {
                const result = await window.electronAPI.db.run(sql, params);
                return {
                  rows: [],
                  rowsAffected: result.changes,
                  insertId: result.lastInsertRowid,
                };
              }

              if (method === 'get') {
                const result = await window.electronAPI.db.get(sql, params);
                return { rows: result ? [toArrayRow(result)] : [] };
              }

              if (method === 'values') {
                const result = await window.electronAPI.db.query(sql, params);
                return { rows: toArrayRows(result) };
              }

              const rows = await window.electronAPI.db.query(sql, params);
              return { rows: toArrayRows(rows) };
            } catch (e) {
              log.error('Drizzle Proxy Error:', e);
              throw e;
            }
          },
          { schema },
        ),
      );

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
    transactionQueueTail = Promise.resolve();
  } catch (error) {
    log.error('[DB] Error resetting database:', error);
    dbInitialized = false;
    currentDbName = null;
    initPromise = null;
    transactionQueueTail = Promise.resolve();
  }
}
