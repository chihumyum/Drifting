/// <reference lib="webworker" />

import * as SQLite from 'wa-sqlite';
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';
import type { DbWorkerRequest } from '../lib/db';
import { DB_SCHEMA } from '../schema/table';

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;
export type SQLiteCompatibleType = number | string | Uint8Array | Array<number> | bigint | null;
export type BindParams =
  | Array<SQLiteCompatibleType | null>
  | { [index: string]: SQLiteCompatibleType | null };
type RowObject = Record<string, SQLiteCompatibleType | null>;

type DbWorkerResponse =
  | { id?: number; type: 'ready' }
  | { id?: number; type: 'migrated' }
  | { id?: number; type: 'changes'; payload: { changes: number } } // number of rows changed, for run, for now
  | { id?: number; type: 'rows'; payload: { rows: RowObject[] } }
  | { id?: number; type: 'closed' }
  | { id?: number; type: 'error'; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sqlite3: SQLiteAPI | null = null;
let db: number | null = null;
let currentDbFilename: string | null = null;
let initPromise: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();

function postMessage(message: DbWorkerResponse) {
  ctx.postMessage(message);
}

function ensureSql(sql?: string): asserts sql is string {
  if (!sql || typeof sql !== 'string') {
    throw new Error('SQL statement is required');
  }
}

async function ensureInitialized(filename?: string) {
  if (db !== null && sqlite3 !== null) return;
  await initDB(filename);
}

async function closeDB() {
  if (db !== null && sqlite3 !== null) {
    try {
      await sqlite3.close(db);
      console.log('[DB Worker] Database closed:', currentDbFilename);
    } catch (error) {
      console.error('[DB Worker] Error closing database:', error);
    }
  }
  db = null;
  currentDbFilename = null;
  // Note: we keep sqlite3 and VFS alive for reuse
}

async function initDB(filename = 'drifting.db') {
  // If switching to a different database, close the current one first
  if (db !== null && currentDbFilename !== filename) {
    console.log(`[DB Worker] Switching database from ${currentDbFilename} to ${filename}`);
    await closeDB();
  }
  
  // If already initialized with the same database, skip
  if (db !== null && sqlite3 !== null && currentDbFilename === filename) {
    console.log('[DB Worker] Database already initialized:', filename);
    return;
  }
  
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    if (!sqlite3) {
      const module = await SQLiteAsyncESMFactory();
      sqlite3 = SQLite.Factory(module);
      const vfs = await OPFSCoopSyncVFS.create('drifting-opfs', module);
      // @ts-expect-error wa-sqlite types miss the overload for registering custom VFS
      sqlite3.vfs_register(vfs, true);
    }
    db = await sqlite3.open_v2(filename);
    currentDbFilename = filename;
    await sqlite3!.exec(db, 'PRAGMA foreign_keys = ON;');
    console.log('[DB Worker] Database initialized:', filename);
  })();

  try {
    await initPromise;
  } catch (error) {
    db = null;
    currentDbFilename = null;
    throw error;
  } finally {
    initPromise = null;
  }
}

async function execute(sql: string, params?: BindParams): Promise<number> {
  if (!sqlite3 || db === null) throw new Error('Database not initialized');

  let index = 0;
  // console.log(`Trying execute ${sql} with params ${params}`);
  // Important: wa-sqlite automatically manage the statements, never call finalize explicitly
  for await (const stmt of sqlite3.statements(db, sql)) {
    try {
      if (index === 0 && params) {
        sqlite3.bind_collection(stmt, params);
      }
      while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        // Drain rows for statements that might return data (e.g. PRAGMA)
      }
    } catch (error) {
      console.error(`Error executing SQL: ${sql}`, error);
    }
    index += 1;
  }
  const changes = sqlite3.changes(db);
  console.log(`Changes: ${changes}`);

  // console.log(`Done executing.`);
  return changes;
}

async function select(sql: string, params?: BindParams): Promise<RowObject[]> {
  if (!sqlite3 || db === null) throw new Error('Database not initialized');

  const results: RowObject[] = [];
  let index = 0;
  // console.log(`Trying select ${sql} with params ${params}`);
  for await (const stmt of sqlite3.statements(db, sql)) {
    try {
      if (index === 0 && params) {
        sqlite3.bind_collection(stmt, params);
      }
      const columns = sqlite3.column_names(stmt);

      while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        const values = sqlite3.row(stmt) as SQLiteCompatibleType[];
        const record: RowObject = {};
        for (let i = 0; i < columns.length; i += 1) {
          record[columns[i]] = values[i] ?? null;
        }
        results.push(record);
      }
    } finally {
      // await sqlite3.finalize(stmt); this is wrong!
    }
    index += 1;
  }
  // console.log(`Done selecting. Got ${results.length} rows.`);

  return results;
}

async function migrateSchema() {
  console.log('[Migration] Applying database schema...');
  await execute(DB_SCHEMA);
  console.log('[Migration] Schema applied successfully');
}


async function handleRequest(message: DbWorkerRequest) {
  const { id, type: messageType } = message;

  try {
    switch (messageType) {
      case 'init': {
        const payload = 'payload' in message ? message.payload : undefined;
        await initDB(payload?.dbName);
        postMessage({ id, type: 'ready' });
        return;
      }
      case 'close': {
        await closeDB();
        postMessage({ id, type: 'closed' });
        return;
      }
      case 'migrate': {
        await ensureInitialized();
        await migrateSchema();
        postMessage({ id, type: 'migrated' });
        return;
      }
      case 'run': {
        await ensureInitialized();
        const payload = 'payload' in message ? message.payload : undefined;
        ensureSql(payload?.sql);
        console.log('[DB Worker] Executing SQL:', payload!.sql, 'params:', payload?.params);
        const changes = await execute(payload!.sql, payload?.params);
        console.log('[DB Worker] SQL executed, changes:', changes);
        postMessage({ id, type: 'changes', payload: { changes } });
        return;
      }
      case 'query': {
        await ensureInitialized();
        const payload = 'payload' in message ? message.payload : undefined;
        ensureSql(payload?.sql);
        console.log('[DB Worker] Querying SQL:', payload!.sql, 'params:', payload?.params);
        const rows = await select(payload!.sql, payload?.params);
        console.log('[DB Worker] Query result, rows count:', rows.length);
        postMessage({ id, type: 'rows', payload: { rows } });
        return;
      }
    }
    const exhaustive: never = messageType;
    throw new Error(`Unknown worker message type: ${exhaustive}`);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    postMessage({ id, type: 'error', error: messageText });
  }
}

ctx.addEventListener('message', (event: MessageEvent<DbWorkerRequest>) => {
  queue = queue.then(() => handleRequest(event.data));
});
