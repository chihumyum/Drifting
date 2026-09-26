import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { captureYjsTransactionEvidence } from '../src/renderer/services/yjs-transaction-evidence';
import { createSyncMutationV1, decodeSyncChangeSetV1, encodeSyncChangeSetV1, type SyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { encodeCanonicalCbor, hashCanonicalCbor } from '../src/renderer/sync/protocol/canonical-cbor';
import { GOLDEN_CHANGESET_V1 } from '../src/renderer/sync/protocol/fixtures/v1-fixtures';
import { assertCanonicalCborValue, type CanonicalCborValue } from '../src/renderer/sync/protocol/primitives';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';

// All text and identities are synthetic. This oracle exercises the shipped
// capture/encoding code; its explicit intent declaration is fixture data, not
// a production operation classifier or semantic deletion authorization.
const outputPath = 'crates/drifting-core/tests/fixtures/original-body-archive.json';
function canonical(value: unknown): CanonicalCborValue {
  assertCanonicalCborValue(value);
  return value;
}
function syntheticDelete(doc: Y.Doc, text: Y.XmlText) {
  assert.equal(text.toString(), '保🙂潮汐');
  const selected = Y.createRelativePositionFromTypeIndex(text, 0);
  assert(selected.type && selected.item);
  const ranges = [{ client: selected.item.client, clock: selected.item.clock, length: 1 }];
  const origin = {};
  const capture = captureYjsTransactionEvidence(doc, (_txn, observed) => observed === origin);
  doc.transact(() => text.delete(0, 1), origin);
  const records = capture.drain();
  capture.dispose();
  assert.equal(records.length, 1);
  const record = records[0]!;
  if (record.status !== 'captured') throw record.error;
  const evidence = record.payload.sourceRetentionProvenance;
  assert(evidence?.kind === 'transaction-event');
  assert.deepEqual(evidence.transactionDeletes, ranges);
  const decoded = Y.decodeUpdate(record.payload.update);
  assert.equal(decoded.structs.length, 0);
  assert.deepEqual([...decoded.ds.clients].flatMap(([client, deletes]) =>
    deletes.map(range => ({ client, clock: range.clock, length: range.len }))), ranges);
  return { ...record.payload, sourceOperationIntent: {
    version: 1, kind: 'prose.text.delete',
    targetText: { client: selected.type.client, clock: selected.type.clock },
    offsetUTF16: 0, lengthUTF16: 1, selectedSourceRanges: ranges,
  } };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const scope = { projectId: 'synthetic-archive-project', projectSyncId: 'synthetic-archive-sync', syncGenerationId: 'synthetic-archive-generation', documentId: 'node-content:synthetic-body-archive', incarnation: 0 };
const target = { family: 'yjs' as const, kind: 'prose-document', id: scope.documentId, incarnation: scope.incarnation };

async function main() {
  const doc = new Y.Doc({ gc: false }); doc.clientID = 65001;
  const origin = {};
  const capture = captureYjsTransactionEvidence(doc, (_txn, observed) => observed === origin);
  const paragraph = new Y.XmlElement('paragraph'); paragraph.setAttribute('id', 'b');
  const text = new Y.XmlText('潮汐'); paragraph.insert(0, [text]);
  doc.transact(() => doc.getXmlFragment('default').push([paragraph]), origin);
  const seedRecords = capture.drain(); assert.equal(seedRecords.length, 1);
  const seed = seedRecords[0]!; if (seed.status !== 'captured') throw seed.error;
  assert.equal(text.toString(), '潮汐');
  doc.clientID = 65002;
  doc.transact(() => text.insert(0, '保🙂'), origin);
  const insertRecords = capture.drain(); capture.dispose(); assert.equal(insertRecords.length, 1);
  const insert = insertRecords[0]!; if (insert.status !== 'captured') throw insert.error;
  assert.equal(text.toString(), '保🙂潮汐');
  const deletion = syntheticDelete(doc, text);
  assert.equal(text.toString(), '🙂潮汐');
  const other = new Y.Doc({ gc: false }); other.clientID = 65003;
  const otherParagraph = new Y.XmlElement('paragraph'); otherParagraph.setAttribute('id', 'other');
  otherParagraph.insert(0, [new Y.XmlText('旁支')]); other.getXmlFragment('default').push([otherParagraph]);
  const otherPayload = { update: Y.encodeStateAsUpdate(other) }; // Valid untagged original body, no command intent.
  const originalOperations = [];
  const targetUpdateBase64: string[] = [];
  const rows = [
    { name: 'seed', payload: seed.payload, expectedText: '潮汐', selectedTarget: target },
    { name: 'insert', payload: insert.payload, expectedText: '保🙂潮汐', selectedTarget: target },
    { name: 'delete', payload: deletion, expectedText: '🙂潮汐', selectedTarget: target },
    { name: 'other-document', payload: otherPayload, expectedText: '旁支', selectedTarget: { ...target, id: 'node-content:synthetic-other-archive' } },
  ];
  for (const [index, row] of rows.entries()) {
    const mutation = await createSyncMutationV1({ index: 0, target: row.selectedTarget, action: 'yjs.update', payloadVersion: 1, payload: canonical(row.payload) });
    const mutations = [mutation];
    if (row.name === 'insert') mutations.push(await createSyncMutationV1({ index: 1,
      target: { family: 'entity', kind: 'chapter', id: 'synthetic-unrelated-chapter', incarnation: 0 },
      action: 'field.set', payloadVersion: 1, payload: { field: 'title', value: 'Synthetic unrelated sibling', futureField: { keep: true } } }));
    const deviceSeq = index + 1;
    const changeSet: SyncChangeSetV1 = { ...GOLDEN_CHANGESET_V1,
      projectId: scope.projectId, projectSyncId: scope.projectSyncId, syncGenerationId: scope.syncGenerationId,
      writerId: 'archive-writer', writerEpoch: 'epoch-a', deviceSeq,
      changeSetId: `archive-writer:epoch-a:${deviceSeq}`, hlc: { wallMs: 1700000000000 + index, counter: index }, mutations };
    const encoded = encodeSyncChangeSetV1(changeSet); assert((await decodeSyncChangeSetV1(encoded)).ok);
    const originalEnvelopeSha256 = (await hashCanonicalCbor(canonical(changeSet))).slice('sha256:'.length);
    const reference = { projectId: scope.projectId, projectSyncId: scope.projectSyncId, syncGenerationId: scope.syncGenerationId, changeSetId: changeSet.changeSetId, originalEnvelopeSha256 };
    const originalOperationReference = { ...reference, mutationIndex: 0, target: row.selectedTarget, payloadSha256: mutation.payloadSha256 };
    const parsed = parseYjsUpdatePayload(mutation.payload);
    assert.deepEqual(parsed.update, row.payload.update);
    if (row.name === 'delete') {
      assert(parsed.sourceRetentionProvenance?.kind === 'transaction-event');
      assert('sourceOperationIntent' in row.payload);
    } else assert(!('sourceOperationIntent' in row.payload));
    originalOperations.push({ name: row.name, envelopeBase64: b64(encoded), reference,
      ...(row.name === 'delete' ? { originalOperationReference } : {}),
      header: { writerId: changeSet.writerId, writerEpoch: changeSet.writerEpoch, deviceSeq, hlc: changeSet.hlc,
        protocolVersion: changeSet.protocolVersion, payloadVersion: changeSet.payloadVersion, mutationCount: mutations.length },
      mutations: mutations.map(m => ({ index: m.index, target: m.target, action: m.action, payloadVersion: m.payloadVersion,
        payloadSha256: m.payloadSha256, canonicalPayloadBase64: b64(encodeCanonicalCbor(m.payload)),
        ...(m.action === 'yjs.update' ? { updateBase64: b64(row.payload.update) } : {}) })),
      expectedText: row.expectedText, expectedInTargetArchive: row.selectedTarget.id === scope.documentId });
    if (row.selectedTarget.id === scope.documentId) targetUpdateBase64.push(b64(row.payload.update));
  }
  const replay = new Y.Doc({ gc: false });
  for (const [index, update] of targetUpdateBase64.entries()) {
    Y.applyUpdate(replay, Buffer.from(update, 'base64'));
    const root = replay.getXmlFragment('default');
    const replayText = (root.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    assert.equal(replayText.toString(), rows[index]!.expectedText);
  }
  assert.deepEqual(Y.encodeStateVector(replay), Y.encodeStateVector(doc));
  const fixture = { schemaVersion: 1, synthetic: true, scope, originalOperations, expectedText: text.toString(),
    targetUpdateBase64, expectedStateBase64: b64(Y.encodeStateAsUpdate(doc)),
    requiredOriginals: originalOperations.filter(o => o.expectedInTargetArchive).map(o => o.reference) };
  const content = JSON.stringify(fixture, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    assert.equal(readFileSync(outputPath, 'utf8'), content, `Stale fixture: ${outputPath}`);
  } else writeFileSync(outputPath, content);
  doc.destroy(); other.destroy(); replay.destroy();
  console.log(JSON.stringify({ status: 'passed', originals: originalOperations.length, mutations: originalOperations.reduce((sum, operation) => sum + operation.mutations.length, 0), targetBodies: targetUpdateBase64.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
