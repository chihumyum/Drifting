// Actual native act originals, replayed by the production TS reducer on SQLite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import * as Y from 'yjs';
import { defaultActName, deriveActSegments, sortActs, type BookAct } from '../src/renderer/domain/book-act';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
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
const tables = [
  'project', 'book_act', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
const preservedTables = [
  'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_yjs_materialization_receipt', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
interface OutlineRow { kind: string; id: string; title: string; actId: string | null }
interface Step {
  operation: 'create' | 'rename' | 'remove';
  encodedBase64: string;
  mutationCount: number;
  createdAt: string;
  afterDatabase: string;
  faultBeforeApply: boolean;
  act: BookAct;
  outline: OutlineRow[];
}
interface Case {
  name: string;
  beforeDatabase: string;
  projectId: string;
  chapterIds: string[];
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
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}
function raw(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}
function canonicalRows(values: Row[]): Row[] {
  return values.map(row => normalize(row) as Row)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries([...tables, 'sync_generation_writer_state']
    .map(table => [table, canonicalRows(raw(db, table))]));
}
function equalRows(table: string, actual: Row[], expected: Row[]) {
  if (isDeepStrictEqual(actual, expected)) return;
  const index = actual.findIndex((row, i) => !isDeepStrictEqual(row, expected[i]));
  const summary = (value: unknown) => {
    const text = JSON.stringify(value) ?? 'undefined';
    return text.length > 1000 ? `${text.slice(0, 900)}… sha256:${sha(text)}` : text;
  };
  assert.fail(`${table} parity failed (${actual.length}/${expected.length} rows): `
    + `${summary(actual[index])} / ${summary(expected[index])}`);
}
function acts(db: DatabaseSync, projectId: string): BookAct[] {
  return db.prepare(`SELECT id,project_id AS projectId,name,color,start_order AS startOrder,
    drift_node_id AS driftNodeId,created_at AS createdAt,updated_at AS updatedAt
    FROM book_act WHERE project_id=?`).all(projectId) as unknown as BookAct[];
}
function outline(db: DatabaseSync, projectId: string): OutlineRow[] {
  const chapters = db.prepare(`SELECT id,title,book_order AS bookOrder FROM book_node
    WHERE project_id=? AND kind='chapter' AND deleted_at IS NULL ORDER BY book_order,id COLLATE BINARY`)
    .all(projectId) as unknown as { id: string; title: string; bookOrder: number }[];
  const segments = deriveActSegments(acts(db, projectId), chapters);
  const assigned = new Set(segments.flatMap(segment => segment.chapters.map(chapter => chapter.id)));
  const chapterRow = (chapter: typeof chapters[number], actId: string | null): OutlineRow =>
    ({ kind: 'chapter', id: chapter.id, title: chapter.title, actId });
  const rows = chapters.filter(chapter => !assigned.has(chapter.id)).map(chapter => chapterRow(chapter, null));
  for (const segment of segments) {
    rows.push({ kind: 'act', id: segment.act.id, title: segment.act.name, actId: null });
    rows.push(...segment.chapters.map(chapter => chapterRow(chapter, segment.act.id)));
  }
  return rows;
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
      assert(row.update_blob instanceof Uint8Array);
      Y.applyUpdate(doc, row.update_blob);
    }
    assert.equal(doc.store.pendingStructs, null);
    assert.equal(doc.store.pendingDs, null);
    assert(doc.getXmlFragment('default').length > 0);
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}
function causedByFault(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error.message.includes('synthetic act receipt fault')) return true;
    error = (error as Error & { cause?: unknown }).cause;
  }
  return false;
}

async function verify(fixture: Case, ordinal: number) {
  const temporary = mkdtempSync(path.join(path.dirname(output), `act-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const originalIds = new Set<string>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const before = snapshot(initial);
  const steps = [];
  try {
    for (const step of fixture.steps) {
      const bytes = Uint8Array.from(Buffer.from(step.encodedBase64, 'base64'));
      const decoded = await decodeSyncChangeSetV1(bytes);
      assert(decoded.ok, 'Actual native original must decode through production protocol');
      const changeSet = decoded.value;
      assert.deepEqual(encodeSyncChangeSetV1(changeSet), bytes);
      assert.equal(changeSet.projectId, fixture.projectId);
      assert.equal(changeSet.mutations.length, 1);
      assert.equal(step.mutationCount, 1);
      const mutation = changeSet.mutations[0]!;
      assert.deepEqual(mutation.target, { family: 'entity', kind: 'book-act', id: step.act.id, incarnation: 0 });
      // This is the exact domain-to-wire adapter used by useBookAct, including
      // stripping projection timestamps and preserving the complete create seed.
      const builder = new SyncChangeBuilder();
      appendAuthoredDomainMutation(builder, {
        entityType: 'bookAct', entityId: step.act.id, projectId: fixture.projectId,
        mutationType: step.operation === 'create' ? 'create' : step.operation === 'rename' ? 'update' : 'delete',
        ...(step.operation === 'create' ? { payload: { ...step.act } }
          : step.operation === 'rename' ? { payload: { name: step.act.name, updatedAt: step.act.updatedAt } } : {}),
      });
      assert.deepEqual((await builder.finalize()).mutations[0]!.mutation, mutation);
      if (step.operation === 'create') {
        const previous = acts(gateway.database, fixture.projectId);
        assert(step.act.startOrder !== null && Number.isFinite(step.act.startOrder));
        assert(!previous.some(act => act.startOrder === step.act.startOrder));
        const position = sortActs(previous).filter(act => (act.startOrder ?? -Infinity) < step.act.startOrder!).length + 1;
        assert.equal(step.act.name, defaultActName(position));
      }
      const expected = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      try {
        const context = {
          changeSet,
          clock: { nowMs: Date.parse(step.createdAt), nowIso: step.createdAt },
          identity: { installationId: fixture.identity.installationId,
            createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) },
          kernel: productionSyncDomainMaterializationKernel,
        };
        if (step.faultBeforeApply) {
          const prior = snapshot(gateway.database);
          gateway.database.exec("CREATE TRIGGER fail_act_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic act receipt fault'); END");
          await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
          assert.deepEqual(snapshot(gateway.database), prior);
          gateway.database.exec('DROP TRIGGER fail_act_receipt');
        }
        const result = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(result.status, 'applied');
        assert.deepEqual(result.conflicts, []);
        originalIds.add(changeSet.changeSetId);
        const parity = tables.map(table => {
          const adjusted = (db: DatabaseSync, native: boolean) => canonicalRows(raw(db, table).map(row => {
            const value = { ...row };
            if (table === 'sync_change_set' && originalIds.has(String(value.change_set_id))) {
              assert.equal(value.origin, native ? 'local' : 'remote');
              value.origin = 'compared-original';
            }
            return value;
          }));
          const actualRows = adjusted(gateway.database, false);
          equalRows(table, actualRows, adjusted(expected, true));
          if (preservedTables.includes(table)) {
            equalRows(`${table} unchanged from baseline`, actualRows, before[table]!);
          }
          return { table, rows: actualRows.length, sha256: sha(JSON.stringify(actualRows)) };
        });
        const remoteWriter = raw(gateway.database, 'sync_generation_writer_state');
        const nativeWriter = raw(expected, 'sync_generation_writer_state');
        assert.equal(remoteWriter.length, 1);
        assert.equal(nativeWriter.length, 1);
        assert.equal(remoteWriter[0]!.next_device_seq, writerBefore[0]!.next_device_seq);
        assert.equal(nativeWriter[0]!.next_device_seq, changeSet.deviceSeq + 1);
        assert(Number(remoteWriter[0]!.hlc_wall_ms) >= changeSet.hlc.wallMs);
        assert.deepEqual(outline(gateway.database, fixture.projectId), step.outline);
        assert.deepEqual(outline(expected, fixture.projectId), step.outline);
        const documents = fixture.chapterIds.map(id => {
          const state = fullState(expected, `node-content:${id}`);
          assert.deepEqual(fullState(gateway.database, `node-content:${id}`), state);
          assert.deepEqual(fullState(initial, `node-content:${id}`), state);
          return { chapterId: id, unchanged: true, stateSha256: sha(state) };
        });
        const prior = snapshot(gateway.database);
        const totalChanges = gateway.database.prepare('SELECT total_changes() AS count').get()!.count;
        const duplicate = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(duplicate.status, 'duplicate');
        assert.deepEqual(snapshot(gateway.database), prior);
        assert.equal(gateway.database.prepare('SELECT total_changes() AS count').get()!.count, totalChanges);
        steps.push({ operation: step.operation, originalSha256: sha(bytes), mutationCount: 1,
          action: mutation.action, incarnation: mutation.target.incarnation, localDomainWire: 'passed',
          faultRollback: step.faultBeforeApply, duplicate: 'passed', outline: 'passed', tables: parity, documents,
          afterDatabaseSha256: sha(readFileSync(database(step.afterDatabase))) });
      } finally { expected.close(); }
    }
    return { name: fixture.name, status: 'passed', beforeDatabaseSha256: sha(readFileSync(database(fixture.beforeDatabase))), steps };
  } finally {
    initial.close();
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}
async function main() {
  const fixture = JSON.parse(readFileSync(input, 'utf8')) as { schemaVersion: number; cases: Case[] };
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.cases.map(item => item.name), [
    'act-create-rename-and-cold-outline', 'act-remove-retains-empty-boundary-chapter-state',
    'act-failure-preserves-owner-and-retries',
  ]);
  mkdirSync(path.dirname(output), { recursive: true });
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences: ['New original origin local/remote', 'Local sequence allocation versus remote HLC observation'],
    excludedColumns: [],
    scope: 'Native local act create/name/purge originals match production domain-to-wire conversion, reducer SQLite effects and derived outline. Chapter prose/cache/comments/order remain unchanged. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, actSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
