import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { captureYjsTransactionEvidence } from '../src/renderer/services/yjs-transaction-evidence';
const output = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'crates/drifting-core/tests/fixtures/native-journal-evidence.json';
const b64 = (v: Uint8Array) => Buffer.from(v).toString('base64');
const cases = [];
for (const [name, initial, insert, offset, length] of [
  ['plain', '潮汐', '', 0, 1], ['emoji', '潮🙂汐', '', 1, 2], ['multiple-source-clocks', '潮汐', '保', 0, 2],
] as const) {
  const seed = new Y.Doc({ gc: false }); seed.clientID = 51001;
  const seedUpdates: string[] = [];
  seed.on('update', (u: Uint8Array) => seedUpdates.push(b64(u)));
  seed.transact(() => {
    const paragraph = new Y.XmlElement('paragraph'); paragraph.setAttribute('id', 'p');
    const text = new Y.XmlText(); text.insert(0, initial); paragraph.insert(0, [text]);
    seed.getXmlFragment('default').insert(0, [paragraph]);
  });
  const doc = new Y.Doc({ gc: false }); doc.clientID = 51002;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  const paragraph = doc.getXmlFragment('default').get(0); assert(paragraph instanceof Y.XmlElement);
  const text = paragraph.get(0); assert(text instanceof Y.XmlText);
  if (insert) {
    const handler = (u: Uint8Array) => seedUpdates.push(b64(u)); doc.on('update', handler);
    text.insert(0, insert); doc.off('update', handler);
  }
  const beforeText = text.toString();
  const targetText = Y.createRelativePositionFromTypeIndex(text, 0).type; assert(targetText);
  // The synthetic dispatcher selects source IDs BEFORE calling delete.
  const selected = Array.from({ length }, (_, index) => {
    const item = Y.createRelativePositionFromTypeIndex(text, offset + index).item; assert(item);
    return { client: item.client, clock: item.clock };
  }).sort((a, b) => a.client - b.client || a.clock - b.clock);
  const selectedSourceRanges: { client: number; clock: number; length: number }[] = [];
  for (const id of selected) {
    const prior = selectedSourceRanges[selectedSourceRanges.length - 1];
    if (prior?.client === id.client && prior.clock + prior.length === id.clock) prior.length++;
    else selectedSourceRanges.push({ ...id, length: 1 });
  }
  const origin = Symbol('synthetic-explicit-delete');
  const capture = captureYjsTransactionEvidence(doc, (_txn, o) => o === origin);
  doc.transact(() => text.delete(offset, length), origin);
  const [record] = capture.drain(); assert(record?.status === 'captured');
  const provenance = record.payload.sourceRetentionProvenance; assert(provenance?.kind === 'transaction-event');
  assert.deepEqual(selectedSourceRanges, provenance.transactionDeletes);
  // This generator itself issued the explicit delete command. It is synthetic
  // input, not a deployed native command adapter or inferred transaction intent.
  const intent = { targetText: { client: targetText.client, clock: targetText.clock }, offsetUTF16: offset,
    lengthUTF16: length, selectedSourceRanges };
  cases.push({ name, seedUpdates, beforeText, afterText: text.toString(), update: b64(record.payload.update),
    afterState: b64(Y.encodeStateAsUpdate(doc)), beforeSnapshot: b64(provenance.beforeSnapshot),
    transactionDeletes: provenance.transactionDeletes, intent });
  capture.dispose(); seed.destroy(); doc.destroy();
}
const value = JSON.stringify({ schemaVersion: 1, declaration: 'synthetic explicit command; not production native capture', cases }, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(output, 'utf8'), value);
else writeFileSync(output, value);
console.log(JSON.stringify({ status: 'passed', cases: cases.length }));
