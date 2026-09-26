/* eslint-disable @typescript-eslint/no-explicit-any -- Deliberately malformed protocol fixtures need untyped mutation below. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encode as rawEncode } from 'cborg';
import * as Y from 'yjs';
import { decodeCanonicalCbor, encodeCanonicalCbor, hashCanonicalCbor } from '../src/renderer/sync/protocol/canonical-cbor';
import { createSyncMutationV1, decodeSyncChangeSetV1, encodeSyncChangeSetV1, type SyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
import type { CanonicalCborValue } from '../src/renderer/sync/protocol/primitives';
// Synthetic intent declarations in this fixture are not a production command
// classifier. Actual update bytes, transaction evidence and envelope hashes are
// generated using the shipped Yjs/capture/protocol implementations.
import { captureYjsTransactionEvidence } from '../src/renderer/services/yjs-transaction-evidence';
import { assertCanonicalCborValue } from '../src/renderer/sync/protocol/primitives';
import type { SyncMutationTargetV1 } from '../src/renderer/sync/protocol/change-set';
import type { YjsTransactionDeleteRange } from '../src/renderer/sync/protocol/yjs-update-payload';

interface Reference {
  projectId: string; projectSyncId: string; syncGenerationId: string;
  changeSetId: string; mutationIndex: number; target: SyncMutationTargetV1;
  payloadSha256: string; originalEnvelopeSha256: string;
}
interface OriginalFixture {
  name: string; originalEnvelope: string; originalEnvelopeSha256: string;
  source: Omit<Reference, 'originalEnvelopeSha256'>; update: string;
}
let original: { cases: OriginalFixture[] };
const option = (name: string, fallback: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? fallback;
const decoderOutput = option('--decoder-output', 'crates/drifting-core/tests/fixtures/original-operation.json');
const storeOutput = option('--store-output', 'crates/drifting-core/src/original_operation_store/fixtures.json');
const checking = process.argv.includes('--check');
function output(path: string, value: unknown) {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (checking) assert.equal(readFileSync(path, 'utf8'), content, `Stale fixture: ${path}`);
  else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
}
const b64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
const from=(value:string)=>new Uint8Array(Buffer.from(value,'base64'));
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

function paragraph(id: string, value: string) {
  const block = new Y.XmlElement('paragraph');
  block.setAttribute('id', id);
  const text = new Y.XmlText();
  text.insert(0, value);
  block.insert(0, [text]);
  return block;
}
function childText(doc: Y.Doc, index: number): Y.XmlText {
  const block = doc.getXmlFragment('default').get(index);
  assert(block instanceof Y.XmlElement);
  const text = block.get(0);
  assert(text instanceof Y.XmlText);
  return text;
}
function selectedRanges(text: Y.XmlText, offset: number, length: number): YjsTransactionDeleteRange[] {
  const ids = Array.from({ length }, (_, index) => {
    const id = Y.createRelativePositionFromTypeIndex(text, offset + index).item;
    assert(id);
    return { client: id.client, clock: id.clock };
  }).sort((a, b) => a.client - b.client || a.clock - b.clock);
  const ranges: YjsTransactionDeleteRange[] = [];
  for (const id of ids) {
    const previous = ranges.at(-1);
    if (previous && previous.client === id.client && previous.clock + previous.length === id.clock) {
      ranges[ranges.length - 1] = { ...previous, length: previous.length + 1 };
    } else ranges.push({ ...id, length: 1 });
  }
  return ranges;
}

async function syntheticOriginals(): Promise<{ cases: OriginalFixture[] }> {
  const seed = new Y.Doc({ gc: false });
  seed.clientID = 37501;
  seed.getXmlFragment('default').insert(0, [paragraph('b', '潮汐'), paragraph('d', '终章')]);
  const originalBytes = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const cases: OriginalFixture[] = [];
  for (const [name, offset, length, expected] of [
    ['late-only', 0, 1, '潮汐'], ['base-only', 1, 1, '保汐'], ['both', 0, 2, '汐'],
  ] as const) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 37901;
    Y.applyUpdate(doc, originalBytes);
    // Distinct source clock spans exercise multi-writer operation ranges.
    childText(doc, 1).insert(0, '远🙂');
    const text = childText(doc, 0);
    text.insert(0, '保');
    assert.equal(text.toString(), '保潮汐');
    const targetText = Y.createRelativePositionFromTypeIndex(text, 0).type;
    assert(targetText);
    const selectedSourceRanges = selectedRanges(text, offset, length);
    const origin = Symbol('synthetic-explicit-delete');
    const capture = captureYjsTransactionEvidence(doc, (_transaction, value) => value === origin);
    try {
      doc.transact(() => text.delete(offset, length), origin);
      const records = capture.drain();
      assert.equal(records.length, 1);
      const captured = records[0];
      assert(captured?.status === 'captured');
      assert(captured.payload.sourceRetentionProvenance?.kind === 'transaction-event');
      assert.deepEqual(captured.payload.sourceRetentionProvenance.transactionDeletes, selectedSourceRanges);
      assert.equal(Y.decodeUpdate(captured.payload.update).structs.length, 0);
      assert.equal(text.toString(), expected);
      // This declaration names the synthetic operation this generator just
      // performed. It does not infer intent from arbitrary transaction deletes.
      const payload = {
        ...captured.payload,
        sourceOperationIntent: {
          version: 1, kind: 'prose.text.delete',
          targetText: { client: targetText.client, clock: targetText.clock },
          offsetUTF16: offset, lengthUTF16: length, selectedSourceRanges,
        },
      };
      assertCanonicalCborValue(payload);
      const mutation = await createSyncMutationV1({ index: 0, action: 'yjs.update', payloadVersion: 1,
        target: { family: 'yjs', kind: 'prose-document', id: 'node-content:synthetic-original-operation', incarnation: 0 }, payload });
      const envelope: SyncChangeSetV1 = {
        protocol: 'drifting.sync.changeset', protocolVersion: 1, payloadVersion: 1,
        projectId: 'project-synthetic', projectSyncId: 'projectSync-synthetic', syncGenerationId: 'sync-generation-synthetic',
        changeSetId: 'writer-a:epoch-a:1', writerId: 'writer-a', writerEpoch: 'epoch-a', deviceSeq: 1,
        hlc: { wallMs: 1_786_660_000_000, counter: 3 }, mutations: [mutation],
      };
      const encoded = encodeSyncChangeSetV1(envelope);
      const checked = await decodeSyncChangeSetV1(encoded);
      assert(checked.ok);
      const source = { projectId: envelope.projectId, projectSyncId: envelope.projectSyncId,
        syncGenerationId: envelope.syncGenerationId, changeSetId: envelope.changeSetId,
        mutationIndex: 0, target: mutation.target, payloadSha256: mutation.payloadSha256 };
      for (const delivery of ['event', 'full']) cases.push({ name: `${name}-${delivery}`,
        originalEnvelope: b64(encoded), originalEnvelopeSha256: hash(encoded), source,
        update: b64(delivery === 'event' ? captured.payload.update : Y.encodeStateAsUpdate(doc)) });
    } finally { capture.dispose(); doc.destroy(); }
  }
  return { cases };
}

async function storeFixtures() {
  const decoded = await decodeSyncChangeSetV1(from(original.cases[0]!.originalEnvelope));
  assert(decoded.ok);
  const first = await createSyncMutationV1({ index: 0, action: 'field.set', payloadVersion: 1,
    target: { family: 'entity', kind: 'book-node', id: 'synthetic-title', incarnation: 3 },
    payload: { field: 'title', value: 'Synthetic companion mutation', future: { bytes: new Uint8Array([1, 7, 9]), numeric: 1.5 } } });
  const multiple: SyncChangeSetV1 = { ...decoded.value, mutations: [first, { ...decoded.value.mutations[0]!, index: 1 }] };
  const fixtures = [];
  for (const [name, envelope, index] of [['single', decoded.value, 0], ['multiple', multiple, 1]] as const) {
    const encoded = encodeSyncChangeSetV1(envelope);
    const checked = await decodeSyncChangeSetV1(encoded); assert(checked.ok);
    const selected = envelope.mutations[index]!;
    fixtures.push({ name, envelope: Array.from(encoded),
      reference: { projectId: envelope.projectId, projectSyncId: envelope.projectSyncId,
        syncGenerationId: envelope.syncGenerationId, changeSetId: envelope.changeSetId, mutationIndex: index,
        target: selected.target, payloadSha256: selected.payloadSha256, originalEnvelopeSha256: hash(encoded) },
      header: { writerId: envelope.writerId, writerEpoch: envelope.writerEpoch, deviceSeq: envelope.deviceSeq,
        wallMs: envelope.hlc.wallMs, counter: envelope.hlc.counter },
      mutations: envelope.mutations.map(mutation => ({ index: mutation.index, target: mutation.target,
        action: mutation.action, payloadVersion: mutation.payloadVersion,
        payloadBytes: Array.from(encodeCanonicalCbor(mutation.payload)), payloadSha256: mutation.payloadSha256.slice(7) })) });
  }
  output(storeOutput, fixtures);
}

function keys(value:unknown,expected:string[]){assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...expected].sort());}
async function oracle(bytes:Uint8Array,reference:Reference){
 try {
  assert.equal(hash(bytes),reference.originalEnvelopeSha256);const result=await decodeSyncChangeSetV1(bytes);assert(result.ok);const cs=result.value;
  for(const key of ['projectId','projectSyncId','syncGenerationId','changeSetId']as const)assert.equal(cs[key],reference[key]);
  const m=cs.mutations[reference.mutationIndex];assert(m);assert.equal(m.index,reference.mutationIndex);assert.equal(m.action,'yjs.update');assert.deepEqual(m.target,reference.target);assert.equal(m.payloadSha256,reference.payloadSha256);
  assert.equal(m.target.kind,'prose-document');const parsed=parseYjsUpdatePayload(m.payload);const p=parsed.sourceRetentionProvenance;assert(p?.kind==='transaction-event');
  const intent=(m.payload as any).sourceOperationIntent;keys(intent,['version','kind','targetText','offsetUTF16','lengthUTF16','selectedSourceRanges']);assert.equal(intent.version,1);assert.equal(intent.kind,'prose.text.delete');keys(intent.targetText,['client','clock']);
  assert(Number.isSafeInteger(intent.targetText.client)&&intent.targetText.client>=0);assert(Number.isInteger(intent.targetText.clock)&&intent.targetText.clock>=0&&intent.targetText.clock<0xffff_ffff);
  assert(Number.isSafeInteger(intent.offsetUTF16)&&intent.offsetUTF16>=0);assert(Number.isSafeInteger(intent.lengthUTF16)&&intent.lengthUTF16>0);assert(Number.isSafeInteger(intent.offsetUTF16+intent.lengthUTF16));
  assert.deepEqual(intent.selectedSourceRanges,p.transactionDeletes);assert.equal(p.transactionDeletes.reduce((a,b)=>a+b.length,0),intent.lengthUTF16);
  const event=Y.decodeUpdate(parsed.update);assert.equal(event.structs.length,0);const ds=[...event.ds.clients].sort(([a],[b])=>a-b).flatMap(([client,ranges])=>ranges.map(r=>({client,clock:r.clock,length:r.len})));assert.deepEqual(ds,p.transactionDeletes);
  return true;
 }catch{return false;}
}
const positives:any[]=[],negatives:any[]=[],cbor:any[]=[],strictBoundaries:any[]=[];
async function record(name:string,bytes:Uint8Array,reference:Reference,expected:boolean){
 assert.equal(await oracle(bytes,reference),expected,name);
 const row:any={name,envelope:b64(bytes),expected:reference};
 if(expected){const r=await decodeSyncChangeSetV1(bytes);assert(r.ok);const m=r.value.mutations[reference.mutationIndex];const p=parseYjsUpdatePayload(m!.payload);assert(p.sourceRetentionProvenance?.kind==='transaction-event');Object.assign(row,{exactUpdate:b64(p.update),beforeSnapshot:b64(p.sourceRetentionProvenance.beforeSnapshot),intent:(m!.payload as any).sourceOperationIntent,metadata:{writerId:r.value.writerId,writerEpoch:r.value.writerEpoch,deviceSeq:r.value.deviceSeq,hlc:r.value.hlc},mutations:r.value.mutations.map(m=>({...m,payload:undefined,canonicalPayloadBase64:b64(encodeCanonicalCbor(m.payload))}))});positives.push(row);}else negatives.push(row);
}
async function reseal(name:string,mutate:(c:SyncChangeSetV1)=>void,expected=false,rehash=true){
 const r=await decodeSyncChangeSetV1(from(original.cases[0].originalEnvelope));assert(r.ok);const value=r.value;mutate(value);
 if(rehash)for(const m of value.mutations)m.payloadSha256=await hashCanonicalCbor(m.payload);
 const bytes=encodeCanonicalCbor(value);const selected=value.mutations[0]!;const ref={...original.cases[0].source,payloadSha256:selected.payloadSha256,originalEnvelopeSha256:hash(bytes)};await record(name,bytes,ref,expected);
}
async function main(){
original = await syntheticOriginals();
for(const f of original.cases)await record(f.name,from(f.originalEnvelope),{...f.source,originalEnvelopeSha256:f.originalEnvelopeSha256},true);
await reseal('unknown payload complete canonical value model',c=>{(c.mutations[0]!.payload as any).future=Object.assign(Object.create(null),{nil:null,bools:[false,true],numbers:[0,-0,23,24,255,256,65535,65536,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,-(Number.MAX_SAFE_INTEGER+1),0.5,1.5,1.1,Math.PI,Math.fround(1.1),Number.MIN_VALUE,Number.MAX_VALUE],bytes:Uint8Array.of(0,255),nested:[{short:'甲🙂é',longer:[[],{}]}],'__proto__':null});},true);
{
 const r=await decodeSyncChangeSetV1(from(original.cases[0].originalEnvelope));assert(r.ok);const cs=r.value;cs.mutations[0]!.index=1;
 const other=await createSyncMutationV1({index:0,target:{family:'entity',kind:'node',id:'synthetic-other-node',incarnation:2},action:'field.set',payloadVersion:1,payload:{field:'title',value:'Unrelated synthetic change',future:[true,Uint8Array.of(4,5)]}});
 cs.mutations.unshift(other);const bytes=encodeSyncChangeSetV1(cs);await record('selected second mutation with unrelated first mutation',bytes,{...original.cases[0].source,mutationIndex:1,originalEnvelopeSha256:hash(bytes)},true);
 for(const mutate of [(c:SyncChangeSetV1)=>{(c.mutations[0]!.payload as any).value='Tampered unselected';},(c:SyncChangeSetV1)=>{c.mutations[0]!.payloadVersion=2 as 1;}]){const copy=structuredClone(cs);mutate(copy);const tampered=encodeCanonicalCbor(copy);await record('unselected mutation rejected '+negatives.length,tampered,{...original.cases[0].source,mutationIndex:1,originalEnvelopeSha256:hash(tampered)},false);}
}
for(const [key,value]of Object.entries({projectId:'different-project',projectSyncId:'different-sync',syncGenerationId:'different-generation',changeSetId:'different:epoch:1',mutationIndex:1,payloadSha256:'sha256:'+'0'.repeat(64),originalEnvelopeSha256:'0'.repeat(64)}))await record('reference mismatch '+key,from(original.cases[0].originalEnvelope),{...original.cases[0].source,originalEnvelopeSha256:original.cases[0].originalEnvelopeSha256,[key]:value},false);
for(const [key,value]of Object.entries({family:'entity',kind:'other-document',id:'node-content:other',incarnation:1}))await record('target mismatch '+key,from(original.cases[0].originalEnvelope),{...original.cases[0].source,target:{...original.cases[0].source.target,[key]:value},originalEnvelopeSha256:original.cases[0].originalEnvelopeSha256},false);
for(const [name,mutate]of [
 ['protocol',(c:any)=>c.protocol='other'],['protocol version',(c:any)=>c.protocolVersion=2],['envelope payload version',(c:any)=>c.payloadVersion=2],['mutation version',(c:any)=>c.mutations[0].payloadVersion=2],['envelope extra field',(c:any)=>c.unrecognized=true],['target extra field',(c:any)=>c.mutations[0].target.extra=true],['action family',(c:any)=>c.mutations[0].action='field.set'],['mutation index',(c:any)=>c.mutations[0].index=1],['writer id',(c:any)=>c.writerId='invalid:writer'],['HLC extra',(c:any)=>c.hlc.extra=1],['unsafe HLC',(c:any)=>c.hlc.counter=Number.MAX_SAFE_INTEGER+1],
 ['missing intent',(c:any)=>delete c.mutations[0].payload.sourceOperationIntent],['intent kind',(c:any)=>c.mutations[0].payload.sourceOperationIntent.kind='prose.structure.move'],['intent version',(c:any)=>c.mutations[0].payload.sourceOperationIntent.version=2],['intent extra',(c:any)=>c.mutations[0].payload.sourceOperationIntent.extra=true],['intent target extra',(c:any)=>c.mutations[0].payload.sourceOperationIntent.targetText.extra=1],['intent target unsafe client',(c:any)=>c.mutations[0].payload.sourceOperationIntent.targetText.client=Number.MAX_SAFE_INTEGER+1],['intent target max clock',(c:any)=>c.mutations[0].payload.sourceOperationIntent.targetText.clock=0xffff_ffff],['intent length',(c:any)=>c.mutations[0].payload.sourceOperationIntent.lengthUTF16=99],['intent selected ranges',(c:any)=>c.mutations[0].payload.sourceOperationIntent.selectedSourceRanges[0].clock=0],['intent offset overflow',(c:any)=>c.mutations[0].payload.sourceOperationIntent.offsetUTF16=Number.MAX_SAFE_INTEGER],
 ['missing evidence',(c:any)=>delete c.mutations[0].payload.sourceRetentionProvenance],['null evidence',(c:any)=>c.mutations[0].payload.sourceRetentionProvenance=null],['state transfer',(c:any)=>c.mutations[0].payload.sourceRetentionProvenance={version:1,kind:'state-transfer'}],['evidence version',(c:any)=>c.mutations[0].payload.sourceRetentionProvenance.version=2],['snapshot trailing',(c:any)=>c.mutations[0].payload.sourceRetentionProvenance.beforeSnapshot=Uint8Array.of(0,0,0)],['snapshot invalid',(c:any)=>c.mutations[0].payload.sourceRetentionProvenance.beforeSnapshot=Uint8Array.of(255)],['overlapping ranges',(c:any)=>c.mutations[0].payload.sourceRetentionProvenance.transactionDeletes.push({...c.mutations[0].payload.sourceRetentionProvenance.transactionDeletes[0]})],['empty update',(c:any)=>c.mutations[0].payload.update=new Uint8Array()],['full carrier substituted for exact event',(c:any)=>c.mutations[0].payload.update=from(original.cases[1].update)],['event DS mismatch',(c:any)=>c.mutations[0].payload.update=Uint8Array.of(0,0)],
 ]as const)await reseal(name,mutate);
await reseal('payload hash mismatch',c=>{(c.mutations[0]!.payload as any).future='changed without rehash';},false,false);
{
 const r=await decodeSyncChangeSetV1(from(original.cases[0].originalEnvelope));assert(r.ok);const cs=r.value;const m=cs.mutations[0]!;const payload=m.payload as any;
 payload.update=Uint8Array.from([...payload.update,0]);m.payloadSha256=await hashCanonicalCbor(m.payload);const bytes=encodeSyncChangeSetV1(cs);
 const reference={...original.cases[0].source,payloadSha256:m.payloadSha256,originalEnvelopeSha256:hash(bytes)};
 assert(await oracle(bytes,reference));
 strictBoundaries.push({name:'exact event trailing bytes rejected despite TS decoder ignoring tail',envelope:b64(bytes),expected:reference,tsEnvelopeAccepted:true,tsOperationPrototypeAccepted:true,rustExpected:false,reason:'trailing Yjs bytes'});
}
const base=from(original.cases[0].originalEnvelope);
for(const [name,bytes]of [
 ['trailing envelope bytes',Uint8Array.from([...base,0])],['overlong envelope map',Uint8Array.from([0xb8,base[0]!&31,...base.slice(1)])],
 ['indefinite envelope map',Uint8Array.from([0xbf,...base.slice(1),255])],
 ['duplicate envelope key',Uint8Array.from([base[0]!+1,...base.slice(1),...encodeCanonicalCbor('protocol'),...encodeCanonicalCbor('drifting.sync.changeset')])],
 ]as const)await record(name,bytes,{...original.cases[0].source,originalEnvelopeSha256:hash(bytes)},false);
function vector(name:string,bytes:Uint8Array){const d=decodeCanonicalCbor(bytes);cbor.push({name,bytes:b64(bytes),accepted:d.ok});}
for(const v of [null,true,false,0,-0,1,-1,23,24,255,256,65535,65536,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,-(Number.MAX_SAFE_INTEGER+1),0.5,1.1,Math.fround(1.1),Number.MIN_VALUE,Number.MAX_VALUE,'甲🙂é',Uint8Array.of(0,255),[],{},['a',[null]],{'longer':1,a:2,'🙂':3}])vector('canonical model '+cbor.length,encodeCanonicalCbor(v as CanonicalCborValue));
for(const [name,hex]of Object.entries({duplicate:'a2616101616102',trailing:'0000',overlongInteger:'1800',floatInteger:'f93c00',negativeZeroFloat:'f98000',nonminimalFloat:'fb3fe0000000000000',nan:'f97e00',infinity:'f97c00',undefined:'f7',tag:'c000',bigintTag:'c24101',unsafePositiveInteger:'1b0020000000000000',unsafeNegativeInteger:'3b001fffffffffffff',indefiniteArray:'9f00ff',indefiniteBytes:'5f4101ff',nonstringKey:'a10100',invalidUtf8:'61ff',unsortedMap:'a2616200616100',hugeArray:'9bffffffffffffffff',hugeString:'7bffffffffffffffff'}))vector(name,new Uint8Array(Buffer.from(hex,'hex')));
for(const depth of [64,65]){let v:any=0;for(let i=0;i<depth;i++)v=[v];vector('depth '+depth,rawEncode(v));}
for(const n of [99999,100000])vector('array nodes '+n,rawEncode(Array(n).fill(null)));
const result={schemaVersion:1,productionEnabled:false,syntheticBasisSha256:hash(new TextEncoder().encode(JSON.stringify(original))),positives,negatives,cbor,strictBoundaries};
assert.equal(positives.length, 8); assert.equal(negatives.length, 49); assert.equal(cbor.length, 52); assert.equal(strictBoundaries.length, 1);
output(decoderOutput, result);
await storeFixtures();
console.log(JSON.stringify({positive:positives.length,negative:negatives.length,cbor:cbor.length,strictBoundaries:strictBoundaries.length,acceptedCbor:cbor.filter(x=>x.accepted).length}));

}
main().catch(error=>{console.error(error);process.exitCode=1;});
