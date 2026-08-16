import { describe, expect, it } from 'vitest';

import {
  decodeCanonicalCbor,
  hashCanonicalCbor,
} from '../protocol';
import { SyncChangeBuilder } from './change-builder';

describe('SyncChangeBuilder', () => {
  it('assigns continuous indices, copies canonical payloads, and freezes after finalize', async () => {
    const builder = new SyncChangeBuilder();
    const payload = {
      field: 'title',
      value: 'Before mutation',
      state: new Uint8Array([1, 2, 3]),
    };

    expect(
      builder.add({
        action: 'field.set',
        target: { family: 'entity', kind: 'node', id: 'node-1', incarnation: 0 },
        payload,
      }),
    ).toBe(0);
    expect(
      builder.addMutation({
        action: 'order.move',
        target: { family: 'order', kind: 'chapter', id: 'node-1', incarnation: 0 },
        payload: { positionKey: 'a0' },
      }),
    ).toBe(1);

    payload.value = 'Mutated outside builder';
    payload.state[0] = 9;
    const finalizing = builder.finalize();
    expect(() =>
      builder.add({
        action: 'entity.trash',
        target: { family: 'entity', kind: 'node', id: 'node-1', incarnation: 0 },
        payload: {},
      }),
    ).toThrow(/finalized/u);

    const finalized = await finalizing;
    expect(builder.isFinalized).toBe(true);
    expect(finalized.mutations.map(({ mutation }) => mutation.index)).toEqual([0, 1]);
    expect(finalized.mutations[0].mutation.payload).toEqual({
      field: 'title',
      value: 'Before mutation',
      state: new Uint8Array([1, 2, 3]),
    });
    expect(finalized.mutations[0].mutation.payloadSha256).toBe(
      await hashCanonicalCbor(finalized.mutations[0].mutation.payload),
    );
    expect(decodeCanonicalCbor(finalized.mutations[0].payloadCbor)).toMatchObject({
      ok: true,
      value: {
        field: 'title',
        value: 'Before mutation',
        state: new Uint8Array([1, 2, 3]),
      },
    });

    const finalizedPayload = finalized.mutations[0].mutation.payload as {
      value: string;
      state: Uint8Array;
    };
    finalizedPayload.value = 'Mutated finalized result';
    finalizedPayload.state[0] = 8;
    expect((await builder.finalize()).mutations[0].mutation.payload).toEqual({
      field: 'title',
      value: 'Before mutation',
      state: new Uint8Array([1, 2, 3]),
    });
  });

  it('fails and permanently closes an authored builder with zero mutations', async () => {
    const builder = new SyncChangeBuilder();
    await expect(builder.finalize()).rejects.toThrow(/at least one sync mutation/u);
    expect(builder.isFinalized).toBe(true);
    expect(() =>
      builder.add({
        action: 'sync-generation.purge',
        target: { family: 'sync-generation', kind: 'sync-generation', id: 'sync-generation-1', incarnation: 0 },
        payload: {},
      }),
    ).toThrow(/finalized/u);
  });
});
