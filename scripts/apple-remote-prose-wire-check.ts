import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';

const option = (name: string) => {
  const value = process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  assert(value, `${name} is required`);
  return path.resolve(value);
};
const input = option('--input');
const output = option('--output');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
interface Delivery {
  encodedBase64: string;
  clock: { nowMs: number; nowIso: string };
  identity: { installationId: string; writerId: string; writerEpoch: string };
  expectedStatus: 'applied' | 'duplicate';
}
interface WireCase {
  name: string;
  beforeDatabase: string;
  afterDatabase: string;
  deliveries: Delivery[];
  documentIds: string[];
}
interface WireFixture { schemaVersion: number; cases: WireCase[] }

// Repository append timestamps use Date(), independently of the explicit
// journal clock. Compare their data and provenance, not execution wall time.
const wallClockColumns: Record<string, string[]> = {
  yjs_updates: ['created_at'],
  yjs_document_revision: ['updated_at'],
  yjs_document_revision_provenance: ['created_at'],
};
const comparedTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt',
  'sync_yjs_materialization_receipt', 'sync_generation_writer_state',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision',
  'yjs_document_revision_provenance', 'node_content',
] as const;

function databasePath(name: string): string {
  assert.equal(path.basename(name), name, 'Fixture databases must be sibling files');
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/u);
  return path.join(path.dirname(input), name);
}

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { hex: Buffer.from(value).toString('hex') };
  if (typeof value === 'bigint') {
    assert(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER));
    return Number(value);
  }
  return value;
}

function tableRows(database: DatabaseSync, table: typeof comparedTables[number]): Row[] {
  const rows = database.prepare(`SELECT * FROM "${table}"`).all();
  return rows.map(row => Object.fromEntries(Object.entries(row).flatMap(([key, value]) => {
    if (wallClockColumns[table]?.includes(key)) {
      assert.equal(typeof value, 'string', `${table}.${key} must remain a timestamp`);
      assert(Number.isFinite(Date.parse(value as string)), `${table}.${key} must be parseable`);
      return [];
    }
    if (table === 'node_content' && key === 'content_json') {
      assert.equal(typeof value, 'string');
      return [[key, JSON.parse(value as string) as unknown]];
    }
    return [[key, normalize(value)]];
  }))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function rows(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): Row[] {
  return database.prepare(sql).all(...parameters);
}

function readDocument(database: DatabaseSync, documentId: string): Y.Doc {
  const document = new Y.Doc();
  try {
    const snapshots = rows(database, 'SELECT state_blob FROM yjs_snapshots WHERE document_id = ?', documentId);
    assert(snapshots.length <= 1);
    for (const row of snapshots) {
      assert(row.state_blob instanceof Uint8Array);
      Y.applyUpdate(document, row.state_blob);
    }
    for (const row of rows(database, 'SELECT update_blob FROM yjs_updates WHERE document_id = ? ORDER BY id', documentId)) {
      assert(row.update_blob instanceof Uint8Array);
      Y.applyUpdate(document, row.update_blob);
    }
    assert.equal(document.store.pendingStructs, null, 'Fixture leaves unresolved Yjs structs');
    assert.equal(document.store.pendingDs, null, 'Fixture leaves unresolved Yjs deletes');
    return document;
  } catch (error) {
    document.destroy();
    throw error;
  }
}

async function verify(fixture: WireCase, index: number) {
  assert(fixture.name.length > 0);
  assert(fixture.deliveries.length > 0);
  assert(fixture.documentIds.length > 0);
  assert.equal(new Set(fixture.documentIds).size, fixture.documentIds.length);
  const beforePath = databasePath(fixture.beforeDatabase);
  const afterPath = databasePath(fixture.afterDatabase);
  const receiverDirectory = mkdtempSync(path.join(path.dirname(output), `remote-prose-receiver-${index}-`));
  const receiverPath = path.join(receiverDirectory, 'receiver.db');
  copyFileSync(beforePath, receiverPath);
  const gateway = new ProductFileBackedSqliteGateway(receiverPath);
  const expected = new DatabaseSync(afterPath, { readOnly: true });
  const deliveries = [];
  try {
    for (const delivery of fixture.deliveries) {
      assert(['applied', 'duplicate'].includes(delivery.expectedStatus));
      const bytes = Uint8Array.from(Buffer.from(delivery.encodedBase64, 'base64'));
      const decoded = await decodeSyncChangeSetV1(bytes);
      assert(decoded.ok, 'Native incoming original must pass the production protocol decoder');
      assert.deepEqual(encodeSyncChangeSetV1(decoded.value), bytes, 'Original bytes must be canonical');
      assert(decoded.value.mutations.every(mutation => mutation.action === 'yjs.update'));
      for (const mutation of decoded.value.mutations) {
        assert(fixture.documentIds.includes(mutation.target.id));
        assert(parseYjsUpdatePayload(mutation.payload).update.length > 0);
      }
      const before = Object.fromEntries(comparedTables.map(table => [table, tableRows(gateway.database, table)]));
      const beforeChanges = rows(gateway.database, 'SELECT total_changes() AS count');
      const applied = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet: decoded.value,
        clock: delivery.clock,
        identity: {
          installationId: delivery.identity.installationId,
          createWriterIdentity: () => ({ writerId: delivery.identity.writerId, writerEpoch: delivery.identity.writerEpoch }),
        },
        kernel: productionSyncDomainMaterializationKernel,
      }));
      assert.equal(applied.status, delivery.expectedStatus);
      assert.deepEqual(applied.conflicts, [], 'Pure prose originals must materialize without suppression');
      if (applied.status === 'duplicate') {
        assert.deepEqual(rows(gateway.database, 'SELECT total_changes() AS count'), beforeChanges,
          'A duplicate must perform no SQL mutation, including excluded wall-clock fields');
        assert.deepEqual(Object.fromEntries(comparedTables.map(table => [table, tableRows(gateway.database, table)])), before,
          'Duplicate receipt must not append prose, rewrite cache or advance HLC');
      }
      deliveries.push({ changeSetId: decoded.value.changeSetId, envelopeSha256: sha(bytes),
        mutationCount: decoded.value.mutations.length, status: applied.status });
    }
    const tables = comparedTables.map(table => {
      const actualRows = tableRows(gateway.database, table);
      const expectedRows = tableRows(expected, table);
      assert.deepEqual(actualRows, expectedRows, `Rust and production TS differ in ${table}`);
      return { name: table, rows: actualRows.length, sha256: sha(JSON.stringify(actualRows)) };
    });
    const documents = fixture.documentIds.map(documentId => {
      const actual = readDocument(gateway.database, documentId);
      const native = readDocument(expected, documentId);
      try {
        assert.deepEqual(Y.encodeStateAsUpdate(actual), Y.encodeStateAsUpdate(native), 'Independent Yjs replay differs');
        assert(documentId.startsWith('node-content:'), 'This slice only certifies chapter prose');
        const cache = rows(expected, 'SELECT content_json FROM node_content WHERE node_id = ?', documentId.slice('node-content:'.length));
        assert.equal(cache.length, 1);
        assert.equal(typeof cache[0]!.content_json, 'string');
        assert.deepEqual(JSON.parse(cache[0]!.content_json as string), yDocToProsemirrorJSON(actual, 'default'),
          'Native semantic cache must describe authoritative replayed prose');
        return { documentId, stateSha256: sha(Y.encodeStateAsUpdate(actual)), semanticCache: 'passed' };
      } finally { actual.destroy(); native.destroy(); }
    });
    return { name: fixture.name, status: 'passed', beforeDatabaseSha256: sha(readFileSync(beforePath)),
      afterDatabaseSha256: sha(readFileSync(afterPath)), deliveries, tables, documents };
  } finally {
    expected.close();
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}

async function main() {
  const fixture = JSON.parse(readFileSync(input, 'utf8')) as WireFixture;
  assert.equal(fixture.schemaVersion, 1);
  assert(fixture.cases.length > 0);
  assert.equal(new Set(fixture.cases.map(item => item.name)).size, fixture.cases.length);
  mkdirSync(path.dirname(output), { recursive: true });
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  assert(cases.some(item => item.deliveries.some(delivery => delivery.status === 'applied')));
  assert(cases.some(item => item.deliveries.some(delivery => delivery.status === 'duplicate')));
  const report = { schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    scope: 'Actual canonical Rust incoming originals replayed through production TS stage, reducer materialization and completion against copies of real native SQLite baselines.',
    excludedWallClockColumns: wallClockColumns,
    boundaries: 'Compares exact original/mutation/receipts/revision/provenance/HLC and authoritative prose/cache. Does not certify provider transport, live editor notification, physical input or release.',
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, deliveries: cases.reduce((sum, item) => sum + item.deliveries.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
