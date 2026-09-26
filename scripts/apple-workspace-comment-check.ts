// Actual native chapter comment originals, replayed by the production TS reducer on SQLite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import * as Y from 'yjs';
import {
  commentBlockIds, createPlainCommentDoc, getBlockSnapshotFromAnchor, getBlockSnapshotsFromAnchor,
  getSelectedTextFromAnchor, getTextAnchorFromAnchor, type Comment,
} from '../src/renderer/domain/comment';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createCommentRepository } from '../src/renderer/sqlite-repo/comment-repo';
import { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
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
const tables = [
  'project', 'book_act', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
const preservedTables = [
  'project', 'book_act', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment_action',
];
// The live prose owner persists, re-stamps and compacts checkpoints outside
// comment originals. These rows are carried from native evidence before each
// replay; the reducer must leave them untouched.
const ownerTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance'];
const ownerReceipts = 'sync_yjs_materialization_receipt';
const journalTables = ['sync_change_set', 'sync_mutation'];
type Operation = 'create' | 'body' | 'resolve' | 'reopen';
const expectedCases: Record<string, { operations: Operation[]; bodies: (string | null)[] }> = {
  // Bodies typed into the bridge tests; null keeps the previous body.
  'comment-create-highlights-and-cold-reopen': { operations: ['create'], bodies: ['核对：🙂\n\n第二段'] },
  'comment-body-and-status-keep-anchor-and-history': { operations: ['body', 'resolve', 'reopen'], bodies: ['改后的批注🙂', null, null] },
  'comment-failures-leave-owner-unchanged-and-retry': { operations: ['create', 'body', 'resolve'], bodies: ['重试', '失败后才改', null] },
};
interface Step {
  operation: Operation;
  encodedBase64: string;
  mutationCount: number;
  createdAt: string;
  afterDatabase: string;
  faultBeforeApply: boolean;
  comment: Comment;
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
function snapshot(db: DatabaseSync, names = [...tables, 'sync_generation_writer_state']) {
  return Object.fromEntries(names.map(table => [table, canonicalRows(raw(db, table))]));
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
function insert(db: DatabaseSync, table: string, rows: Row[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(column => row[column] as SQLInputValue));
  }
}
/** Every `comment` column, as the camelCase domain/bridge record. */
function commentRow(db: DatabaseSync, id: string): Comment | undefined {
  const row = db.prepare('SELECT * FROM comment WHERE id=?').get(id);
  return row && Object.fromEntries(Object.entries(row)
    .map(([key, value]) => [key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()), value])) as unknown as Comment;
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
function withUpdates(state: Uint8Array, updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  const canonical = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    for (const update of updates) Y.applyUpdate(doc, update);
    assert.equal(doc.store.pendingStructs, null);
    assert.equal(doc.store.pendingDs, null);
    // Load once more so struct merging matches a cold owner load.
    Y.applyUpdate(canonical, Y.encodeStateAsUpdate(doc));
    return Y.encodeStateAsUpdate(canonical);
  } finally {
    doc.destroy();
    canonical.destroy();
  }
}
function plain(node: unknown): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert?: unknown }[]).map(op => typeof op.insert === 'string' ? op.insert : '').join('');
  }
  return node instanceof Y.XmlElement ? node.toArray().map(plain).join('') : '';
}
function blocks(state: Uint8Array): { id: string; text: string }[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getXmlFragment('default').toArray().map(node => {
      assert(node instanceof Y.XmlElement);
      return { id: String(node.getAttribute('id') ?? ''), text: plain(node) };
    });
  } finally { doc.destroy(); }
}
/** Production comment helpers resolve the stored anchor against live Yjs blocks (UTF-16 offsets). */
function verifyAnchor(comment: Comment, state: Uint8Array) {
  const ids = commentBlockIds(comment);
  assert.equal(ids[0], comment.targetBlockId);
  const text = getTextAnchorFromAnchor(comment.anchorJson);
  assert(text, 'Native comments carry a precise text anchor');
  assert.equal(getSelectedTextFromAnchor(comment.anchorJson), text.text);
  assert.equal(text.startBlockId, ids[0]);
  assert.equal(text.endBlockId, ids[ids.length - 1]);
  const live = blocks(state);
  const start = live.findIndex(block => block.id === ids[0]);
  assert(start >= 0, 'Anchored block must exist in authoritative prose');
  const range = live.slice(start, start + ids.length);
  assert.deepEqual(range.map(block => block.id), ids, 'Anchored blocks must be consecutive');
  const snapshots = getBlockSnapshotsFromAnchor(comment.anchorJson);
  assert.deepEqual(snapshots, range.map(block => ({ blockId: block.id, blockText: block.text })));
  const selected = range.length === 1
    ? range[0]!.text.slice(text.startOffset, text.endOffset)
    : [range[0]!.text.slice(text.startOffset), ...range.slice(1, -1).map(block => block.text),
      range[range.length - 1]!.text.slice(0, text.endOffset)].join('\n');
  assert.equal(selected, text.text);
  const single = getBlockSnapshotFromAnchor(comment.anchorJson);
  assert(single);
  assert.equal(single.blockText, range[0]!.text);
  if (single.from >= 0) assert.equal(single.blockText.slice(single.from, single.to), text.text);
}
function causedByFault(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error.message.includes('synthetic comment receipt fault')) return true;
    error = (error as Error & { cause?: unknown }).cause;
  }
  return false;
}
/**
 * Carry native owner state that no comment original owns: intermediate local
 * prose originals (decoded and bounded to fixture chapters) and the live owner's
 * Yjs persistence. Returns the carried prose updates by document.
 */
async function carryOwnerState(receiver: DatabaseSync, native: DatabaseSync, fixture: Case, changeSetId: string) {
  const known = new Set(raw(receiver, 'sync_change_set').map(row => String(row.change_set_id)));
  const documents = new Set(fixture.chapterIds.map(id => `node-content:${id}`));
  const carried = raw(native, 'sync_change_set').filter(row => !known.has(String(row.change_set_id))
    && row.change_set_id !== changeSetId);
  const ids = new Set(carried.map(row => String(row.change_set_id)));
  const updates: { key: string; documentId: string; update: Uint8Array }[] = [];
  for (const row of carried) {
    assert.equal(row.origin, 'local');
    assert(row.encoded_bytes instanceof Uint8Array);
    const decoded = await decodeSyncChangeSetV1(row.encoded_bytes);
    assert(decoded.ok, 'Carried native prose original must decode through production protocol');
    assert.deepEqual(encodeSyncChangeSetV1(decoded.value), row.encoded_bytes);
    assert.equal(decoded.value.projectId, fixture.projectId);
    for (const mutation of decoded.value.mutations) {
      assert.equal(mutation.action, 'yjs.update', 'Only prose originals may be carried');
      assert.equal(mutation.target.family, 'yjs');
      assert.equal(mutation.target.kind, 'prose-document');
      assert(documents.has(mutation.target.id));
      updates.push({ key: `${decoded.value.changeSetId}\0${mutation.index}`, documentId: mutation.target.id,
        update: parseYjsUpdatePayload(mutation.payload).update });
    }
  }
  const receiptKey = (row: Row) => `${row.change_set_id}\0${row.mutation_index}`;
  const receipts = new Set(raw(receiver, ownerReceipts).map(receiptKey));
  const nativeReceipts = raw(native, ownerReceipts);
  const missingReceipts = nativeReceipts.filter(row => !receipts.has(receiptKey(row)));
  assert.equal(nativeReceipts.length - missingReceipts.length, receipts.size, 'Receiver receipts must be a subset of native owner receipts');
  assert(missingReceipts.every(row => ids.has(String(row.change_set_id))), 'Only carried prose originals add owner receipts');
  receiver.exec('BEGIN IMMEDIATE');
  try {
    insert(receiver, 'sync_change_set', carried);
    for (const table of journalTables.slice(1)) {
      insert(receiver, table, raw(native, table).filter(row => ids.has(String(row.change_set_id))));
    }
    for (const table of ownerTables) {
      receiver.exec(`DELETE FROM "${table}"`);
      insert(receiver, table, raw(native, table));
    }
    // The owner appends then compacts; the append-only receipt guard needs the
    // update row, so admit a compacted receipt against its carried update bytes
    // in a transient row and compact it again, as the native owner did.
    const live = new Set(raw(receiver, 'yjs_updates').map(row => Number(row.id)));
    for (const receipt of missingReceipts) {
      const transient = !live.has(Number(receipt.update_row_id));
      if (transient) {
        const update = updates.find(item => item.key === receiptKey(receipt));
        assert(update && update.documentId === receipt.document_id, 'Compacted receipt must match its carried prose update');
        insert(receiver, 'yjs_updates', [{ id: receipt.update_row_id, document_id: receipt.document_id,
          update_blob: update.update, created_at: receipt.created_at }]);
      }
      insert(receiver, ownerReceipts, [receipt]);
      if (transient) receiver.prepare('DELETE FROM yjs_updates WHERE id=?').run(receipt.update_row_id as SQLInputValue);
    }
    insert(receiver, 'sync_apply_receipt', raw(native, 'sync_apply_receipt').filter(row => ids.has(String(row.change_set_id))));
    receiver.exec('COMMIT');
  } catch (error) {
    receiver.exec('ROLLBACK');
    throw error;
  }
  invalidateSqliteReducerStateCache();
  return { originals: carried.length, updates };
}

async function verify(fixture: Case, ordinal: number) {
  const expectedCase = expectedCases[fixture.name]!;
  assert.deepEqual(fixture.steps.map(step => step.operation), expectedCase.operations);
  const temporary = mkdtempSync(path.join(path.dirname(output), `comment-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const repository = createCommentRepository(fixture.projectId, gateway.client());
  const originalIds = new Set<string>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const before = snapshot(initial);
  const columns = (initial.prepare('PRAGMA table_info(comment)').all() as unknown as { name: string }[])
    .map(column => column.name.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase())).sort();
  const steps = [];
  try {
    for (const [index, step] of fixture.steps.entries()) {
      const bytes = Uint8Array.from(Buffer.from(step.encodedBase64, 'base64'));
      const decoded = await decodeSyncChangeSetV1(bytes);
      assert(decoded.ok, 'Actual native original must decode through production protocol');
      const changeSet = decoded.value;
      assert.deepEqual(encodeSyncChangeSetV1(changeSet), bytes);
      assert.equal(changeSet.projectId, fixture.projectId);
      const status = step.operation === 'resolve' || step.operation === 'reopen';
      assert.equal(step.mutationCount, status ? 2 : 1);
      assert.equal(changeSet.mutations.length, step.mutationCount);
      const comment = step.comment;
      assert.deepEqual(Object.keys(comment).sort(), columns, 'Bridge comment must carry every comment column');
      for (const mutation of changeSet.mutations) {
        assert.deepEqual(mutation.target, { family: 'entity', kind: 'comment', id: comment.id, incarnation: 0 });
      }
      // Mirrors useComment: commentSyncPayload on create, then exactly the
      // changed authored fields for updateCommentBody/resolve/reopen.
      const builder = new SyncChangeBuilder();
      appendAuthoredDomainMutation(builder, {
        entityType: 'comment', entityId: comment.id, projectId: fixture.projectId,
        mutationType: step.operation === 'create' ? 'create' : 'update',
        payload: step.operation === 'create' ? {
          id: comment.id, kind: comment.kind, targetKind: comment.targetKind, targetId: comment.targetId,
          targetBlockId: comment.targetBlockId, anchorJson: comment.anchorJson, authorKind: comment.authorKind,
          authorId: comment.authorId, authorName: comment.authorName, bodyJson: comment.bodyJson,
          status: comment.status, priority: comment.priority, source: comment.source,
          metadataJson: comment.metadataJson, targetBlockIdsJson: comment.targetBlockIdsJson, resolvedAt: comment.resolvedAt,
        } : step.operation === 'body' ? { bodyJson: comment.bodyJson }
          : { status: comment.status, resolvedAt: comment.resolvedAt },
      });
      assert.deepEqual((await builder.finalize()).mutations.map(item => item.mutation), changeSet.mutations);
      const source = expectedCase.bodies[index];
      const expected = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      const prior = new DatabaseSync(database(index === 0 ? fixture.beforeDatabase : fixture.steps[index - 1]!.afterDatabase), { readOnly: true });
      try {
        const carried = await carryOwnerState(gateway.database, expected, fixture, changeSet.changeSetId);
        const previous = commentRow(gateway.database, comment.id);
        assert.equal(comment.updatedAt, step.createdAt);
        if (step.operation === 'create') {
          assert.equal(previous, undefined);
          assert.equal(comment.createdAt, step.createdAt);
          assert.deepEqual([comment.kind, comment.targetKind, comment.targetId, comment.authorKind, comment.source, comment.status, comment.resolvedAt],
            ['note', 'node', fixture.chapterIds[0], 'user', 'manual', 'open', null]);
        } else {
          assert(previous);
          const changed = step.operation === 'body' ? { bodyJson: comment.bodyJson }
            : step.operation === 'resolve' ? { status: 'resolved', resolvedAt: step.createdAt } : { status: 'open', resolvedAt: null };
          assert.notDeepEqual(previous, { ...previous, ...changed, updatedAt: previous.updatedAt }, 'Each command changes its field');
          assert.deepEqual(comment, { ...previous, ...changed, updatedAt: step.createdAt }, 'Only the commanded fields and updatedAt change');
        }
        assert.equal(comment.bodyJson, source === null ? previous!.bodyJson : createPlainCommentDoc(source!));
        const context = {
          changeSet,
          clock: { nowMs: Date.parse(step.createdAt), nowIso: step.createdAt },
          identity: { installationId: fixture.identity.installationId,
            createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) },
          kernel: productionSyncDomainMaterializationKernel,
        };
        const owner = snapshot(gateway.database, [...ownerTables, ownerReceipts]);
        if (step.faultBeforeApply) {
          const unchanged = snapshot(gateway.database);
          gateway.database.exec("CREATE TRIGGER fail_comment_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic comment receipt fault'); END");
          await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
          assert.deepEqual(snapshot(gateway.database), unchanged);
          gateway.database.exec('DROP TRIGGER fail_comment_receipt');
        }
        const result = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(result.status, 'applied');
        assert.deepEqual(result.conflicts, []);
        assert.deepEqual(snapshot(gateway.database, [...ownerTables, ownerReceipts]), owner, 'Comment reducer must not touch prose owner state');
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
        // The reducer's row equals the native command result in every column,
        // raw and through the production repository mapping.
        assert.deepEqual(commentRow(gateway.database, comment.id), comment);
        assert.deepEqual(commentRow(expected, comment.id), comment);
        assert.deepEqual(await repository.findById(comment.id), comment);
        const documents = fixture.chapterIds.map(id => {
          const docId = `node-content:${id}`;
          const state = fullState(expected, docId);
          assert.deepEqual(fullState(gateway.database, docId), state);
          const updates = carried.updates.filter(item => item.documentId === docId).map(item => item.update);
          const priorState = fullState(prior, docId);
          if (updates.length === 0) assert.deepEqual(priorState, state);
          else {
            assert.notDeepEqual(priorState, state);
            assert.deepEqual(withUpdates(priorState, updates), state, 'Carried prose originals account for the prose change');
          }
          return { chapterId: id, unchanged: updates.length === 0, stateSha256: sha(state) };
        });
        verifyAnchor(comment, fullState(expected, `node-content:${comment.targetId}`));
        const unchanged = snapshot(gateway.database);
        const totalChanges = gateway.database.prepare('SELECT total_changes() AS count').get()!.count;
        const duplicate = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(duplicate.status, 'duplicate');
        assert.deepEqual(snapshot(gateway.database), unchanged);
        assert.equal(gateway.database.prepare('SELECT total_changes() AS count').get()!.count, totalChanges);
        steps.push({ operation: step.operation, originalSha256: sha(bytes), mutationCount: step.mutationCount,
          actions: changeSet.mutations.map(mutation => mutation.action), incarnation: 0, localDomainWire: 'passed',
          faultRollback: step.faultBeforeApply, duplicate: 'passed', row: 'passed', body: 'passed',
          anchor: 'passed', ownerUntouched: 'passed',
          carriedProseOriginals: carried.originals, tables: parity, documents,
          afterDatabaseSha256: sha(readFileSync(database(step.afterDatabase))) });
      } finally {
        prior.close();
        expected.close();
      }
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
  assert.deepEqual(fixture.cases.map(item => item.name), Object.keys(expectedCases));
  mkdirSync(path.dirname(output), { recursive: true });
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences: ['New original origin local/remote', 'Local sequence allocation versus remote HLC observation'],
    excludedColumns: [],
    carriedOwnerState: [
      'Live prose owner rows (yjs_updates, yjs_snapshots, yjs_document_revision, yjs_document_revision_provenance, sync_yjs_materialization_receipt) are carried from each native after-database before replay; the comment reducer must leave them untouched.',
      'Intermediate native prose originals between exported steps are carried with their journal rows only after decoding as yjs.update on a fixture chapter and reproducing its authoritative Yjs state; a receipt whose update row the owner already compacted is admitted against a transient row holding the carried update, then compacted again.',
    ],
    scope: 'Native chapter comment create/body/resolve/reopen originals match production domain-to-wire conversion, reducer SQLite effects, the production comment row mapping, body document and anchor helpers. Chapters, prose caches, acts and comment actions remain unchanged. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, commentSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
