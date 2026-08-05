import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { createDatabaseClient, type DbClient } from '../../../db';
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
 * later Yjs/runtime migrations. The scan deliberately has no upper bound: a
 * new Agent-owned table must enter the file-backed acceptance fixture in the
 * same milestone instead of silently testing an older schema.
 */
function runtimeMigrationSql(): string {
  return readdirSync(DRIZZLE_DIRECTORY)
    .filter((name) => {
      const sequence = Number(name.slice(0, 4));
      return (
        Number.isInteger(sequence) &&
        sequence >= 60 &&
        (
          name.includes('agent_runtime') ||
          name.includes('agent_extension') ||
          name.includes('yjs')
        )
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

interface ProductMigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface ProductMigrationJournal {
  entries: ProductMigrationJournalEntry[];
}

function readProductMigrationJournal(): ProductMigrationJournal {
  const journal = JSON.parse(
    readFileSync(
      new URL('meta/_journal.json', DRIZZLE_DIRECTORY),
      'utf8',
    ),
  ) as ProductMigrationJournal;
  if (!journal || !Array.isArray(journal.entries)) {
    throw new Error('Product migration journal is invalid.');
  }

  let previousIndex = -1;
  let previousWhen = -1;
  journal.entries.forEach((entry) => {
    if (!Number.isSafeInteger(entry.idx) || entry.idx <= previousIndex) {
      throw new Error(
        `Product migration journal indices are not strictly increasing at ${entry.tag}.`,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(entry.tag)) {
      throw new Error(`Product migration tag is invalid: ${entry.tag}.`);
    }
    if (
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen
    ) {
      throw new Error(
        `Product migration timestamps are not strictly increasing at ${entry.tag}.`,
      );
    }
    previousIndex = entry.idx;
    previousWhen = entry.when;
  });
  return journal;
}

/**
 * Mirrors the Rust database gateway instead of concatenating SQL files. This
 * matters for reopen/idempotency acceptance and catches journal drift in tests.
 */
function applyProductMigrations(database: DatabaseSync): number {
  const journal = readProductMigrationJournal();
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    const lastRow = database
      .prepare(
        'SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1',
      )
      .get() as { created_at?: unknown } | undefined;
    const lastWhen =
      lastRow?.created_at === undefined || lastRow.created_at === null
        ? null
        : Number(lastRow.created_at);
    const latestEmbedded =
      journal.entries[journal.entries.length - 1]?.when;
    if (
      lastWhen !== null &&
      latestEmbedded !== undefined &&
      lastWhen > latestEmbedded
    ) {
      throw new Error(
        `Product database schema is newer than this checkout (${lastWhen} > ${latestEmbedded}).`,
      );
    }

    const record = database.prepare(
      'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
    );
    let applied = 0;
    for (const entry of journal.entries) {
      if (lastWhen !== null && lastWhen >= entry.when) continue;
      const bytes = readFileSync(
        new URL(`${entry.tag}.sql`, DRIZZLE_DIRECTORY),
      );
      for (const statement of bytes
        .toString('utf8')
        .split('--> statement-breakpoint')) {
        if (statement.trim()) database.exec(statement);
      }
      record.run(
        createHash('sha256').update(bytes).digest('hex'),
        entry.when,
      );
      applied += 1;
    }
    database.exec('COMMIT');
    return applied;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

type FileBackedSqliteProfile = 'runtime' | 'product';

export interface FileBackedSqliteGatewayOptions {
  /**
   * Mirror the native Rust worker's same-renderer behavior: an independent
   * root request waits behind the active transaction instead of being sent
   * without its transaction ID. Keep this off in ordinary fault fixtures so
   * an accidental repository escape still fails immediately.
   */
  deferRootRequestsDuringTransaction?: boolean;
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
  private transactionReleased: Promise<void> | null = null;
  private releaseTransaction: (() => void) | null = null;
  private nextTransactionId = 1;
  private migrationsApplied = 0;
  private nextExecuteFault:
    | {
        matches: (sql: string, parameters: readonly unknown[]) => boolean;
        error: Error;
      }
    | null = null;
  private nextQueryFault:
    | {
        matches: (sql: string, parameters: readonly unknown[]) => boolean;
        error: Error;
      }
    | null = null;

  constructor(
    readonly databasePath: string,
    initialize = true,
    private readonly profile: FileBackedSqliteProfile = 'runtime',
    private readonly options: FileBackedSqliteGatewayOptions = {},
  ) {
    this.database = new DatabaseSync(databasePath);
    if (!initialize) return;
    if (profile === 'product') {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
      `);
      this.migrationsApplied = applyProductMigrations(this.database);
      return;
    }
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

  client(): DbClient {
    return createDatabaseClient(this);
  }

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return {
      path: this.databasePath,
      journalMode: 'wal',
      migrationsApplied:
        this.profile === 'product'
          ? this.migrationsApplied
          : runtimeMigrationSql().length > 0
            ? 1
            : 0,
    };
  }

  async execute(
    sql: string,
    parameters: readonly unknown[] = [],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult> {
    await this.awaitTransactionAccess(transactionId);
    if (this.nextExecuteFault?.matches(sql, parameters)) {
      const { error } = this.nextExecuteFault;
      this.nextExecuteFault = null;
      throw error;
    }
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
    await this.awaitTransactionAccess(transactionId);
    if (this.nextQueryFault?.matches(sql, parameters)) {
      const { error } = this.nextQueryFault;
      this.nextQueryFault = null;
      throw error;
    }
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
    this.transactionReleased = new Promise<void>((resolve) => {
      this.releaseTransaction = resolve;
    });
    return { id };
  }

  async commit(transactionId: string): Promise<void> {
    this.requireOwner(transactionId);
    this.database.exec('COMMIT');
    this.activeTransaction = null;
    this.releaseTransactionWaiters();
  }

  async rollback(transactionId: string): Promise<void> {
    this.requireOwner(transactionId);
    this.database.exec('ROLLBACK');
    this.activeTransaction = null;
    this.releaseTransactionWaiters();
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

  /** One-shot deterministic fault used only by headless transaction tests. */
  failNextExecute(
    matches: (sql: string, parameters: readonly unknown[]) => boolean,
    message = 'injected acceptance execute failure',
  ): void {
    this.nextExecuteFault = { matches, error: new Error(message) };
  }

  /** Query/RETURNING companion to `failNextExecute` for transaction acceptance. */
  failNextQuery(
    matches: (sql: string, parameters: readonly unknown[]) => boolean,
    message = 'injected acceptance query failure',
  ): void {
    this.nextQueryFault = { matches, error: new Error(message) };
  }

  private async awaitTransactionAccess(transactionId?: string): Promise<void> {
    if (transactionId !== undefined) {
      this.requireOwner(transactionId);
      return;
    }
    while (this.activeTransaction) {
      if (!this.options.deferRootRequestsDuringTransaction) {
        throw new Error('acceptance query escaped active transaction');
      }
      const released = this.transactionReleased;
      if (!released) {
        throw new Error('acceptance transaction wait state is unavailable');
      }
      await released;
    }
  }

  private releaseTransactionWaiters(): void {
    const release = this.releaseTransaction;
    this.releaseTransaction = null;
    this.transactionReleased = null;
    release?.();
  }

  private requireOwner(transactionId: string): void {
    if (this.activeTransaction !== transactionId) {
      throw new Error(
        `transaction ${transactionId} does not own the acceptance database`,
      );
    }
  }
}

/**
 * Real product-schema variant used by end-to-end renderer acceptance. Unlike
 * the narrower P3 receipt fixture, this applies every checked-in migration so
 * default repositories and renderer dispatchers can run without table mocks.
 */
export class ProductFileBackedSqliteGateway extends P3FileBackedSqliteGateway {
  constructor(
    databasePath: string,
    initialize = true,
    options: FileBackedSqliteGatewayOptions = {},
  ) {
    super(databasePath, initialize, 'product', options);
  }
}
