import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { createDatabaseClient, type DbExecutor } from '../../../db';
import type {
  DatabaseCheckpointResult,
  DatabaseExecuteResult,
  DatabaseOpenResult,
  DatabasePlatformApi,
  DatabaseQueryResult,
  DatabaseTransaction,
  TransactionBehavior,
} from '../../../../platform/database';

const DRIZZLE_DIRECTORY = new URL('../../../../../../drizzle/', import.meta.url);

/**
 * Apply the product migrations that own Agent runtime/write receipts plus any
 * later Yjs runtime migration. The optional scan keeps this acceptance helper
 * compatible with a concurrently-added 0062 without coupling it to a filename.
 */
function runtimeMigrationSql(): string {
  return readdirSync(DRIZZLE_DIRECTORY)
    .filter((name) => {
      const sequence = Number(name.slice(0, 4));
      return (
        Number.isInteger(sequence) &&
        sequence >= 60 &&
        sequence <= 69 &&
        (name.includes('agent_runtime') || name.includes('yjs'))
      );
    })
    .sort()
    .map((name) =>
      readFileSync(new URL(name, DRIZZLE_DIRECTORY), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    )
    .join('\n');
}

/**
 * Node-backed implementation of the same DatabasePlatformApi used by the
 * renderer repositories. It intentionally uses a real file, WAL, FULL sync,
 * and explicit transaction ownership so acceptance cannot accidentally pass
 * against an in-memory or transaction-less mock.
 */
export class P3FileBackedSqliteGateway implements DatabasePlatformApi {
  readonly database: DatabaseSync;
  private activeTransaction: string | null = null;
  private nextTransactionId = 1;

  constructor(readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE project (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_conversation (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        sdk_session_id TEXT,
        mode TEXT NOT NULL DEFAULT 'byok',
        messages_json TEXT NOT NULL DEFAULT '[]',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE yjs_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        update_blob BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_yjs_updates_doc
        ON yjs_updates(document_id);
      CREATE TABLE yjs_snapshots (
        document_id TEXT PRIMARY KEY NOT NULL,
        state_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_yjs_snapshot_doc
        ON yjs_snapshots(document_id);
    `);
    this.database.exec(runtimeMigrationSql());
    this.database.exec(`
      CREATE TABLE acceptance_node_projection (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE acceptance_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, entity_id, field, value)
      );
    `);
  }

  client(): DbExecutor {
    return createDatabaseClient(this);
  }

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return {
      path: this.databasePath,
      journalMode: 'wal',
      migrationsApplied: runtimeMigrationSql().length > 0 ? 1 : 0,
    };
  }

  async execute(
    sql: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult> {
    this.assertTransaction(transactionId);
    const result = this.database
      .prepare(sql)
      .run(...(parameters as SQLInputValue[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async query(
    sql: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseQueryResult> {
    this.assertTransaction(transactionId);
    const statement = this.database.prepare(sql);
    statement.setReturnArrays(true);
    const columns = statement.columns().map((column) => column.name);
    const rows = statement.all(
      ...(parameters as SQLInputValue[]),
    ) as unknown as DatabaseQueryResult['rows'];
    return { columns, rows };
  }

  async begin(
    behavior: TransactionBehavior = 'deferred',
  ): Promise<DatabaseTransaction> {
    if (this.activeTransaction) {
      throw new Error('nested top-level acceptance transaction');
    }
    const id = String(this.nextTransactionId++);
    this.database.exec(`BEGIN ${behavior.toUpperCase()}`);
    this.activeTransaction = id;
    return { id };
  }

  async commit(transactionId: string): Promise<void> {
    this.requireOwner(transactionId);
    this.database.exec('COMMIT');
    this.activeTransaction = null;
  }

  async rollback(transactionId: string): Promise<void> {
    this.requireOwner(transactionId);
    this.database.exec('ROLLBACK');
    this.activeTransaction = null;
  }

  async checkpoint(): Promise<DatabaseCheckpointResult> {
    const [row] = this.database
      .prepare('PRAGMA wal_checkpoint(PASSIVE)')
      .all() as Array<{ busy: number; log: number; checkpointed: number }>;
    return {
      busy: Number(row?.busy ?? 0),
      logFrames: Number(row?.log ?? 0),
      checkpointedFrames: Number(row?.checkpointed ?? 0),
    };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private assertTransaction(transactionId?: string): void {
    if (transactionId !== undefined) this.requireOwner(transactionId);
    if (transactionId === undefined && this.activeTransaction) {
      throw new Error('acceptance query escaped active transaction');
    }
  }

  private requireOwner(transactionId: string): void {
    if (this.activeTransaction !== transactionId) {
      throw new Error(
        `transaction ${transactionId} does not own the acceptance database`,
      );
    }
  }
}
