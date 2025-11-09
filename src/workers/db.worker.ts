/// <reference lib="webworker" />

import * as SQLite from 'wa-sqlite';
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';
import type { DbWorkerRequest } from '../lib/db';
import { 
  DB_SCHEMA, 
  DEFAULT_ELEMENT_CATEGORY, 
  MOCK_ELEMENT_CATEGORIES, 
  MOCK_ELEMENTS, 
  DEFAULT_PROJECT, 
  DEFAULT_STORY_THREAD,
  MOCK_STORY_THREADS,
  MOCK_CHAPTERS,
  MOCK_NODE_THREADS,
  MOCK_NODE_TAGS,
  MOCK_NODE_TAG_LINKS,
  MOCK_BOOK_CONTENTS,
} from '../schema/table';

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
  console.log('Migrating database schema...');
  await execute(DB_SCHEMA);
  
  // 检查是否需要 seed mock data（只在表为空时 seed）
  const existingNodes = await select('SELECT COUNT(*) as count FROM story_node');
  const nodeCount = existingNodes[0]?.count || 0;
  const shouldSeedMockData = nodeCount === 0;
  
  console.log('[Migration] Existing nodes:', nodeCount, 'Should seed mock data:', shouldSeedMockData);
  
  await seedDefaultProject();
  await seedDefaultThread();
  
  if (shouldSeedMockData) {
    console.log('[Migration] Seeding mock data...');
    await seedMockThreads();
    await seedMockChapters();
    await seedMockNodeThreads();
    console.log('Seeding node tags.');
    await seedMockNodeTags();
    await seedMockNodeTagLinks();
    console.log('Seeding book contents.');
    await seedMockBookContents();
  } else {
    console.log('[Migration] Skipping mock data seed - database already has data');
  }
  
  console.log('Seeding categories.');
  await seedDefaultCategories();
  console.log('Seeding elements.');
  await seedDefaultElements();
}

async function seedDefaultProject() {
  await execute(
    `INSERT OR IGNORE INTO project (id, project_name, author, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      DEFAULT_PROJECT.id,
      DEFAULT_PROJECT.project_name ?? null,
      DEFAULT_PROJECT.author ?? null,
      DEFAULT_PROJECT.description ?? null,
      DEFAULT_PROJECT.created_at,
      DEFAULT_PROJECT.updated_at,
    ]
  );
}

async function seedDefaultThread() {
  await execute(
    `INSERT OR IGNORE INTO story_thread (id, project_id, name, color, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      DEFAULT_STORY_THREAD.id,
      DEFAULT_STORY_THREAD.project_id,
      DEFAULT_STORY_THREAD.name,
      DEFAULT_STORY_THREAD.color,
      DEFAULT_STORY_THREAD.summary ?? null,
      DEFAULT_STORY_THREAD.created_at,
      DEFAULT_STORY_THREAD.updated_at,
    ]
  );
}

async function seedMockThreads() {
  for (const thread of MOCK_STORY_THREADS) {
    await execute(
      `INSERT OR IGNORE INTO story_thread (id, project_id, name, color, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        thread.id,
        thread.project_id,
        thread.name,
        thread.color,
        thread.summary ?? null,
        thread.created_at,
        thread.updated_at,
      ]
    );
  }
}

async function seedMockChapters() {
  for (const chapter of MOCK_CHAPTERS) {
    await execute(
      `INSERT OR IGNORE INTO story_node 
       (id, title, project_id, start, end, summary, story_stage_id, pos_x, pos_y, created_at, updated_at, sync_status, last_modified, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        chapter.id,
        chapter.title,
        chapter.project_id,
        chapter.start,
        chapter.end ?? null,
        chapter.summary ?? null,
        chapter.story_stage_id ?? null,
        chapter.pos_x ?? null,
        chapter.pos_y ?? null,
        chapter.created_at,
        chapter.updated_at,
        'synced',           // sync_status
        Date.now(),         // last_modified
        0,                  // is_deleted
      ]
    );
  }
}

async function seedMockNodeThreads() {
  for (const relation of MOCK_NODE_THREADS) {
    await execute(
      `INSERT OR IGNORE INTO node_thread (node_id, thread_id)
       VALUES (?, ?)`,
      [relation.node_id, relation.thread_id]
    );
  }
}

async function seedDefaultCategories() {
  const categories = [DEFAULT_ELEMENT_CATEGORY, ...MOCK_ELEMENT_CATEGORIES];
  for (const category of categories) {
    await execute(
      `INSERT OR IGNORE INTO element_category (id, name, description_json, color, sync_status, last_modified, is_deleted)
       VALUES (?, ?, ?, ?, 'synced', strftime('%s','now') * 1000, 0)`,
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

async function seedMockNodeTags() {
  for (const tag of MOCK_NODE_TAGS) {
    await execute(
      `INSERT OR IGNORE INTO node_tag (id, project_id, name, color, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        tag.id,
        tag.project_id,
        tag.name,
        tag.color ?? null,
        tag.created_at,
      ]
    );
  }
}

async function seedMockNodeTagLinks() {
  for (const link of MOCK_NODE_TAG_LINKS) {
    await execute(
      `INSERT OR IGNORE INTO node_tag_link (node_id, tag_id, created_at)
       VALUES (?, ?, ?)`,
      [link.node_id, link.tag_id, link.created_at]
    );
  }
}

async function seedMockBookContents() {
  for (const content of MOCK_BOOK_CONTENTS) {
    await execute(
      `INSERT OR IGNORE INTO book_content (id, node_id, pm_json, outline_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        content.id,
        content.node_id,
        content.pm_json,
        content.outline_json,
        content.created_at,
        content.updated_at,
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
        console.log('[DB Worker] Executing SQL:', payload.sql, 'params:', payload?.params);
        const changes = await execute(payload.sql, payload?.params);
        console.log('[DB Worker] SQL executed, changes:', changes);
        postMessage({ id, type: 'changes', payload: { changes } });
        return;
      }
      case 'query': {
        await ensureInitialized();
        ensureSql(payload?.sql);
        console.log('[DB Worker] Querying SQL:', payload.sql, 'params:', payload?.params);
        const rows = await select(payload.sql, payload?.params);
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
