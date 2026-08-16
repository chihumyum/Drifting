import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const CURRENT_BASELINE = new URL(
  '0000_local_first_baseline.sql',
  DRIZZLE_DIRECTORY,
);

/**
 * Runtime acceptance uses the same complete schema as a fresh product
 * database. Keeping a smaller hand-maintained Agent fixture would allow its
 * constraints and foreign keys to drift away from the product baseline.
 */
function currentBaselineSql(): string {
  return readFileSync(CURRENT_BASELINE, 'utf8').replaceAll(
    '--> statement-breakpoint',
    '',
  );
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

  let previousWhen = -1;
  journal.entries.forEach((entry, expectedIndex) => {
    if (!Number.isSafeInteger(entry.idx) || entry.idx !== expectedIndex) {
      throw new Error(
        `Product migration journal index mismatch at ${entry.tag}: expected ${expectedIndex}, found ${entry.idx}.`,
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
    previousWhen = entry.when;
  });
  return journal;
}

function resetRequired(detail: string): Error {
  return new Error(
    `Local database schema history does not match this Drifting build (${detail}); reset this pre-release local database before reopening it.`,
  );
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
    const applicationTables = database
      .prepare(`
        SELECT count(*) AS count
        FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> '__drizzle_migrations'
      `)
      .get() as { count: number };
    const appliedMigrations = database
      .prepare(
        'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC',
      )
      .all() as Array<{ hash: string; created_at: number }>;

    if (appliedMigrations.length === 0 && applicationTables.count > 0) {
      throw resetRequired(
        'application tables exist without the current migration baseline',
      );
    }
    for (let index = 1; index < appliedMigrations.length; index += 1) {
      if (
        Number(appliedMigrations[index - 1]!.created_at) >=
        Number(appliedMigrations[index]!.created_at)
      ) {
        throw resetRequired('migration timestamps are duplicated or out of order');
      }
    }

    const knownPrefixLength = Math.min(
      appliedMigrations.length,
      journal.entries.length,
    );
    for (let index = 0; index < knownPrefixLength; index += 1) {
      const applied = appliedMigrations[index]!;
      const expected = journal.entries[index]!;
      const bytes = readFileSync(
        new URL(`${expected.tag}.sql`, DRIZZLE_DIRECTORY),
      );
      const expectedHash = createHash('sha256').update(bytes).digest('hex');
      if (
        Number(applied.created_at) !== expected.when ||
        applied.hash !== expectedHash
      ) {
        throw resetRequired(
          `migration ${expected.tag} is not the expected journal prefix`,
        );
      }
    }

    if (appliedMigrations.length > journal.entries.length) {
      const lastWhen = Number(
        appliedMigrations[appliedMigrations.length - 1]!.created_at,
      );
      const latestEmbedded =
        journal.entries[journal.entries.length - 1]?.when ?? 0;
      if (lastWhen > latestEmbedded) {
        throw new Error(
          `Product database schema is newer than this checkout (${lastWhen} > ${latestEmbedded}).`,
        );
      }
      throw resetRequired('migration history contains a non-prefix entry');
    }

    const record = database.prepare(
      'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
    );
    let applied = 0;
    for (const entry of journal.entries.slice(appliedMigrations.length)) {
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
      PRAGMA foreign_keys = OFF;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
    this.database.exec(currentBaselineSql());
    this.database.exec('PRAGMA foreign_keys = ON');
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
        this.profile === 'product' ? this.migrationsApplied : 1,
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
