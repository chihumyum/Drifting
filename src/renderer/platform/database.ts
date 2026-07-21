import { invoke } from '@tauri-apps/api/core';

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type DatabaseWireValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; value: number[] };

export type DatabaseValue = null | number | bigint | string | Uint8Array;
export type TransactionBehavior = 'deferred' | 'immediate' | 'exclusive';

export interface DatabaseOpenResult {
  path: string;
  journalMode: string;
  migrationsApplied: number;
}

export interface DatabaseExecuteResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DatabaseQueryResult {
  columns: string[];
  rows: DatabaseValue[][];
}

export interface DatabaseCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}

export interface DatabaseTransaction {
  id: string;
}

export interface DatabaseOpenOptions {
  /**
   * Allow a newly-created renderer session to take over the native database
   * lease and roll back a transaction left by the previous renderer.
   */
  recoverStaleTransaction?: boolean;
}

export interface DatabasePlatformApi {
  open(databaseName: string, options?: DatabaseOpenOptions): Promise<DatabaseOpenResult>;
  execute(
    sql: string,
    parameters?: readonly unknown[],
    transactionId?: string,
  ): Promise<DatabaseExecuteResult>;
  query(
    sql: string,
    parameters?: readonly unknown[],
    transactionId?: string,
  ): Promise<DatabaseQueryResult>;
  begin(behavior?: TransactionBehavior): Promise<DatabaseTransaction>;
  commit(transactionId: string): Promise<void>;
  rollback(transactionId: string): Promise<void>;
  checkpoint(): Promise<DatabaseCheckpointResult>;
  close(): Promise<void>;
}

export type DatabaseCommandInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return Object.prototype.toString.call(value);
}

function assertI64(value: bigint, label: string): bigint {
  if (value < I64_MIN || value > I64_MAX) {
    throw new RangeError(`${label} is outside SQLite's signed 64-bit integer range`);
  }
  return value;
}

function parseInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal integer string`);
  }
  return assertI64(BigInt(value), label);
}

function parseTransactionId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError('database transaction ID must be an unsigned decimal string');
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > U64_MAX) {
    throw new RangeError('database transaction ID is outside the valid u64 range');
  }
  return value;
}

function createClientSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseClientSessionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('database client session ID must be 1-128 URL-safe ASCII characters');
  }
  return value;
}

function safeIntegerResult(value: bigint): number | bigint {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function byteArray(value: unknown, label: string): Uint8Array {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a byte array`);
  const bytes = value.map((byte, index) => {
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new RangeError(`${label}[${index}] must be an integer between 0 and 255`);
    }
    return byte;
  });
  return Uint8Array.from(bytes);
}

/** Encode one Drizzle driver parameter into the tagged Rust IPC format. */
export function encodeDatabaseValue(value: unknown): DatabaseWireValue {
  if (value === null) return { type: 'null' };

  if (typeof value === 'bigint') {
    return { type: 'integer', value: assertI64(value, 'database bigint parameter').toString() };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('database number parameter must be finite');
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(
          'database integer parameter is not safe in JavaScript; pass it as bigint instead',
        );
      }
      return { type: 'integer', value: BigInt(value).toString() };
    }
    return { type: 'real', value };
  }

  if (typeof value === 'string') return { type: 'text', value };

  if (value instanceof Uint8Array) {
    return { type: 'blob', value: Array.from(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { type: 'blob', value: Array.from(new Uint8Array(value)) };
  }

  throw new TypeError(`unsupported database parameter: ${describeValue(value)}`);
}

export function encodeDatabaseParameters(values: readonly unknown[] = []): DatabaseWireValue[] {
  return values.map(encodeDatabaseValue);
}

/** Decode one tagged Rust SQLite value without losing i64 precision. */
export function decodeDatabaseValue(value: unknown): DatabaseValue {
  const wire = record(value, 'database value');
  const type = stringField(wire.type, 'database value type');

  switch (type) {
    case 'null':
      return null;
    case 'integer':
      return safeIntegerResult(parseInteger(wire.value, 'database integer result'));
    case 'real':
      if (typeof wire.value !== 'number' || !Number.isFinite(wire.value)) {
        throw new RangeError('database real result must be finite');
      }
      return wire.value;
    case 'text':
      return stringField(wire.value, 'database text result');
    case 'blob':
      return byteArray(wire.value, 'database blob result');
    default:
      throw new TypeError(`unknown database value type: ${type}`);
  }
}

function decodeQueryResult(value: unknown): DatabaseQueryResult {
  const result = record(value, 'database query result');
  if (
    !Array.isArray(result.columns) ||
    !result.columns.every((column) => typeof column === 'string')
  ) {
    throw new TypeError('database query columns must be an array of strings');
  }
  if (!Array.isArray(result.rows)) throw new TypeError('database query rows must be an array');

  const columns = [...result.columns] as string[];
  const rows = result.rows.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow)) {
      throw new TypeError(`database query row ${rowIndex} must be an array`);
    }
    if (rawRow.length !== columns.length) {
      throw new RangeError(
        `database query row ${rowIndex} has ${rawRow.length} values for ${columns.length} columns`,
      );
    }
    return rawRow.map(decodeDatabaseValue);
  });

  return { columns, rows };
}

export function createDatabasePlatform(
  invokeCommand: DatabaseCommandInvoker,
  clientSessionId = createClientSessionId(),
): DatabasePlatformApi {
  const sessionId = parseClientSessionId(clientSessionId);

  return {
    async open(databaseName, options) {
      const raw = record(
        await invokeCommand('database_open', {
          databaseName,
          clientSessionId: sessionId,
          recoverStaleTransaction: options?.recoverStaleTransaction ?? false,
        }),
        'database open result',
      );
      return {
        path: stringField(raw.path, 'database path'),
        journalMode: stringField(raw.journalMode, 'database journal mode'),
        migrationsApplied: safeCount(raw.migrationsApplied, 'database migration count'),
      };
    },

    async execute(sql, parameters = [], transactionId) {
      if (transactionId !== undefined) parseTransactionId(transactionId);
      const raw = record(
        await invokeCommand('database_execute', {
          sql,
          parameters: encodeDatabaseParameters(parameters),
          transactionId,
          clientSessionId: sessionId,
        }),
        'database execute result',
      );
      const lastInsertRowid = decodeDatabaseValue(raw.lastInsertRowid);
      if (typeof lastInsertRowid !== 'number' && typeof lastInsertRowid !== 'bigint') {
        throw new TypeError('database last insert row ID must be an integer');
      }
      return {
        changes: safeCount(raw.changes, 'database change count'),
        lastInsertRowid,
      };
    },

    async query(sql, parameters = [], transactionId) {
      if (transactionId !== undefined) parseTransactionId(transactionId);
      return decodeQueryResult(
        await invokeCommand('database_query', {
          sql,
          parameters: encodeDatabaseParameters(parameters),
          transactionId,
          clientSessionId: sessionId,
        }),
      );
    },

    async begin(behavior = 'deferred') {
      const raw = record(
        await invokeCommand('database_begin', { behavior, clientSessionId: sessionId }),
        'database transaction',
      );
      return { id: parseTransactionId(raw.id) };
    },

    async commit(transactionId) {
      await invokeCommand('database_commit', {
        transactionId: parseTransactionId(transactionId),
        clientSessionId: sessionId,
      });
    },

    async rollback(transactionId) {
      await invokeCommand('database_rollback', {
        transactionId: parseTransactionId(transactionId),
        clientSessionId: sessionId,
      });
    },

    async checkpoint() {
      const raw = record(
        await invokeCommand('database_checkpoint', { clientSessionId: sessionId }),
        'database checkpoint result',
      );
      return {
        busy: safeCount(raw.busy, 'database checkpoint busy count'),
        logFrames: safeCount(raw.logFrames, 'database checkpoint log frame count'),
        checkpointedFrames: safeCount(
          raw.checkpointedFrames,
          'database checkpoint completed frame count',
        ),
      };
    },

    async close() {
      await invokeCommand('database_close', { clientSessionId: sessionId });
    },
  };
}

export const databasePlatform = createDatabasePlatform((command, args) =>
  invoke<unknown>(command, args),
);
