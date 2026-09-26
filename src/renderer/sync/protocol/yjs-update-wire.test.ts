import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { encodeCanonicalCbor, hashCanonicalCbor } from './canonical-cbor';
import {
  createSyncMutationV1,
  decodeSyncChangeSetV1,
  encodeSyncChangeSetV1,
  validateSyncChangeSetV1Invariants,
  type SyncChangeSetV1,
} from './change-set';
import { GOLDEN_CHANGESET_V1, GOLDEN_SEGMENT_V1 } from './fixtures/v1-fixtures';
import type { CanonicalCborValue } from './primitives';
import { decodeSegmentV1, encodeSegmentV1, type SegmentV1 } from './segment';

function actualTransactionPayload() {
  const doc = new Y.Doc();
  doc.clientID = 89;
  doc.getText('prose').insert(0, '甲🙂乙');
  const beforeSnapshot = Y.encodeSnapshot(Y.snapshot(doc));
  let update: Uint8Array | undefined;
  doc.once('update', (bytes: Uint8Array) => { update = new Uint8Array(bytes); });
  doc.transact(() => doc.getText('prose').delete(0, 1), 'synthetic-transaction');
  if (!update) throw new Error('Synthetic transaction did not emit an update');
  const transactionDeletes = [...Y.decodeUpdate(update).ds.clients]
    .sort(([left], [right]) => left - right)
    .flatMap(([client, ranges]) => ranges.map(({ clock, len }) => ({ client, clock, length: len })));
  doc.destroy();
  return {
    update,
    sourceRetentionProvenance: {
      version: 1,
      kind: 'transaction-event',
      beforeSnapshot,
      transactionDeletes,
    },
  };
}

async function changeSet(payload: CanonicalCborValue): Promise<SyncChangeSetV1> {
  return {
    ...GOLDEN_CHANGESET_V1,
    mutations: [await createSyncMutationV1({
      index: 0,
      target: { family: 'yjs', kind: 'prose-document', id: 'node-content:synthetic-wire', incarnation: 0 },
      action: 'yjs.update',
      payloadVersion: 1,
      payload,
    })],
  };
}

function segment(value: SyncChangeSetV1): SegmentV1 {
  return {
    ...GOLDEN_SEGMENT_V1,
    header: { ...GOLDEN_SEGMENT_V1.header, requiredBlobIds: [] },
    changeSets: [value],
  };
}

async function expectExactRoundTrip(value: SyncChangeSetV1): Promise<void> {
  const bytes = encodeSyncChangeSetV1(value);
  const decoded = await decodeSyncChangeSetV1(bytes);
  expect(decoded, decoded.ok ? undefined : decoded.reason).toEqual({ ok: true, value, canonicalBytes: bytes });
  const packed = segment(value);
  const segmentBytes = encodeSegmentV1(packed);
  expect(await decodeSegmentV1(segmentBytes)).toEqual({ ok: true, value: packed, canonicalBytes: segmentBytes });
}

describe('optional Yjs transaction evidence across change-set and segment wire', () => {
  it.each(['before hashing completes', 'after hashing completes'] as const)(
    'owns mutation payload and target when callers change inputs %s',
    async (when) => {
      const sharedBytes = (bytes: Uint8Array): Uint8Array => {
        const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
        shared.set(bytes);
        return shared;
      };
      const actual = actualTransactionPayload();
      const futureValue = { entries: [{ label: 'retained', values: [1, 2], bytes: sharedBytes(Uint8Array.of(7, 8)) }] };
      const future = Object.assign(Object.create(null) as typeof futureValue, futureValue);
      const payloadValue = {
        update: sharedBytes(actual.update),
        sourceRetentionProvenance: {
          ...actual.sourceRetentionProvenance,
          beforeSnapshot: sharedBytes(actual.sourceRetentionProvenance.beforeSnapshot),
        },
        futurePayloadField: future,
      };
      const payload = Object.assign(Object.create(null) as typeof payloadValue, payloadValue);
      const target = {
        family: 'yjs' as const,
        kind: 'prose-document',
        id: 'node-content:synthetic-owned-wire',
        incarnation: 0,
      };
      const expectedTarget = { ...target };
      const expectedPayloadBytes = encodeCanonicalCbor(payload);
      const expectedHash = await hashCanonicalCbor(payload);
      const changeInputs = () => {
        payload.update[payload.update.length - 1] = 2;
        const evidence = payload.sourceRetentionProvenance;
        evidence.beforeSnapshot[evidence.beforeSnapshot.length - 1] = 5;
        evidence.transactionDeletes[0]!.length = 2;
        evidence.transactionDeletes.push({ client: 90, clock: 0, length: 1 });
        future.entries[0]!.label = 'changed';
        future.entries[0]!.values.push(3);
        future.entries[0]!.bytes.fill(9);
        future.entries.push({ label: 'added', values: [], bytes: Uint8Array.of(10) });
        target.id = 'node-content:changed-by-caller';
        target.incarnation = 1;
      };
      // The real Web Crypto call yields. Mutating synchronously after obtaining
      // its promise exercises the await boundary without replacing the hasher.
      const pending = createSyncMutationV1({ index: 0, action: 'yjs.update', payloadVersion: 1, target, payload });
      if (when === 'before hashing completes') changeInputs();
      const mutation = await pending;
      if (when === 'after hashing completes') changeInputs();
      await expectExactRoundTrip({ ...GOLDEN_CHANGESET_V1, mutations: [mutation] });
      expect(mutation.payloadSha256).toBe(expectedHash);
      expect(encodeCanonicalCbor(mutation.payload)).toEqual(expectedPayloadBytes);
      expect(mutation.target).toEqual(expectedTarget);
      expect(mutation.target).not.toBe(target);
      const owned = mutation.payload as typeof payload;
      expect(owned).not.toBe(payload);
      expect(owned.update.buffer).not.toBe(payload.update.buffer);
      expect(owned.update.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(owned.sourceRetentionProvenance).not.toBe(payload.sourceRetentionProvenance);
      expect(owned.sourceRetentionProvenance.beforeSnapshot.buffer).not.toBe(payload.sourceRetentionProvenance.beforeSnapshot.buffer);
      expect(owned.sourceRetentionProvenance.beforeSnapshot.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(owned.sourceRetentionProvenance.transactionDeletes).not.toBe(payload.sourceRetentionProvenance.transactionDeletes);
      expect(owned.sourceRetentionProvenance.transactionDeletes[0]).not.toBe(payload.sourceRetentionProvenance.transactionDeletes[0]);
      expect(owned.futurePayloadField).not.toBe(future);
      expect(owned.futurePayloadField.entries).not.toBe(future.entries);
      expect(owned.futurePayloadField.entries[0]).not.toBe(future.entries[0]);
      expect(owned.futurePayloadField.entries[0]!.values).not.toBe(future.entries[0]!.values);
      expect(owned.futurePayloadField.entries[0]!.bytes.buffer).not.toBe(future.entries[0]!.bytes.buffer);
      expect(owned.futurePayloadField.entries[0]!.bytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    },
  );

  it('preserves a real transaction snapshot, update and delete ranges exactly through both envelopes', async () => {
    const payload = { ...actualTransactionPayload(), futurePayloadField: { preserved: true } };
    expect(payload.sourceRetentionProvenance.transactionDeletes).toEqual([{ client: 89, clock: 0, length: 1 }]);
    await expectExactRoundTrip(await changeSet(payload));
  });

  it('preserves the distinct state-transfer shape through both envelopes', async () => {
    const doc = new Y.Doc();
    doc.clientID = 90;
    doc.getText('prose').insert(0, '合成状态');
    const payload = {
      update: Y.encodeStateAsUpdate(doc),
      sourceRetentionProvenance: { version: 1, kind: 'state-transfer' },
    };
    doc.destroy();
    await expectExactRoundTrip(await changeSet(payload));
  });

  it('keeps an omitted supplement absent and preserves legacy payload bytes and hash', async () => {
    const payload = { update: actualTransactionPayload().update };
    const expectedBytes = encodeCanonicalCbor(payload);
    const value = await changeSet(payload);
    expect(value.mutations[0]!.payloadSha256).toBe(await hashCanonicalCbor(payload));
    await expectExactRoundTrip(value);
    const decoded = await decodeSyncChangeSetV1(encodeSyncChangeSetV1(value));
    if (!decoded.ok) throw new Error('Legacy update unexpectedly rejected');
    expect(decoded.value.mutations[0]!.payload).not.toHaveProperty('sourceRetentionProvenance');
    expect(encodeCanonicalCbor(decoded.value.mutations[0]!.payload)).toEqual(expectedBytes);
  });

  it.each([
    ['present null', null],
    ['unsupported inner version', { version: 2, kind: 'state-transfer' }],
    ['state-transfer carrying deletes', { version: 1, kind: 'state-transfer', transactionDeletes: [] }],
    ['snapshot with trailing bytes', {
      version: 1, kind: 'transaction-event', beforeSnapshot: Uint8Array.of(0, 0, 0), transactionDeletes: [],
    }],
    ['overlapping delete ranges', {
      version: 1, kind: 'transaction-event', beforeSnapshot: Uint8Array.of(0, 0),
      transactionDeletes: [{ client: 89, clock: 0, length: 2 }, { client: 89, clock: 1, length: 1 }],
    }],
  ] as const)('rejects correctly hashed %s evidence at both wire entry points', async (_name, sourceRetentionProvenance) => {
    const payload = { update: actualTransactionPayload().update, sourceRetentionProvenance };
    const value = await changeSet(payload);
    expect(value.mutations[0]!.payloadSha256).toBe(await hashCanonicalCbor(payload));
    expect(() => encodeSyncChangeSetV1(value)).toThrow(/sourceRetentionProvenance/u);
    expect(() => encodeSegmentV1(segment(value))).toThrow(/sourceRetentionProvenance/u);
    // Encode the hostile but canonical wire directly, bypassing the safe local
    // encoder. Its correct hash must not cause a malformed supplement to pass.
    const bytes = encodeCanonicalCbor(value);
    expect(await decodeSyncChangeSetV1(bytes)).toMatchObject({
      ok: false,
      disposition: 'quarantine',
      reason: 'invariant-invalid',
      rawBytes: bytes,
      issues: [expect.objectContaining({ path: '/mutations/0/payload' })],
    });
    const segmentBytes = encodeCanonicalCbor(segment(value));
    expect(await decodeSegmentV1(segmentBytes)).toMatchObject({
      ok: false,
      disposition: 'quarantine',
      reason: 'invariant-invalid',
      rawBytes: segmentBytes,
      issues: [expect.objectContaining({ path: '/changeSets/0/mutations/0/payload' })],
    });
  });

  it.each(['before snapshot', 'delete ranges', 'evidence kind'] as const)(
    'rejects syntactically valid %s tampering when the original payload hash is retained',
    async (field) => {
      const payload = actualTransactionPayload();
      const original = await changeSet(payload);
      const evidence = payload.sourceRetentionProvenance;
      const sourceRetentionProvenance = field === 'evidence kind'
        ? { version: 1, kind: 'state-transfer' }
        : {
            ...evidence,
            ...(field === 'before snapshot'
              ? { beforeSnapshot: Y.encodeSnapshot(Y.emptySnapshot) }
              : { transactionDeletes: [{ client: 89, clock: 0, length: 2 }] }),
          };
      const tamperedPayload = { ...payload, sourceRetentionProvenance };
      const tampered = {
        ...original,
        mutations: [{ ...original.mutations[0]!, payload: tamperedPayload }],
      };
      expect(validateSyncChangeSetV1Invariants(tampered)).toEqual([]);
      expect(await hashCanonicalCbor(tamperedPayload)).not.toBe(original.mutations[0]!.payloadSha256);
      expect(await decodeSyncChangeSetV1(encodeSyncChangeSetV1(tampered))).toMatchObject({
        ok: false, disposition: 'quarantine', reason: 'integrity-mismatch', path: '/mutations/0/payloadSha256',
      });
      expect(await decodeSegmentV1(encodeSegmentV1(segment(tampered)))).toMatchObject({
        ok: false, disposition: 'quarantine', reason: 'integrity-mismatch', path: '/changeSets/0/mutations/0/payloadSha256',
      });
    },
  );
});
