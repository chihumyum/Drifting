import { describe, expect, it, vi } from 'vitest';
import {
  createDatabasePlatform,
  DatabaseOpenFailure,
  decodeDatabaseValue,
  encodeDatabaseParameters,
  encodeDatabaseValue,
} from './database';

describe('Tauri database value codec', () => {
  it('encodes every supported SQLite storage class', () => {
    const backing = Uint8Array.from([99, 1, 2, 3, 88]);
    const arrayBuffer = Uint8Array.from([4, 5]).buffer;

    expect(
      encodeDatabaseParameters([
        null,
        42,
        -3.25,
        'text',
        backing.subarray(1, 4),
        arrayBuffer,
        9_223_372_036_854_775_807n,
      ]),
    ).toEqual([
      { type: 'null' },
      { type: 'integer', value: '42' },
      { type: 'real', value: -3.25 },
      { type: 'text', value: 'text' },
      { type: 'blob', value: [1, 2, 3] },
      { type: 'blob', value: [4, 5] },
      { type: 'integer', value: '9223372036854775807' },
    ]);
  });

  it('rejects values that JSON or SQLite cannot represent safely', () => {
    expect(() => encodeDatabaseValue(Number.MAX_SAFE_INTEGER + 1)).toThrow(/bigint/);
    expect(() => encodeDatabaseValue(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => encodeDatabaseValue(Number.NaN)).toThrow(/finite/);
    expect(() => encodeDatabaseValue(9_223_372_036_854_775_808n)).toThrow(/64-bit/);
    expect(() => encodeDatabaseValue(undefined)).toThrow(/unsupported/);
    expect(() => encodeDatabaseValue(true)).toThrow(/unsupported/);
  });

  it('decodes safe integers as numbers and preserves larger i64 values as bigint', () => {
    expect(decodeDatabaseValue({ type: 'integer', value: '42' })).toBe(42);
    expect(decodeDatabaseValue({ type: 'integer', value: '9223372036854775807' })).toBe(
      9_223_372_036_854_775_807n,
    );
    expect(decodeDatabaseValue({ type: 'blob', value: [0, 127, 255] })).toEqual(
      Uint8Array.from([0, 127, 255]),
    );
    expect(() => decodeDatabaseValue({ type: 'integer', value: '01' })).toThrow(/canonical/);
    expect(() => decodeDatabaseValue({ type: 'blob', value: [256] })).toThrow(/255/);
  });
});

describe('Tauri database command adapter', () => {
  it('sends tagged parameters and preserves the native two-dimensional row order', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe('database_query');
      expect(args).toEqual({
        sql: 'SELECT ?, ?',
        parameters: [
          { type: 'integer', value: '7' },
          { type: 'blob', value: [1, 2] },
        ],
        transactionId: '12',
        clientSessionId: 'test-renderer-session',
      });
      return {
        columns: ['integer_value', 'blob_value'],
        rows: [
          [
            { type: 'integer', value: '7' },
            { type: 'blob', value: [1, 2] },
          ],
        ],
      };
    });
    const database = createDatabasePlatform(invoke, 'test-renderer-session');

    await expect(
      database.query('SELECT ?, ?', [7, Uint8Array.from([1, 2])], '12'),
    ).resolves.toEqual({
      columns: ['integer_value', 'blob_value'],
      rows: [[7, Uint8Array.from([1, 2])]],
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects malformed native rows instead of silently reordering or truncating them', async () => {
    const database = createDatabasePlatform(async () => ({
      columns: ['a', 'b'],
      rows: [[{ type: 'integer', value: '1' }]],
    }));

    await expect(database.query('SELECT 1')).rejects.toThrow(/1 values for 2 columns/);
  });

  it('makes stale transaction recovery an explicit renderer-session open contract', async () => {
    const invoke = vi.fn(async () => ({
      path: '/tmp/drifting.db',
      journalMode: 'wal',
      migrationsApplied: 0,
    }));
    const database = createDatabasePlatform(invoke, 'fresh-renderer-session');

    await database.open('account.db', { recoverStaleTransaction: true });
    await database.open('account.db');

    expect(invoke).toHaveBeenNthCalledWith(1, 'database_open', {
      databaseName: 'account.db',
      clientSessionId: 'fresh-renderer-session',
      recoverStaleTransaction: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'database_open', {
      databaseName: 'account.db',
      clientSessionId: 'fresh-renderer-session',
      recoverStaleTransaction: false,
    });
  });

  it('projects structured migration failures and keeps recovery commands session-bound', async () => {
    const failure = {
      code: 'integrity-check-failed',
      message: 'candidate was not activated',
      recoverySessionId: '0123456789abcdef',
      sourceVersion: '0.1.0-alpha.1',
      targetVersion: '0.1.0-alpha.2',
      safetyBackup: {
        backupId: 'backup-safe',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
        createdAtMs: 123,
      },
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === 'database_open') throw failure;
      return { path: '/managed/drifting.db', journalMode: 'wal', migrationsApplied: 1 };
    });
    const database = createDatabasePlatform(invoke, 'recovery-renderer');

    await expect(database.open('drifting.db')).rejects.toMatchObject({
      name: 'DatabaseOpenFailure',
      code: 'integrity-check-failed',
      recoverySessionId: '0123456789abcdef',
      safetyBackup: { backupId: 'backup-safe', sizeBytes: 42 },
    });
    await database.retryMigration('0123456789abcdef');
    expect(invoke).toHaveBeenLastCalledWith('database_recovery_retry', {
      recoverySessionId: '0123456789abcdef',
      clientSessionId: 'recovery-renderer',
    });
    expect(new DatabaseOpenFailure(failure)).toBeInstanceOf(Error);
  });
});
