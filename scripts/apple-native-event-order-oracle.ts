import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as Y from 'yjs';
import { captureYjsTransactionEvidence } from '../src/renderer/services/yjs-transaction-evidence';
import { createSyncMutationV1, decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { GOLDEN_CHANGESET_V1 } from '../src/renderer/sync/protocol/fixtures/v1-fixtures';
import { assertCanonicalCborValue } from '../src/renderer/sync/protocol/primitives';

type Range = { client: number; clock: number; length: number };
type Intent = {
  version: 1;
  kind: 'prose.text.delete';
  targetText: { client: number; clock: number };
  offsetUTF16: number;
  lengthUTF16: number;
  selectedSourceRanges: Range[];
};
type Payload = {
  update: Uint8Array;
  sourceRetentionProvenance: {
    version: 1;
    kind: 'transaction-event';
    beforeSnapshot: Uint8Array;
    transactionDeletes: Range[];
  };
  sourceOperationIntent: Intent;
};
type NativeFixture = {
  name: string;
  retainedBodyBase64: string;
  exactUpdateBase64: string;
  beforeText: string;
  afterText: string;
  sourceRetentionProvenance: Omit<Payload['sourceRetentionProvenance'], 'beforeSnapshot'> & { beforeSnapshot: number[] };
  sourceOperationIntent: Intent;
};
type Groups = { client: number; ranges: { clock: number; len: number }[] }[];

const option = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const root = process.cwd();
const output = resolve(root, option('--out') ?? 'crates/drifting-core/tests/fixtures/event-order.json');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'base64'));
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64');
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const target = { family: 'yjs' as const, kind: 'prose-document', id: 'node-content:synthetic-original-operation', incarnation: 0 };

function nativeFixtures(): NativeFixture[] {
  const supplied = option('--native-fixtures');
  let input: string;
  if (supplied) input = readFileSync(resolve(root, supplied), 'utf8');
  else {
    const result = spawnSync('cargo', [
      'run', '--quiet', '--locked',
      '--manifest-path', 'crates/drifting-document/Cargo.toml',
      '--example', 'native-command-fixtures',
    ], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined, 'Actual native fixture generation must complete');
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr.slice(-6000));
    input = result.stdout;
  }
  const parsed = JSON.parse(input) as { synthetic: boolean; cases: NativeFixture[] };
  assert.equal(parsed.synthetic, true);
  assert.deepEqual(parsed.cases.map(item => item.name), ['chinese', 'emoji', 'multi-item', 'prior-delete-basis']);
  return parsed.cases;
}

function dsRanges(ds: ReturnType<typeof Y.snapshot>['ds']): Range[] {
  return [...ds.clients].sort(([a], [b]) => a - b).flatMap(([client, ranges]) =>
    ranges.map(range => ({ client, clock: range.clock, length: range.len })));
}

function visibleSelection(text: Y.XmlText, offset: number, length: number): Range[] {
  const ids = Array.from({ length }, (_, at) => {
    const id = Y.createRelativePositionFromTypeIndex(text, offset + at).item;
    assert(id);
    return { client: id.client, clock: id.clock };
  }).sort((a, b) => a.client - b.client || a.clock - b.clock);
  const ranges: Range[] = [];
  for (const id of ids) {
    const previous = ranges[ranges.length - 1];
    if (previous?.client === id.client && previous.clock + previous.length === id.clock) previous.length++;
    else ranges.push({ ...id, length: 1 });
  }
  return ranges;
}

// The generator issues one explicit synthetic deletion command. Transaction
// shape alone is never used to infer the command's purpose.
function captureDelete(doc: Y.Doc, text: Y.XmlText, offset: number, length: number): Payload {
  const targetText = Y.createRelativePositionFromTypeIndex(text, 0).type;
  assert(targetText);
  const selected = visibleSelection(text, offset, length);
  const origin = Symbol('synthetic-event-order-command');
  const capture = captureYjsTransactionEvidence(doc, (_transaction, actual) => actual === origin);
  try {
    doc.transact(() => text.delete(offset, length), origin);
    const records = capture.drain();
    assert.equal(records.length, 1);
    const record = records[0]; assert(record?.status === 'captured');
    const evidence = record.payload.sourceRetentionProvenance;
    assert(evidence?.kind === 'transaction-event');
    assert.deepEqual(evidence.transactionDeletes, selected);
    return {
      update: new Uint8Array(record.payload.update),
      sourceRetentionProvenance: {
        version: 1, kind: 'transaction-event',
        beforeSnapshot: new Uint8Array(evidence.beforeSnapshot),
        transactionDeletes: selected,
      },
      sourceOperationIntent: {
        version: 1, kind: 'prose.text.delete',
        targetText: { client: targetText.client, clock: targetText.clock },
        offsetUTF16: offset, lengthUTF16: length, selectedSourceRanges: selected,
      },
    };
  } finally { capture.dispose(); }
}

function source(client: number, value: string) {
  const doc = new Y.Doc({ gc: false }); doc.clientID = client;
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText(value); paragraph.insert(0, [text]);
  doc.getXmlFragment('default').push([paragraph]);
  return { doc, text };
}

function uint(value: number): number[] {
  const encoded: number[] = [];
  do {
    const byte = value % 128; value = Math.floor(value / 128);
    encoded.push(byte + (value > 0 ? 128 : 0));
  } while (value > 0);
  return encoded;
}
const event = (groups: Groups) => Uint8Array.from([0, ...uint(groups.length), ...groups.flatMap(group =>
  [...uint(group.client), ...uint(group.ranges.length), ...group.ranges.flatMap(range => [...uint(range.clock), ...uint(range.len)])])]);
const groups = (update: Uint8Array): Groups => [...Y.decodeUpdate(update).ds.clients].map(([client, ranges]) =>
  ({ client, ranges: ranges.map(range => ({ clock: range.clock, len: range.len })) }));

async function original(payload: Payload) {
  assertCanonicalCborValue(payload);
  const mutation = await createSyncMutationV1({ index: 0, target, action: 'yjs.update', payloadVersion: 1, payload });
  const changeSet = { ...GOLDEN_CHANGESET_V1, mutations: [mutation] };
  const encoded = encodeSyncChangeSetV1(changeSet);
  const decoded = await decodeSyncChangeSetV1(encoded);
  assert(decoded.ok, 'Complete envelope schema, canonical encoding and recomputed payload hash must remain valid');
  assert.deepEqual(encodeSyncChangeSetV1(decoded.value), encoded);
  assert.deepEqual(decoded.value.mutations[0]?.payload, payload);
  return {
    envelope: b64(encoded),
    expected: {
      projectId: changeSet.projectId, projectSyncId: changeSet.projectSyncId,
      syncGenerationId: changeSet.syncGenerationId, changeSetId: changeSet.changeSetId,
      mutationIndex: 0, target, payloadSha256: mutation.payloadSha256,
      originalEnvelopeSha256: sha(encoded),
    },
    exactUpdate: b64(payload.update),
  };
}

async function main() {
  const cases: Array<Awaited<ReturnType<typeof original>> & { name: string; accepted: boolean; rustReason?: string }> = [];
  const add = async (name: string, payload: Payload, accepted: boolean, rustReason?: string) => {
    if (accepted) {
      assert.deepEqual(Y.encodeSnapshot(Y.decodeSnapshot(payload.sourceRetentionProvenance.beforeSnapshot)), payload.sourceRetentionProvenance.beforeSnapshot);
      const decoded = Y.decodeUpdate(payload.update);
      assert.equal(decoded.structs.length, 0);
      assert.deepEqual(dsRanges(decoded.ds), payload.sourceRetentionProvenance.transactionDeletes);
      assert.deepEqual(payload.sourceOperationIntent.selectedSourceRanges, payload.sourceRetentionProvenance.transactionDeletes);
    }
    cases.push({ name, ...await original(payload), accepted, ...(rustReason ? { rustReason } : {}) });
  };
  const native = nativeFixtures();
  const payloads: { name: string; payload: Payload }[] = [];
  for (const fixture of native) {
    const payload: Payload = {
      update: bytes(fixture.exactUpdateBase64),
      sourceRetentionProvenance: { ...fixture.sourceRetentionProvenance, beforeSnapshot: Uint8Array.from(fixture.sourceRetentionProvenance.beforeSnapshot) },
      sourceOperationIntent: fixture.sourceOperationIntent,
    };
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, bytes(fixture.retainedBodyBase64));
      const paragraph = doc.getXmlFragment('default').get(0); assert(paragraph instanceof Y.XmlElement);
      const text = paragraph.get(0); assert(text instanceof Y.XmlText);
      assert.equal(text.toString(), fixture.beforeText);
      assert.deepEqual(Y.encodeSnapshot(Y.snapshot(doc)), payload.sourceRetentionProvenance.beforeSnapshot);
      const intent = payload.sourceOperationIntent;
      const textId = Y.createRelativePositionFromTypeIndex(text, 0).type; assert(textId);
      assert.deepEqual({ client: textId.client, clock: textId.clock }, intent.targetText);
      assert.deepEqual(visibleSelection(text, intent.offsetUTF16, intent.lengthUTF16), intent.selectedSourceRanges);
      Y.applyUpdate(doc, payload.update);
      assert.equal(text.toString(), fixture.afterText);
      assert.equal(doc.store.pendingStructs, null); assert.equal(doc.store.pendingDs, null);
    } finally { doc.destroy(); }
    await add(`actual-native-${fixture.name}`, payload, true);
    payloads.push({ name: fixture.name, payload });
  }

  const three = source(65101, '甲乙');
  three.doc.clientID = 65103; three.text.insert(1, '远');
  three.doc.clientID = 65102; three.text.insert(2, '近');
  const captured = captureDelete(three.doc, three.text, 0, 4);
  const all = groups(captured.update); assert.equal(all.length, 3);
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const raw = event(order.map(index => all[index]!));
    assert.deepEqual(Y.mergeUpdates([raw, Uint8Array.of(0, 0)]), Y.mergeUpdates([captured.update, Uint8Array.of(0, 0)]));
    await add(`three-client-order-${order.join('')}`, { ...captured, update: raw }, true);
  }
  three.doc.destroy();
  const disjoint = source(65104, '甲乙丙');
  disjoint.text.delete(1, 1);
  await add('same-client-disjoint-real-event', captureDelete(disjoint.doc, disjoint.text, 0, 2), true);
  disjoint.doc.destroy();

  const sample = payloads.find(item => item.name === 'chinese')!.payload;
  const one = groups(sample.update)[0]!;
  const invalid: { name: string; update: Uint8Array; reason: string }[] = [
    { name: 'trailing-zero', update: Uint8Array.from([...sample.update, 0]), reason: 'trailing Yjs bytes' },
    { name: 'trailing-object', update: Uint8Array.from([...sample.update, 0xa1, 1, 2]), reason: 'trailing Yjs bytes' },
    { name: 'duplicate-client', update: event([one, one]), reason: 'duplicate Yjs event delete client' },
    { name: 'zero-ranges', update: event([{ client: one.client, ranges: [] }]), reason: 'empty Yjs event delete client' },
    { name: 'zero-length', update: event([{ client: one.client, ranges: [{ clock: 0, len: 0 }] }]), reason: 'invalid Yjs event delete range' },
    { name: 'overlapping-ranges', update: event([{ client: one.client, ranges: [{ clock: 0, len: 2 }, { clock: 1, len: 1 }] }]), reason: 'overlapping' },
    { name: 'descending-ranges', update: event([{ client: one.client, ranges: [{ clock: 2, len: 1 }, { clock: 0, len: 1 }] }]), reason: 'overlapping' },
    { name: 'u32-end-overflow', update: event([{ client: one.client, ranges: [{ clock: 0xffff_ffff, len: 1 }] }]), reason: 'invalid Yjs event delete range' },
    { name: 'u32-clock-overflow', update: event([{ client: one.client, ranges: [{ clock: 0x1_0000_0000, len: 1 }] }]), reason: 'invalid Yjs event delete range' },
    { name: 'u32-length-overflow', update: event([{ client: one.client, ranges: [{ clock: 0, len: 0x1_0000_0000 }] }]), reason: 'invalid Yjs event delete range' },
    { name: 'unsafe-client', update: event([{ client: 2 ** 53, ranges: [{ clock: 0, len: 1 }] }]), reason: 'unsafe Yjs varuint' },
    { name: 'range-budget', update: event([{ client: one.client, ranges: Array.from({ length: 100_001 }, (_, clock) => ({ clock, len: 1 })) }]), reason: 'range budget' },
    { name: 'struct-count', update: Uint8Array.from([1, ...sample.update.subarray(1)]), reason: 'contains structs' },
    { name: 'truncated', update: sample.update.subarray(0, sample.update.length - 1), reason: 'truncated Yjs varuint' },
  ];
  const fields = [uint(0), uint(1), uint(one.client), uint(1), uint(one.ranges[0]!.clock), uint(one.ranges[0]!.len)];
  for (const [index, name] of ['struct-count', 'client-count', 'client', 'range-count', 'clock', 'length'].entries()) {
    const encoded = fields.map(field => [...field]);
    const changed = encoded[index]!; changed[changed.length - 1]! |= 0x80; changed.push(0);
    invalid.push({ name: `nonminimal-${name}`, update: Uint8Array.from(encoded.flat()), reason: 'noncanonical or unsafe Yjs varuint' });
  }
  for (const item of invalid) await add(item.name, { ...sample, update: item.update }, false, item.reason);
  const wrong = structuredClone(sample);
  wrong.sourceRetentionProvenance.transactionDeletes[0]!.clock++;
  wrong.sourceOperationIntent.selectedSourceRanges = structuredClone(wrong.sourceRetentionProvenance.transactionDeletes);
  await add('declared-range-mismatch', wrong, false, 'differs from declared');
  assert.equal(cases.filter(item => item.accepted).length, 11);
  assert.equal(cases.filter(item => !item.accepted).length, 21);
  const fixture = JSON.stringify({ schemaVersion: 1, synthetic: true, accepted: 11, rejected: 21, cases }, null, 2) + '\n';
  if (process.argv.includes('--check')) assert.equal(readFileSync(output, 'utf8'), fixture, 'Fixture differs from current native source and production protocol');
  else writeFileSync(output, fixture);
  console.log(JSON.stringify({ status: 'passed', actualNativeEvents: 4, accepted: 11, rejected: 21, check: process.argv.includes('--check') }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
