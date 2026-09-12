import { TransactionRollbackError } from 'drizzle-orm/errors';
import { drizzle, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy';
import loglevel from 'loglevel';
import {
  DatabaseOpenFailure,
  databasePlatform,
  type DatabaseCheckpointResult,
  type DatabasePlatformApi,
  type TransactionBehavior,
} from '../platform/database';
import {
  clearDatabaseOpenFailure,
  publishDatabaseOpenFailure,
} from '../platform/database-recovery-store';
import * as schema from '../schema/drizzle';

const log = loglevel.getLogger('DbLib');
log.setLevel(loglevel.levels.TRACE);

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

interface TransactionScheduler {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

let dbInitialized = false;
let initPromise: Promise<void> | null = null;
let resetPromise: Promise<void> | null = null;
let currentDbName: string | null = null;
let db: DrizzleDatabase;
let recoverStaleTransactionOnNextOpen = true;

const schedulers = new WeakMap<DrizzleDatabase, TransactionScheduler>();

export function getDb(): DrizzleDatabase {
  if (!dbInitialized || !db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/** Read the shared client only when renderer database initialization has completed. */
export function getDbIfInitialized(): DrizzleDatabase | null {
  return dbInitialized && db ? db : null;
}

/**
 * Install an already-open product client for a bounded Node/headless command.
 * The desktop renderer still owns normal init/reset. This seam exists so the
 * developer CLI can reuse repositories whose legacy signatures resolve
 * `getDb()` while keeping one exact transaction-owning database.
 */
export function installHeadlessDatabaseClient(
  client: DrizzleDatabase,
  databaseName = 'headless.db',
): () => void {
  if (dbInitialized || db) {
    throw new Error('Cannot install a headless database over an initialized renderer database.');
  }
  db = client;
  dbInitialized = true;
  currentDbName = databaseName;
  return () => {
    if (db !== client) {
      throw new Error('The installed headless database is no longer the active client.');
    }
    dbInitialized = false;
    currentDbName = null;
    db = undefined as unknown as DrizzleDatabase;
  };
}

export type DbClient = DrizzleDatabase;
export type DbTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];
export type DbExecutor = DbClient | DbTransaction;

const transactionCommitCallbacks = new WeakMap<object, Array<() => void>>();

/** Schedule a synchronous notification only after the owning outer commit.
 * Savepoint rollback discards its callbacks. Notifications must enqueue work,
 * not await another transaction while the current scheduler is still held. */
export function afterDatabaseCommit(transaction: DbExecutor, callback: () => void): void {
  const callbacks = transactionCommitCallbacks.get(transaction);
  if (!callbacks) throw new Error('Commit notification requires an active bound transaction.');
  callbacks.push(callback);
}

function createTransactionScheduler(): TransactionScheduler {
  let tail: Promise<void> = Promise.resolve();

  return {
    async enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });

      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },

    async drain(): Promise<void> {
      // A transaction may be queued while an earlier snapshot is draining.
      // Keep observing the tail until no newer queue node appeared.
      let observed: Promise<void>;
      do {
        observed = tail;
        await observed;
      } while (observed !== tail);
    },
  };
}

function createProxyCallback(
  database: DatabasePlatformApi,
  transactionId?: string,
): AsyncRemoteCallback {
  return async (sql, parameters, method) => {
    try {
      if (method === 'run') {
        const result = await database.execute(sql, parameters, transactionId);
        return {
          rows: [],
          rowsAffected: result.changes,
          insertId: result.lastInsertRowid,
        };
      }

      const result = await database.query(sql, parameters, transactionId);
      // Rust already returns rows in SQLite column order. Passing those arrays
      // straight through avoids the old Object.values(row) ordering hazard.
      if (method === 'get') {
        // sqlite-proxy's `get` mapper consumes one positional row rather than
        // the two-dimensional collection used by `all` and `values`.
        return { rows: result.rows[0] as unknown[] };
      }
      return { rows: result.rows };
    } catch (error) {
      log.error('Drizzle Proxy Error:', error);
      throw error;
    }
  };
}

async function rollbackAfterFailure(
  database: DatabasePlatformApi,
  transactionId: string,
  cause: unknown,
): Promise<never> {
  try {
    await database.rollback(transactionId);
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      `Database transaction ${transactionId} failed and could not be rolled back`,
    );
  }
  throw cause;
}

interface SavepointSequence {
  next: number;
}

function createBoundTransaction(
  database: DatabasePlatformApi,
  transactionId: string,
  savepoints: SavepointSequence,
  commitCallbacks: Array<() => void>,
): DbTransaction {
  const transactionDatabase = drizzle(createProxyCallback(database, transactionId), { schema });
  transactionCommitCallbacks.set(transactionDatabase, commitCallbacks);

  transactionDatabase.transaction = (async (callback) => {
    const savepoint = `drifting_sp_${savepoints.next++}`;
    await database.execute(`SAVEPOINT ${savepoint}`, [], transactionId);
    const nestedCallbacks: Array<() => void> = [];
    const nestedTransaction = createBoundTransaction(database, transactionId, savepoints, nestedCallbacks);
    try {
      const result = await callback(nestedTransaction);
      await database.execute(`RELEASE SAVEPOINT ${savepoint}`, [], transactionId);
      commitCallbacks.push(...nestedCallbacks);
      return result;
    } catch (cause) {
      const cleanupErrors: unknown[] = [];
      try {
        await database.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`, [], transactionId);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await database.execute(`RELEASE SAVEPOINT ${savepoint}`, [], transactionId);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupErrors],
          `Database savepoint ${savepoint} failed and could not be cleaned up`,
        );
      }
      throw cause;
    } finally {
      transactionCommitCallbacks.delete(nestedTransaction);
      nestedCallbacks.length = 0;
    }
  }) as DrizzleDatabase['transaction'];

  Object.defineProperty(transactionDatabase, 'rollback', {
    configurable: false,
    enumerable: false,
    value: (): never => {
      throw new TransactionRollbackError();
    },
    writable: false,
  });

  return transactionDatabase as unknown as DbTransaction;
}

async function runGatewayTransaction<T>(
  database: DatabasePlatformApi,
  callback: (transaction: DbTransaction) => Promise<T>,
  behavior?: TransactionBehavior,
): Promise<T> {
  const { id } = await database.begin(behavior);
  const commitCallbacks: Array<() => void> = [];
  const transaction = createBoundTransaction(database, id, { next: 0 }, commitCallbacks);

  let result: T;
  try {
    result = await callback(transaction);
  } catch (error) {
    commitCallbacks.length = 0;
    return rollbackAfterFailure(database, id, error);
  } finally {
    transactionCommitCallbacks.delete(transaction);
  }

  try {
    await database.commit(id);
  } catch (error) {
    commitCallbacks.length = 0;
    return rollbackAfterFailure(database, id, error);
  }
  for (const notify of commitCallbacks.splice(0)) {
    try {
      notify();
    } catch {
      // The data already committed. A derived observer cannot turn success
      // into an apparent write failure or prevent other observers from running.
      log.warn('A database commit observer failed after a successful commit.');
    }
  }
  return result;
}

/**
 * Build the same Drizzle sqlite-proxy client used by every repository, backed
 * by a replaceable gateway for tests. Top-level transactions are implemented
 * here because Drizzle's stock proxy emits raw BEGIN/COMMIT statements and
 * cannot attach the Rust gateway's transaction ID to callback queries.
 */
export function createDatabaseClient(database: DatabasePlatformApi): DrizzleDatabase {
  const client = drizzle(createProxyCallback(database), { schema });
  const scheduler = createTransactionScheduler();

  client.transaction = ((callback, config) =>
    scheduler.enqueue(() =>
      runGatewayTransaction(
        database,
        callback as (transaction: DbTransaction) => Promise<unknown>,
        config?.behavior,
      ),
    )) as DrizzleDatabase['transaction'];

  schedulers.set(client, scheduler);
  return client;
}

async function drainTransactions(client: DrizzleDatabase | undefined): Promise<void> {
  if (!client) return;
  await schedulers.get(client)?.drain();
}

/** Generate the database filename based on userId or accept an explicit filename. */
export function getDbName(userIdOrDbName: string): string {
  if (userIdOrDbName.endsWith('.db')) return userIdOrDbName;
  return `${userIdOrDbName}_drifting.db`;
}

/** Open or switch the native database, then expose the shared Drizzle client. */
export async function initDatabase(userId: string): Promise<void> {
  const targetDbName = getDbName(userId);

  // A native close may already be draining transactions while the renderer
  // starts another repository read. Never trust the old in-memory ready flag
  // until that close has completed; reopen the requested database afterwards.
  if (resetPromise) {
    await resetPromise;
    return initDatabase(userId);
  }

  if (dbInitialized && currentDbName === targetDbName) return;

  if (initPromise) {
    await initPromise;
    if (dbInitialized && currentDbName === targetDbName) return;
    return initDatabase(userId);
  }

  if (dbInitialized && currentDbName !== targetDbName) {
    log.info(`[DB] Switching database from ${currentDbName} to ${targetDbName}`);
    await resetDatabase();
  }

  initPromise = (async () => {
    log.info(`[DB] Initializing database: ${targetDbName}`);
    try {
      const recoverStaleTransaction = recoverStaleTransactionOnNextOpen;
      // Recovery belongs only to the first native open attempted by this
      // renderer module. Later account switches and duplicate initialization
      // must never acquire permission to roll back this renderer's work.
      recoverStaleTransactionOnNextOpen = false;
      await databasePlatform.open(targetDbName, { recoverStaleTransaction });
      clearDatabaseOpenFailure();
      db = createDatabaseClient(databasePlatform);
      currentDbName = targetDbName;
      dbInitialized = true;
      log.info('[DB] Drizzle Proxy initialized successfully');
    } catch (error) {
      if (error instanceof DatabaseOpenFailure && error.recoverySessionId) {
        publishDatabaseOpenFailure(error);
      }
      log.error('[DB] Failed to initialize database:', error);
      throw error;
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/** Drain top-level transactions and force a WAL checkpoint without closing. */
export async function checkpointDatabase(): Promise<DatabaseCheckpointResult | null> {
  if (initPromise) await initPromise;
  if (!dbInitialized) return null;
  await drainTransactions(db);
  return databasePlatform.checkpoint();
}

/** Drain transactions, checkpoint/close the native connection, and clear the singleton. */
export function resetDatabase(): Promise<void> {
  // React Strict Mode and concurrent auth callers can request the same reset.
  // One native close owns the transition; every caller waits for its result.
  if (resetPromise) return resetPromise;

  const operation = (async () => {
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // A failed open leaves no connection to close.
      }
    }
    if (!dbInitialized) return;

    const closingClient = db;
    try {
      await drainTransactions(closingClient);
      await databasePlatform.close();
    } catch (error) {
      log.error('[DB] Error closing database:', error);
      throw error;
    } finally {
      dbInitialized = false;
      currentDbName = null;
    }
  })();

  const tracked = operation.finally(() => {
    if (resetPromise === tracked) resetPromise = null;
  });
  resetPromise = tracked;
  return tracked;
}
