// Database interface
import type { BindParams } from "../workers/db.worker";
export type DbWorkerRequest =
  | { id?: number; type: 'init'; payload?: { dbName?: string } }
  | { id?: number; type: 'run'; payload: { sql: string, params?: BindParams } }
  | { id?: number; type: 'query'; payload: { sql: string, params?: BindParams } }
  | { id?: number; type: 'migrate'; payload?: Record<string, never> }
  | { id?: number; type: 'close' }

let worker: Worker | null = null;
let dbInitialized = false;
let initPromise: Promise<void> | null = null;
let currentDbName: string | null = null;

export function getDbWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/db.worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

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
export function initDatabase(projectId?: string, userId?: string): Promise<void> {
  const targetDbName = getDbName(userId, projectId);
  
  // If already initialized with the same database, return immediately
  if (dbInitialized && currentDbName === targetDbName) {
    return Promise.resolve();
  }
  
  // If initialized with a different database, need to close first
  if (dbInitialized && currentDbName !== targetDbName) {
    console.log(`[DB] Switching database from ${currentDbName} to ${targetDbName}`);
    return resetDatabase().then(() => initDatabase(projectId, userId));
  }
  
  if (initPromise) return initPromise;

  initPromise = new Promise<void>((resolve, reject) => {
    const w = getDbWorker();
    const msgId = Date.now();

    const cleanup = () => {
      w.removeEventListener('message', handler);
    };

    const handleReady = () => {
      migrate()
        .then(() => {
          dbInitialized = true;
          resolve();
        })
        .catch((error) => {
          reject(error);
        })
        .finally(() => {
          initPromise = null;
        });
    };


    const handler = (ev: MessageEvent) => {
      if (ev.data?.id !== msgId) return;
      cleanup();

      if (ev.data?.type === 'ready') {
        currentDbName = targetDbName;
        handleReady();
      } else if (ev.data?.type === 'error') {
        initPromise = null;
        reject(new Error(ev.data.error));
      }
    };

    w.addEventListener('message', handler);
    console.log(`[DB] Initializing database: ${targetDbName}`);
    w.postMessage({
      id: msgId,
      type: 'init',
      payload: { dbName: targetDbName }
    } as DbWorkerRequest);
  });

  return initPromise;
}

/**
 * Reset the database connection.
 * This closes the current database and allows switching to a different one.
 */
export async function resetDatabase(): Promise<void> {
  if (!dbInitialized) return;
  
  const w = getDbWorker();
  const msgId = Date.now() + Math.random();
  
  return new Promise<void>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.id !== msgId) return;
      w.removeEventListener('message', handler);
      
      if (ev.data?.type === 'ready' || ev.data?.type === 'closed') {
        dbInitialized = false;
        currentDbName = null;
        initPromise = null;
        console.log('[DB] Database connection reset');
        resolve();
      } else if (ev.data?.type === 'error') {
        reject(new Error(ev.data.error));
      }
    };
    
    w.addEventListener('message', handler);
    w.postMessage({ id: msgId, type: 'close' } as DbWorkerRequest);
    
    // Fallback: resolve after timeout in case worker doesn't respond
    setTimeout(() => {
      dbInitialized = false;
      currentDbName = null;
      initPromise = null;
      resolve();
    }, 500);
  });
}

/**
 * Get the current database name (for debugging/info).
 */
export function getCurrentDbName(): string | null {
  return currentDbName;
}

export async function migrate(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = getDbWorker();
    const msgId = Date.now() + Math.random();
    
    const handler = (ev: MessageEvent) => {
      if (ev.data?.id !== msgId) return;
      w.removeEventListener('message', handler);
      
      if (ev.data?.type === 'migrated') resolve();
      else reject(new Error(ev.data?.error || 'migration failed'));
    };
    
    w.addEventListener('message', handler);
    w.postMessage({ id: msgId, type: 'migrate' } as DbWorkerRequest);
  });
}

export async function run(sql: string, params?: BindParams): Promise<number> {
  if (!dbInitialized) {
    await initDatabase();
  }
  if (!dbInitialized) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  const w = getDbWorker();
  const msgId = Date.now() + Math.random();

  return new Promise<number>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.id !== msgId) return;
      w.removeEventListener('message', handler);

      if (ev.data?.type === 'changes') resolve(ev.data?.payload?.changes || 0);
      else reject(new Error(ev.data?.error || 'run failed'));
    };

    w.addEventListener('message', handler);
    w.postMessage({ id: msgId, type: 'run', payload: { sql, params } } as DbWorkerRequest);
  });
}

export async function query<T = Record<string, unknown>>(sql: string, params?: BindParams): Promise<T[]> {
  if (!dbInitialized) {
    await initDatabase();
  }
  if (!dbInitialized) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  const w = getDbWorker();
  const msgId = Date.now() + Math.random();

  return new Promise<T[]>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.id !== msgId) return;
      w.removeEventListener('message', handler);

      if (ev.data?.type === 'rows') resolve(ev.data?.payload?.rows || []);
      else reject(new Error(ev.data?.error || 'query failed'));
    };

    w.addEventListener('message', handler);
    w.postMessage({ id: msgId, type: 'query', payload: { sql, params } } as DbWorkerRequest);
  });
}
