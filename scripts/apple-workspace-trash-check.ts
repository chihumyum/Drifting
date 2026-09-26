// Local native lifecycle originals replayed by the production TS reducer.
// Local authoring and remote materialization have deliberately different lanes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
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
const input = option('--input'), output = option('--output');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const tables = [
  'project', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
const wallClockColumns: Record<string, string[]> = {
  yjs_updates: ['created_at'], yjs_document_revision: ['updated_at'],
  yjs_document_revision_provenance: ['created_at'], yjs_snapshots: ['updated_at'],
};
interface Step {
  operation: 'trash' | 'restore';
  encodedBase64: string;
  mutationCount: number;
  createdAt: string;
  afterDatabase: string;
  faultBeforeApply: boolean;
}
interface Case {
  name: string;
  beforeDatabase: string;
  projectId: string;
  chapterId: string;
  documentId: string;
  identity: { installationId: string; writerId: string; writerEpoch: string };
  steps: Step[];
}
type Row = Record<string, unknown>;
function database(name: string): string {
  assert.equal(path.basename(name), name);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/u);
  return path.join(path.dirname(input), name);
}
function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { hex: Buffer.from(value).toString('hex') };
  if (typeof value === 'bigint') {
    assert(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER));
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
function raw(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}
function canonicalRows(values: Row[]): Row[] {
  return values.map(row => normalize(row) as Row).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries([...tables, 'sync_generation_writer_state'].map(table => [table, canonicalRows(raw(db, table))]));
}
function checkEqual(table: string, actual: Row[], expected: Row[]) {
  if (isDeepStrictEqual(actual, expected)) return;
  const index = actual.findIndex((row, i) => !isDeepStrictEqual(row, expected[i]));
  const summary = (value: unknown) => {
    const text = JSON.stringify(value) ?? 'undefined';
    return text.length > 1000 ? `${text.slice(0, 900)}… sha256:${sha(text)}` : text;
  };
  assert.fail(`${table} parity failed (${actual.length}/${expected.length} rows): `
    + `${summary(actual[index])} / ${summary(expected[index])}`);
}
function fullState(db: DatabaseSync, docId: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    const stored = db.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id=?').get(docId);
    if (stored) {
      assert(stored.state_blob instanceof Uint8Array);
      Y.applyUpdate(doc, stored.state_blob);
    }
    for (const row of db.prepare('SELECT update_blob FROM yjs_updates WHERE document_id=? ORDER BY id').all(docId)) {
      assert(row.update_blob instanceof Uint8Array); Y.applyUpdate(doc, row.update_blob);
    }
    assert.equal(doc.store.pendingStructs, null); assert.equal(doc.store.pendingDs, null);
    assert(doc.getXmlFragment('default').length > 0, 'Use actual native editor XML');
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}
function causedByFault(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error.message.includes('synthetic chapter lifecycle receipt fault')) return true;
    error = (error as Error & { cause?: unknown }).cause;
  }
  return false;
}

async function verify(fixture: Case, ordinal: number) {
  const temporary = mkdtempSync(path.join(path.dirname(output), `trash-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const originalIds = new Set<string>();
  const restoredRevisions = new Set<number>();
  const restoredDocuments = new Map<string, { nativeTimestamp: string; remoteTimestamp: string }>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const steps = [];
  try {
    for (const step of fixture.steps) {
      const bytes = Uint8Array.from(Buffer.from(step.encodedBase64, 'base64'));
      const decoded = await decodeSyncChangeSetV1(bytes);
      assert(decoded.ok, 'Actual native original must decode through production protocol');
      const changeSet = decoded.value;
      assert.deepEqual(encodeSyncChangeSetV1(changeSet), bytes);
      assert.equal(changeSet.projectId, fixture.projectId);
      assert.equal(changeSet.mutations.length, step.mutationCount);
      const actions = changeSet.mutations.map(mutation => mutation.action);
      assert.deepEqual(actions, step.operation === 'trash'
        ? ['entity.trash'] : ['entity.restore', 'tuple.set', 'field.set', 'yjs.update']);
      const incarnation = changeSet.mutations[0]!.target.incarnation;
      assert(changeSet.mutations.every(mutation => mutation.target.incarnation === incarnation));
      assert.equal(changeSet.mutations[0]!.target.id, fixture.chapterId);
      const expected = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      try {
        const context = { changeSet, clock: { nowMs: Date.parse(step.createdAt), nowIso: step.createdAt },
          identity: { installationId: fixture.identity.installationId,
            createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) },
          kernel: productionSyncDomainMaterializationKernel };
        const before = snapshot(gateway.database);
        if (step.faultBeforeApply) {
          gateway.database.exec("CREATE TRIGGER fail_chapter_trash_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic chapter lifecycle receipt fault'); END");
          await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
          assert.deepEqual(snapshot(gateway.database), before, 'Receipt failure must roll back the complete reducer transaction');
          gateway.database.exec('DROP TRIGGER fail_chapter_trash_receipt');
        }
        const result = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(result.status, 'applied');
        assert.deepEqual(result.conflicts, [], 'Lifecycle original must materialize without suppression');
        originalIds.add(changeSet.changeSetId);
        if (step.operation === 'restore') {
          const prose = changeSet.mutations[3]!;
          assert.equal(prose.target.id, fixture.documentId);
          assert.deepEqual(changeSet.mutations[1]!.payload, { tuple: 'graph.position', value: {
            x: expected.prepare('SELECT position_x FROM book_node WHERE id=?').get(fixture.chapterId)!.position_x,
            y: expected.prepare('SELECT position_y FROM book_node WHERE id=?').get(fixture.chapterId)!.position_y,
          } });
          assert.deepEqual(changeSet.mutations[2]!.payload, { field: 'storylineId', value: null });
          const isolated = new Y.Doc();
          try {
            Y.applyUpdate(isolated, parseYjsUpdatePayload(prose.payload).update);
            assert.equal(isolated.store.pendingStructs, null); assert.equal(isolated.store.pendingDs, null);
            assert.deepEqual(Y.encodeStateAsUpdate(isolated), fullState(expected, fixture.documentId), 'Restore must carry the complete current state');
          } finally { isolated.destroy(); }
          const revision = Number(expected.prepare('SELECT revision FROM yjs_document_revision WHERE document_id=?').get(fixture.documentId)!.revision);
          restoredRevisions.add(revision);
          const nativeTimestamp = String(expected.prepare('SELECT updated_at FROM node_content WHERE node_id=?').get(fixture.chapterId)!.updated_at);
          const beforeTimestamp = String(initial.prepare('SELECT updated_at FROM node_content WHERE node_id=?').get(fixture.chapterId)!.updated_at);
          assert.equal(nativeTimestamp, beforeTimestamp, 'Local restore preserves the existing prose cache timestamp');
          restoredDocuments.set(fixture.chapterId, { nativeTimestamp, remoteTimestamp: new Date(changeSet.hlc.wallMs).toISOString() });
        }
        const parity = tables.map(table => {
          const adjusted = (db: DatabaseSync, native: boolean) => canonicalRows(raw(db, table).map(row => {
            const value = { ...row };
            for (const key of wallClockColumns[table] ?? []) {
              assert.equal(typeof value[key], 'string'); assert(Number.isFinite(Date.parse(value[key] as string))); delete value[key];
            }
            if (table === 'sync_change_set' && originalIds.has(String(value.change_set_id))) {
              assert.equal(value.origin, native ? 'local' : 'remote'); value.origin = 'compared-original';
            }
            if (table === 'yjs_document_revision_provenance' && value.document_id === fixture.documentId && restoredRevisions.has(Number(value.revision))) {
              assert.equal(value.source_kind, native ? 'system' : 'remote'); value.source_kind = 'compared-restore';
            }
            if (table === 'node_content') {
              assert.equal(typeof value.content_json, 'string'); value.content_json = JSON.parse(value.content_json as string) as unknown;
              const timestamps = restoredDocuments.get(String(value.node_id));
              if (timestamps) {
                assert.equal(value.updated_at, native ? timestamps.nativeTimestamp : timestamps.remoteTimestamp);
                const baseline = initial.prepare('SELECT content_json FROM node_content WHERE node_id=?').get(fixture.chapterId)!;
                const rendered = new Y.Doc();
                try {
                  Y.applyUpdate(rendered, fullState(db, fixture.documentId));
                  assert.deepEqual(value.content_json, native
                    ? JSON.parse(String(baseline.content_json))
                    : yDocToProsemirrorJSON(rendered, 'default'), 'Each cache obeys its local/remote role');
                } finally { rendered.destroy(); }
                value.content_json = 'verified-local-preservation/remote-projection';
                value.updated_at = 'compared-local-preservation/remote-projection';
              }
            }
            return value;
          }));
          const actualRows = adjusted(gateway.database, false), expectedRows = adjusted(expected, true);
          checkEqual(table, actualRows, expectedRows);
          return { table, rows: actualRows.length, sha256: sha(JSON.stringify(actualRows)) };
        });
        const remoteWriter = raw(gateway.database, 'sync_generation_writer_state');
        assert.equal(remoteWriter.length, 1);
        assert.equal(remoteWriter[0]!.next_device_seq, writerBefore[0]!.next_device_seq, 'Receiving never consumes local authored sequence');
        const nativeWriter = raw(expected, 'sync_generation_writer_state');
        assert.equal(nativeWriter.length, 1);
        assert.equal(nativeWriter[0]!.next_device_seq, changeSet.deviceSeq + 1, 'Actual local command allocates exactly one original');
        assert(Number(remoteWriter[0]!.hlc_wall_ms) >= changeSet.hlc.wallMs);
        const nativeState = fullState(expected, fixture.documentId);
        assert.deepEqual(fullState(gateway.database, fixture.documentId), nativeState);
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, nativeState);
          const cache = expected.prepare('SELECT content_json FROM node_content WHERE node_id=?').get(fixture.chapterId)!;
          const baselineCache = initial.prepare('SELECT content_json FROM node_content WHERE node_id=?').get(fixture.chapterId)!;
          assert.deepEqual(JSON.parse(String(cache.content_json)), JSON.parse(String(baselineCache.content_json)), 'Local lifecycle preserves the existing cache; Yjs remains prose truth');
          assert(yDocToProsemirrorJSON(doc, 'default').content?.length, 'Actual Yjs state remains renderable');
        } finally { doc.destroy(); }
        const beforeDuplicate = snapshot(gateway.database);
        const totalChanges = gateway.database.prepare('SELECT total_changes() AS count').get()!.count;
        const duplicate = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(duplicate.status, 'duplicate');
        assert.deepEqual(snapshot(gateway.database), beforeDuplicate);
        assert.equal(gateway.database.prepare('SELECT total_changes() AS count').get()!.count, totalChanges);
        steps.push({ operation: step.operation, originalSha256: sha(bytes), mutationCount: step.mutationCount,
          incarnation, faultRollback: step.faultBeforeApply, duplicate: 'passed', tables: parity,
          stateSha256: sha(nativeState), afterDatabaseSha256: sha(readFileSync(database(step.afterDatabase))) });
      } finally { expected.close(); }
    }
    return { name: fixture.name, status: 'passed', beforeDatabaseSha256: sha(readFileSync(database(fixture.beforeDatabase))), steps };
  } finally { initial.close(); invalidateSqliteReducerStateCache(); await gateway.close(); }
}

async function main() {
  const fixture = JSON.parse(readFileSync(input, 'utf8')) as { schemaVersion: number; cases: Case[] };
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.cases.map(item => item.name), [
    'chapter-trash-preserves-prose-and-placement', 'chapter-restore-reincarnates-and-remains-editable',
    'chapter-trash-restore-rollback-and-owner-retention',
  ]);
  mkdirSync(path.dirname(output), { recursive: true });
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    excludedWallClockColumns: wallClockColumns,
    roleDifferences: ['New original origin local/remote', 'Restored revision provenance System/Remote',
      'Local cache and timestamp preservation versus remote Yjs/winning-HLC projection', 'Local sequence allocation versus remote HLC observation'],
    scope: 'Actual native local chapter trash/restore originals through production TS remote materialization on real file-backed SQLite copies. No native remote receiver, provider, account or permanent deletion acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, lifecycleSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
