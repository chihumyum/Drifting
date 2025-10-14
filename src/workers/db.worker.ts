import * as SQLite from 'wa-sqlite';

import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';

import { DB_SCHEMA, MOCK_ELEMENT_CATEGORIES } from '../schema/table';


let sqlite3: SQLiteAPI;
let db: number;

export async function initDB(filename = 'drifting.db') {
    const module = await SQLiteAsyncESMFactory();
    sqlite3 = SQLite.Factory(module);
    const vfs = await OPFSCoopSyncVFS.create('hello', module);
    // @ts-expect-error ignore here
    sqlite3.vfs_register(vfs, true);
    db = await sqlite3.open_v2(filename);
}


type SQLiteCompatibleType = number|string|Uint8Array|Array<number>|bigint|null;
type Row = SQLiteCompatibleType[]
async function run(sql: string,
    params: {[index: string]: SQLiteCompatibleType|null}|Array<SQLiteCompatibleType|null>): Promise<Row[]>
    {
    for await(const stmt of sqlite3.statements(db, sql)) {
        try {
            sqlite3.bind_collection(stmt, params);
            const rows: Row[] = [];
            while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
                rows.push(sqlite3.row(stmt));
            }
            return rows;
        } finally {
            await sqlite3.finalize(stmt);
        }
    }
    return [];
}




