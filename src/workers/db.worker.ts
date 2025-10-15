/// <reference lib="webworker" />

import * as SQLite from 'wa-sqlite';
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';

import type { DbWorkerRequest } from '../lib/db';
import { DB_SCHEMA, DEFAULT_ELEMENT_CATEGORY, MOCK_ELEMENT_CATEGORIES, MOCK_ELEMENTS } from '../schema/table';

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;
type SQLiteCompatibleType = number | string | Uint8Array | Array<number> | bigint | null;
type BindParams =
  | Array<SQLiteCompatibleType | null>
  | { [index: string]: SQLiteCompatibleType | null };
type RowObject = Record<string, SQLiteCompatibleType | null>;

type DbWorkerResponse =
  | { id?: number; type: 'ready' }
  | { id?: number; type: 'migrated' }
  | { id?: number; type: 'ok' }
  | { id?: number; type: 'rows'; payload: { rows: RowObject[] } }
  | { id?: number; type: 'error'; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sqlite3: SQLiteAPI | null = null;
let db: number | null = null;
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

async function initDB(filename = 'drifting.db') {
  if (db !== null && sqlite3 !== null) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const module = await SQLiteAsyncESMFactory();
    sqlite3 = SQLite.Factory(module);
    const vfs = await OPFSCoopSyncVFS.create('drifting-opfs', module);
    // @ts-expect-error wa-sqlite types miss the overload for registering custom VFS
    sqlite3.vfs_register(vfs, true);
    db = await sqlite3.open_v2(filename);
    await sqlite3!.exec(db, 'PRAGMA foreign_keys = ON;');
  })();

  try {
    await initPromise;
  } catch (error) {
    sqlite3 = null;
    db = null;
    throw error;
  } finally {
    initPromise = null;
  }
}

async function execute(sql: string, params?: BindParams): Promise<void> {
  if (!sqlite3 || db === null) throw new Error('Database not initialized');

  let index = 0;
  console.log(`Trying execute ${sql} with params ${params}`);
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
  console.log(`Done executing.`);
}

async function select(sql: string, params?: BindParams): Promise<RowObject[]> {
  if (!sqlite3 || db === null) throw new Error('Database not initialized');

  const results: RowObject[] = [];
  let index = 0;
  console.log(`Trying select ${sql} with params ${params}`);
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
  console.log(`Done selecting. Got ${results.length} rows.`);

  return results;
}

async function migrateSchema() {
  console.log('Migrating database schema...');
  await execute(DB_SCHEMA);
  console.log('Seeding categories.');
  await seedDefaultCategories();
  console.log('Seeding elements.');
  await seedDefaultElements();
}

async function seedDefaultCategories() {
  const categories = [DEFAULT_ELEMENT_CATEGORY, ...MOCK_ELEMENT_CATEGORIES];
  for (const category of categories) {
    await execute(
      `INSERT OR IGNORE INTO element_category (id, name, description_json, color)
       VALUES (?, ?, ?, ?)`,
      [
        category.id,
        category.name,
        category.description_json,
        category.color ?? null
      ]
    );
  }
}

async function seedDefaultElements() {
  const elements = MOCK_ELEMENTS;
  for (const elem of elements) {
    if (typeof elem.content_json !== 'string') {
      console.warn('content_json is not string:', elem.id, elem.content_json);
    }
    if (typeof elem.summary_json !== 'string') {
      console.warn('summary_json is not string:', elem.id, elem.summary_json);
    }
    await execute(
      `INSERT OR IGNORE INTO element (id, project_id, category_id, type, name, content_json, summary_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      elem.id,
      elem.project_id,
      elem.category_id,
      elem.type,
      elem.name,
      elem.content_json,
      elem.summary_json,
      elem.created_at,
      elem.updated_at
    ]
    );
  }

}

async function handleRequest(message: DbWorkerRequest) {
  const { id, type: messageType, payload } = message;

  try {
    switch (messageType) {
      case 'init': {
        await initDB(payload?.dbName);
        postMessage({ id, type: 'ready' });
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
        ensureSql(payload?.sql);
        await execute(payload.sql);
        postMessage({ id, type: 'ok' });
        return;
      }
      case 'query': {
        await ensureInitialized();
        ensureSql(payload?.sql);
        const rows = await select(payload.sql);
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
