import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';

const option = (name: string) => { const value = process.argv.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1); assert(value, `Missing ${name}`); return value; };
const directory = option('--input');
const output = option('--output');
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'base64'));
const normalized = (update: Uint8Array) => {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, update); return Y.encodeStateAsUpdate(doc); }
  finally { doc.destroy(); }
};
type Range = { client: number; clock: number; length: number };
const ranges = (ds: ReturnType<typeof Y.snapshot>['ds']): Range[] =>
  [...ds.clients].sort(([a], [b]) => a - b).flatMap(([client, entries]) => entries.map(r => ({client, clock: r.clock, length: r.len})));
type NativeWire = {
  envelopeBase64: string;
  originalReference: { originalEnvelopeSha256: string; payloadSha256: string; changeSetId: string };
  beforeBase64: string; afterBase64: string; exactUpdateBase64: string;
};
async function main() {
  const names = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  assert.equal(names.length, 4);
  const cases = [];
  for (const name of names) {
    const input = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')) as NativeWire;
    const envelope = bytes(input.envelopeBase64);
    const decoded = await decodeSyncChangeSetV1(envelope);
    assert(decoded.ok, `Actual native original was rejected: ${name}`);
    assert.deepEqual(encodeSyncChangeSetV1(decoded.value), envelope);
    assert.equal(sha(envelope), input.originalReference.originalEnvelopeSha256);
    assert.equal(decoded.value.changeSetId, input.originalReference.changeSetId);
    assert.equal(decoded.value.mutations.length, 1);
    const mutation = decoded.value.mutations[0]!;
    assert.equal(mutation.payloadSha256, input.originalReference.payloadSha256);
    const payload = parseYjsUpdatePayload(mutation.payload);
    assert.deepEqual(payload.update, bytes(input.exactUpdateBase64));
    const evidence = payload.sourceRetentionProvenance;
    assert(evidence?.kind === 'transaction-event');
    const intent = (mutation.payload as unknown as {sourceOperationIntent: {kind: string; targetText: {client:number;clock:number}; offsetUTF16:number; lengthUTF16:number; selectedSourceRanges: Range[]}}).sourceOperationIntent;
    assert(intent?.kind === 'prose.text.delete');
    const doc = new Y.Doc({gc: false});
    try {
      Y.applyUpdate(doc, bytes(input.beforeBase64));
      assert.deepEqual(Y.encodeSnapshot(Y.snapshot(doc)), evidence.beforeSnapshot);
      const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON({type:intent.targetText,assoc:0}),doc);
      assert(position?.type instanceof Y.XmlText);
      const selected = Array.from({length:intent.lengthUTF16},(_,offset)=>{
        const item=Y.createRelativePositionFromTypeIndex(position.type,intent.offsetUTF16+offset).item;assert(item);
        return {client:item.client,clock:item.clock};
      }).sort((a,b)=>a.client-b.client||a.clock-b.clock);
      const selectedRanges:Range[]=[];
      for(const id of selected){const prior=selectedRanges[selectedRanges.length-1];if(prior?.client===id.client&&prior.clock+prior.length===id.clock)prior.length++;else selectedRanges.push({...id,length:1});}
      assert.deepEqual(selectedRanges,intent.selectedSourceRanges);
      const event = Y.decodeUpdate(payload.update);
      assert.equal(event.structs.length, 0);
      assert.deepEqual(ranges(event.ds), evidence.transactionDeletes);
      assert.deepEqual(evidence.transactionDeletes, intent.selectedSourceRanges);
      Y.applyUpdate(doc, payload.update);
      assert.equal(doc.store.pendingStructs, null);
      assert.equal(doc.store.pendingDs, null);
      assert.deepEqual(normalized(Y.encodeStateAsUpdate(doc)), normalized(bytes(input.afterBase64)));
      cases.push({name, originalSha256: sha(envelope), exactUpdateSha256: sha(payload.update), selectedClients: new Set(intent.selectedSourceRanges.map(r => r.client)).size});
    } finally { doc.destroy(); }
  }
  assert(cases.some(item => item.selectedClients === 2));
  writeFileSync(output, JSON.stringify({status: 'passed', cases,
    scope: 'Actual native command -> durable journal original -> shipped decoder/canonical byte roundtrip and independent full Yjs state comparison; no provider or capability claim.'}, null, 2) + '\n');
  console.log(JSON.stringify({status: 'passed', actualNativeOriginals: cases.length}));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
