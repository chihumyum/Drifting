import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { createSyncMutationV1, decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { decodeCanonicalCbor, encodeCanonicalCbor, hashCanonicalCbor } from '../src/renderer/sync/protocol/canonical-cbor';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
const option = (name: string) => { const value = process.argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1); assert(value); return value; };
const input = option('--input'); const output = option('--output');
const from = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
interface InputCase { name: string; originalEnvelope: string; payloadCbor: string; reference: {originalEnvelopeSha256: string; payloadSha256: string}; input: {name: string; seedUpdates: string[]; update: string; beforeSnapshot: string; transactionDeletes: {client: number; clock: number; length: number}[]; intent: Record<string, unknown>; beforeText: string; afterText: string} }
const file = JSON.parse(readFileSync(input, 'utf8')) as {schemaVersion: number; cases: InputCase[]};
assert.equal(file.schemaVersion, 1); assert.equal(file.cases.length, 3);
async function main() {
const cases = [];
for (const row of file.cases) {
  const envelope = from(row.originalEnvelope); assert.equal(hash(envelope), row.reference.originalEnvelopeSha256);
  const decoded = await decodeSyncChangeSetV1(envelope); assert(decoded.ok);
  assert.deepEqual(encodeSyncChangeSetV1(decoded.value), envelope);
  const mutation = decoded.value.mutations[0]; assert(mutation);
  assert.equal(mutation.payloadSha256, row.reference.payloadSha256);
  assert.deepEqual(encodeCanonicalCbor(mutation.payload), from(row.payloadCbor));
  const payloadDecoded = decodeCanonicalCbor(from(row.payloadCbor)); assert(payloadDecoded.ok);
  assert.deepEqual(payloadDecoded.value, mutation.payload);
  assert.equal(await hashCanonicalCbor(mutation.payload), row.reference.payloadSha256);
  const recreated = await createSyncMutationV1({index: mutation.index, target: mutation.target, action: mutation.action, payloadVersion: mutation.payloadVersion, payload: mutation.payload});
  assert.deepEqual(recreated, mutation);
  const payload = parseYjsUpdatePayload(mutation.payload);
  assert.equal(b64(payload.update), row.input.update);
  const evidence = payload.sourceRetentionProvenance; assert(evidence?.kind === 'transaction-event');
  assert.equal(b64(evidence.beforeSnapshot), row.input.beforeSnapshot);
  assert.deepEqual(evidence.transactionDeletes, row.input.transactionDeletes);
  assert(mutation.payload && !Array.isArray(mutation.payload) && typeof mutation.payload === 'object' && !(mutation.payload instanceof Uint8Array));
  assert('sourceOperationIntent' in mutation.payload);
  assert.deepEqual(mutation.payload.sourceOperationIntent, {version: 1, kind: 'prose.text.delete', ...row.input.intent});
  const doc = new Y.Doc({gc: false});
  for (const seed of row.input.seedUpdates) Y.applyUpdate(doc, from(seed));
  const paragraph = doc.getXmlFragment('default').get(0); assert(paragraph instanceof Y.XmlElement);
  const text = paragraph.get(0); assert(text instanceof Y.XmlText);
  assert.equal(text.toString(), row.input.beforeText);
  assert.deepEqual(Y.decodeSnapshot(evidence.beforeSnapshot), Y.snapshot(doc));
  assert.equal(Y.decodeUpdate(payload.update).structs.length, 0);
  Y.applyUpdate(doc, payload.update); assert.equal(text.toString(), row.input.afterText); doc.destroy();
  cases.push({name: row.name, status: 'passed', exactUpdateSha256: hash(payload.update), originalEnvelopeSha256: hash(envelope), payloadSha256: mutation.payloadSha256, before: row.input.beforeText, after: row.input.afterText});
}
writeFileSync(output, JSON.stringify({schemaVersion: 1, status: 'passed', source: 'actual production TS decoder/canonical encoder/Yjs', cases}, null, 2) + '\n');
console.log(JSON.stringify({status: 'passed', cases: cases.length}));

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
