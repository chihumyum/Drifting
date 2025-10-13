// Database interface

export type DbWorkerRequest =
  | { id?: number; type: 'init'; payload?: { dbName?: string } }
  | { id?: number; type: 'run'; payload: { sql: string } }
  | { id?: number; type: 'query'; payload: { sql: string } }
  | { id?: number; type: 'migrate'; payload?: Record<string, never> }

let worker: Worker | null = null;
let dbInitialized = false;
let initPromise: Promise<void> | null = null;

export function getDbWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/db.worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

export function initDatabase(projectId?: string): Promise<void> {
  if (dbInitialized) return Promise.resolve();
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
        handleReady();
      } else if (ev.data?.type === 'error') {
        initPromise = null;
        reject(new Error(ev.data.error));
      }
    };

    w.addEventListener('message', handler);
    w.postMessage({
      id: msgId,
      type: 'init',
      payload: { dbName: projectId ? `${projectId}.db` : 'default.db' }
    } as DbWorkerRequest);
  });

  return initPromise;
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

export async function run(sql: string): Promise<void> {
  if (!dbInitialized) {
    await initDatabase();
  }
  if (!dbInitialized) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  const w = getDbWorker();
  const msgId = Date.now() + Math.random();

  return new Promise<void>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.id !== msgId) return;
      w.removeEventListener('message', handler);

      if (ev.data?.type === 'ok') resolve();
      else reject(new Error(ev.data?.error || 'run failed'));
    };

    w.addEventListener('message', handler);
    w.postMessage({ id: msgId, type: 'run', payload: { sql } } as DbWorkerRequest);
  });
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
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
    w.postMessage({ id: msgId, type: 'query', payload: { sql } } as DbWorkerRequest);
  });
}
