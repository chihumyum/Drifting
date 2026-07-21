import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseCheckpointResult,
  DatabaseExecuteResult,
  DatabaseOpenResult,
  DatabasePlatformApi,
  DatabaseQueryResult,
  DatabaseTransaction,
  TransactionBehavior,
} from '../platform/database';
import { createDatabaseClient } from './db';

type Call =
  | { type: 'begin'; behavior: TransactionBehavior | undefined; id: string }
  | { type: 'execute'; sql: string; transactionId: string | undefined }
  | { type: 'commit'; id: string }
  | { type: 'rollback'; id: string };

class FakeDatabase implements DatabasePlatformApi {
  readonly calls: Call[] = [];
  private nextTransactionId = 1;

  async open(_databaseName: string): Promise<DatabaseOpenResult> {
    return { path: '/tmp/fake.db', journalMode: 'wal', migrationsApplied: 0 };
  }

  async execute(
    statement: string,
    _parameters?: readonly unknown[],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult> {
    this.calls.push({ type: 'execute', sql: statement, transactionId });
    return { changes: 1, lastInsertRowid: 1 };
  }

  async query(
    _statement: string,
    _parameters?: readonly unknown[],
    _transactionId?: string,
  ): Promise<DatabaseQueryResult> {
    return { columns: [], rows: [] };
  }

  async begin(behavior?: TransactionBehavior): Promise<DatabaseTransaction> {
    const id = String(this.nextTransactionId++);
    this.calls.push({ type: 'begin', behavior, id });
    return { id };
  }

  async commit(transactionId: string): Promise<void> {
    this.calls.push({ type: 'commit', id: transactionId });
  }

  async rollback(transactionId: string): Promise<void> {
    this.calls.push({ type: 'rollback', id: transactionId });
  }

  async checkpoint(): Promise<DatabaseCheckpointResult> {
    return { busy: 0, logFrames: 0, checkpointedFrames: 0 };
  }

  async close(): Promise<void> {}
}

describe('Drizzle Tauri transaction binding', () => {
  it('uses the gateway transaction ID and never emits raw top-level transaction SQL', async () => {
    const gateway = new FakeDatabase();
    const database = createDatabaseClient(gateway);

    await database.transaction(
      async (transaction) => {
        await transaction.run(sql.raw("INSERT INTO events VALUES ('one')"));
      },
      { behavior: 'immediate' },
    );

    expect(gateway.calls).toEqual([
      { type: 'begin', behavior: 'immediate', id: '1' },
      {
        type: 'execute',
        sql: "INSERT INTO events VALUES ('one')",
        transactionId: '1',
      },
      { type: 'commit', id: '1' },
    ]);
    expect(
      gateway.calls.some(
        (call) => call.type === 'execute' && /^(?:BEGIN|COMMIT|ROLLBACK)$/i.test(call.sql),
      ),
    ).toBe(false);
  });

  it('rolls back the owning gateway transaction when the callback fails', async () => {
    const gateway = new FakeDatabase();
    const database = createDatabaseClient(gateway);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.run(sql.raw("INSERT INTO events VALUES ('fail')"));
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');

    expect(gateway.calls[gateway.calls.length - 1]).toEqual({ type: 'rollback', id: '1' });
    expect(gateway.calls.some((call) => call.type === 'commit')).toBe(false);
  });

  it('serializes concurrent top-level transactions before asking Rust to begin', async () => {
    const gateway = new FakeDatabase();
    const database = createDatabaseClient(gateway);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = database.transaction(async (transaction) => {
      await transaction.run(sql.raw("INSERT INTO events VALUES ('first')"));
      await firstGate;
    });
    const second = database.transaction(async (transaction) => {
      await transaction.run(sql.raw("INSERT INTO events VALUES ('second')"));
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(gateway.calls.filter((call) => call.type === 'begin')).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(gateway.calls.map((call) => call.type)).toEqual([
      'begin',
      'execute',
      'commit',
      'begin',
      'execute',
      'commit',
    ]);
  });

  it('implements nested Drizzle transactions with transaction-bound savepoints', async () => {
    const gateway = new FakeDatabase();
    const database = createDatabaseClient(gateway);

    await database.transaction(async (transaction) => {
      await transaction.transaction(async (nested) => {
        await nested.run(sql.raw("INSERT INTO events VALUES ('nested')"));
      });
    });

    expect(gateway.calls).toEqual([
      { type: 'begin', behavior: undefined, id: '1' },
      { type: 'execute', sql: 'SAVEPOINT drifting_sp_0', transactionId: '1' },
      {
        type: 'execute',
        sql: "INSERT INTO events VALUES ('nested')",
        transactionId: '1',
      },
      { type: 'execute', sql: 'RELEASE SAVEPOINT drifting_sp_0', transactionId: '1' },
      { type: 'commit', id: '1' },
    ]);
  });
});
