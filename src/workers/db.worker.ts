/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url'

let db: any = null;
let sqlite3: any = null;

interface WorkerMessage {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

interface WorkerResponse {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  error?: string;
}

self.addEventListener('message', async (ev) => {
  const { id, type, payload }: WorkerMessage = ev.data || {};
  const reply = (data: Omit<WorkerResponse, 'id'>) => 
    self.postMessage({ id, ...data });

  try {
    switch (type) {
      case 'init':
        await initDatabase(payload?.dbName as string);
        reply({ type: 'ready' });
        break;

      case 'run':
        if (!db) throw new Error('Database not initialized');
        db.exec(payload?.sql as string);
        reply({ type: 'ok' });
        break;

      case 'query':
        if (!db) throw new Error('Database not initialized');
        const rows: Record<string, unknown>[] = [];
        db.exec({
          sql: payload?.sql as string,
          rowMode: 'object',
          callback: (row: Record<string, unknown>) => rows.push(row)
        });
        reply({ type: 'rows', payload: { rows } });
        break;

      case 'migrate':
        if (!db) throw new Error('Database not initialized');
        const { DB_SCHEMA } = await import('../lib/schema');
        db.exec(DB_SCHEMA);
        reply({ type: 'migrated' });
        break;

      default:
        reply({ type: 'error', error: `Unknown message type: ${type}` });
    }
  } catch (error) {
    reply({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
});

async function initDatabase(dbName?: string): Promise<void> {
  if (db) return;

  try {
    sqlite3 = await sqlite3InitModule({
      locateFile: (file: string) => file.endsWith('.wasm') ? wasmUrl : file,
    });

    if (sqlite3?.capi?.sqlite3_enable_fts5) {
      sqlite3.capi.sqlite3_enable_fts5();
    }

    // Try OPFS first, fallback to in-memory if it fails
    let filename = '';
    let useOPFS = false;
    
    // Check if OPFS is available
    if (sqlite3.capi.sqlite3_vfs_find('opfs')) {
      try {
        filename = `/opfs/${dbName || 'default.db'}`;
        db = new sqlite3.oo1.DB(filename, 'c');
        useOPFS = true;
        console.log('✅ SQLite initialized with OPFS storage');
      } catch (opfsError) {
        console.warn('⚠️ OPFS failed, falling back to in-memory:', opfsError);
        db = null;
      }
    }
    
    // Fallback to in-memory database
    if (!db) {
      filename = ':memory:';
      db = new sqlite3.oo1.DB(filename, 'c');
      useOPFS = false;
      console.log('✅ SQLite initialized with in-memory storage');
    }
    
    // Configure SQLite for optimal performance
    if (useOPFS) {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
    } else {
      db.exec('PRAGMA journal_mode=MEMORY');
      db.exec('PRAGMA synchronous=OFF');
    }
    
    db.exec('PRAGMA cache_size=2000');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA temp_store=memory');
    
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

export {}


