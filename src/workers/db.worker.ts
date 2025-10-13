import * as SQLite from 'wa-sqlite';

import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';

import { DB_SCHEMA, MOCK_ELEMENT_CATEGORIES } from '../schema/table';

interface WorkerRequest {
  id?: number;
  type: 'init' | 'run' | 'query' | 'migrate';
  payload?: {
    dbName?: string;
    sql?: string;
  };
}

interface WorkerResponse {
  id?: number;
  type: 'ready' | 'ok' | 'rows' | 'migrated' | 'error';
  payload?: unknown;
  error?: string;
}

type BaseSQLiteApi = ReturnType<typeof SQLite.Factory>;
type BindingCollection = Record<string, unknown> | Array<unknown | null>;
type ExtendedSQLiteApi = BaseSQLiteApi & {
  run: (db: number, sql: string, params?: BindingCollection | BindingCollection[]) => Promise<void>;
  execWithParams: (
    db: number,
    sql: string,
    params?: BindingCollection | BindingCollection[]
  ) => Promise<{ columns: string[]; rows: unknown[][] }>;
};

function isBindingCollection(value: unknown): value is BindingCollection {
  if (Array.isArray(value)) return true;
  return typeof value === 'object' && value !== null;
}

function normalizeBindingParams(params?: BindingCollection | BindingCollection[]): BindingCollection[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) return [params];
  if (params.length === 0) return [params];
  if (params.every((entry) => isBindingCollection(entry))) {
    return params as BindingCollection[];
  }
  return [params as BindingCollection];
}

function extendApi(api: BaseSQLiteApi): ExtendedSQLiteApi {
  const extended = api as ExtendedSQLiteApi;

  extended.run = async (db, sql, params) => {
    const paramSets = normalizeBindingParams(params);
    let stmtIndex = 0;

    for await (const stmt of api.statements(db, sql)) {
      const binding = paramSets[stmtIndex] ?? paramSets[paramSets.length - 1];
      if (binding !== undefined) {
        api.bind_collection(stmt, binding as Record<string, unknown> | Array<unknown | null>);
      }

      while (await api.step(stmt) === SQLite.SQLITE_ROW) {
        // Exhaust the iterator to ensure statements run fully.
      }
      stmtIndex += 1;
    }
  };

  extended.execWithParams = async (db, sql, params) => {
    const paramSets = normalizeBindingParams(params);
    const rows: unknown[][] = [];
    const allColumns: string[][] = [];
    let stmtIndex = 0;

    for await (const stmt of api.statements(db, sql)) {
      const binding = paramSets[stmtIndex] ?? paramSets[paramSets.length - 1];
      if (binding !== undefined) {
        api.bind_collection(stmt, binding as Record<string, unknown> | Array<unknown | null>);
      }

      const columns = api.column_names(stmt);
      if (columns.length === 0) {
        while (await api.step(stmt) === SQLite.SQLITE_ROW) {
          // Consume rows for non-SELECT statements without tracking results.
        }
      } else {
        while (await api.step(stmt) === SQLite.SQLITE_ROW) {
          rows.push(api.row(stmt));
        }
        allColumns.push(columns);
      }
      stmtIndex += 1;
    }

    const primaryColumns = allColumns.pop() ?? [];
    return { columns: primaryColumns, rows };
  };

  return extended;
}

let sqliteModulePromise: Promise<ExtendedSQLiteApi> | null = null;
let sqlite3: ExtendedSQLiteApi | null = null;
let opfsVfs: OPFSCoopSyncVFS | null = null;
let opfsAvailable = false;
let currentDbName = 'default.db';
let dbHandle: number | null = null;

function post(id: number | undefined, type: WorkerResponse['type'], payload?: unknown, error?: string) {
  const message: WorkerResponse = { id, type };
  if (payload !== undefined) message.payload = payload;
  if (error) message.error = error;
  postMessage(message);
}

async function getSQLite(): Promise<ExtendedSQLiteApi> {
  if (sqlite3) return sqlite3;
  if (!sqliteModulePromise) {
    sqliteModulePromise = SQLiteAsyncESMFactory({
      locateFile: (file) => (file === 'wa-sqlite-async.wasm' ? wasmUrl : file),
    }).then(async (mod) => {
      const api = extendApi(SQLite.Factory(mod));
      // Try to register OPFS cooperative sync VFS. If it fails we fall back to default VFS.
      if (typeof navigator !== 'undefined' && 'storage' in navigator && navigator.storage?.getDirectory) {
        try {
          opfsVfs = await OPFSCoopSyncVFS.create('opfs-coop', mod);
          api.vfs_register(opfsVfs, true);
          opfsAvailable = true;
        } catch (error: unknown) {
          console.warn('[db-worker] OPFS cooperative VFS registration failed, falling back to default VFS.', error);
          opfsVfs = null;
          opfsAvailable = false;
        }
      }
      return api;
    });
  }
  sqlite3 = await sqliteModulePromise;
  return sqlite3;
}

async function openDatabase(dbName?: string) {
  const api = await getSQLite();
  const targetName = (dbName && dbName.trim()) ? dbName.trim() : currentDbName;

  if (dbHandle && targetName === currentDbName) {
    return { api, db: dbHandle };
  }

  if (dbHandle) {
    try {
      await api.close(dbHandle);
    } catch (error: unknown) {
      console.warn('[db-worker] Failed closing previous database handle', error);
    }
    dbHandle = null;
  }

  let opened = false;
  if (opfsAvailable && opfsVfs) {
    try {
      dbHandle = await api.open_v2(targetName, SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE, opfsVfs.name);
      opened = true;
    } catch (error) {
      console.warn('[db-worker] Opening OPFS database failed, falling back to memory database.', error);
      opfsAvailable = false;
      opfsVfs = null;
    }
  }

  if (!opened) {
    const memoryName = `file:${targetName}?mode=memory&cache=shared`;
    dbHandle = await api.open_v2(memoryName, SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE);
  }

  currentDbName = targetName;

  await api.exec(dbHandle, `
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA cache_size=2000;
    PRAGMA temp_store=MEMORY;
    PRAGMA foreign_keys=ON;
  `);

  return { api, db: dbHandle! };
}

function isDuplicateColumnError(error: unknown) {
  return error instanceof SQLite.SQLiteError &&
    error.code === SQLite.SQLITE_ERROR &&
    typeof error.message === 'string' &&
    error.message.includes('duplicate column name');
}

async function applyMigrations() {
  const { api, db } = await openDatabase();

  // Temporarily disable FK checks to allow legacy migrations.
  await api.exec(db, 'PRAGMA foreign_keys=OFF;');
  try {
    let renamedLegacy = false;
    try {
      await api.exec(db, 'ALTER TABLE entry RENAME TO entry__legacy;');
      renamedLegacy = true;
    } catch (error: unknown) {
      if (error instanceof SQLite.SQLiteError && error.code === SQLite.SQLITE_ERROR) {
        // Ignore legacy rename failures when table already migrated.
      } else {
        throw error;
      }
    }

    await api.exec(db, DB_SCHEMA);

    if (renamedLegacy) {
      try {
        await api.exec(db, `INSERT INTO element (id, project_id, type, name, aliases_json, attributes_json, canonical_summary, created_at, updated_at)
          SELECT id, project_id, type, name, aliases_json, attributes_json, canonical_summary, created_at, updated_at FROM entry__legacy;`);
        await api.exec(db, 'DROP TABLE entry__legacy;');
      } catch (error: unknown) {
        console.error('[db-worker] Legacy entry migration failed', error);
      }
    }

    for (const stmt of ['ALTER TABLE story_node ADD COLUMN pos_x REAL;', 'ALTER TABLE story_node ADD COLUMN pos_y REAL;']) {
      try {
        await api.exec(db, stmt);
      } catch (error: unknown) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
    }

    for (const category of MOCK_ELEMENT_CATEGORIES) {
      await api.run(
        db,
        `INSERT OR IGNORE INTO element_category (id, name, description_json, color)
         VALUES (?, ?, ?, ?);`,
        [category.id, category.name, category.description_json, category.color ?? null]
      );
    }
  } finally {
    await api.exec(db, 'PRAGMA foreign_keys=ON;');
  }
}

async function handleInit(id: number | undefined, dbName?: string) {
  try {
    await openDatabase(dbName);
    post(id, 'ready');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post(id, 'error', undefined, message);
  }
}

async function handleRun(id: number | undefined, sql?: string) {
  if (!sql) {
    post(id, 'error', undefined, 'Missing SQL statement for run()');
    return;
  }
  try {
    const { api, db } = await openDatabase();
    await api.exec(db, sql);
    post(id, 'ok');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post(id, 'error', undefined, message);
  }
}

async function handleQuery(id: number | undefined, sql?: string) {
  if (!sql) {
    post(id, 'error', undefined, 'Missing SQL statement for query()');
    return;
  }
  try {
    const { api, db } = await openDatabase();
    const { rows, columns } = await api.execWithParams(db, sql);
    const mapped = columns.length === 0
      ? []
      : rows.map((rowValues: unknown[]) => {
        const record: Record<string, unknown> = {};
        columns.forEach((columnName: string, columnIndex: number) => {
          record[columnName] = rowValues[columnIndex];
        });
        return record;
      });
    post(id, 'rows', { rows: mapped });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post(id, 'error', undefined, message);
  }
}

async function handleMigrate(id: number | undefined) {
  try {
    await applyMigrations();
    post(id, 'migrated');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post(id, 'error', undefined, message);
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;
  switch (type) {
    case 'init':
      void handleInit(id, payload?.dbName);
      break;
    case 'run':
      void handleRun(id, payload?.sql);
      break;
    case 'query':
      void handleQuery(id, payload?.sql);
      break;
    case 'migrate':
      void handleMigrate(id);
      break;
    default:
      post(id, 'error', undefined, `Unknown message type: ${type}`);
  }
});

export { };
