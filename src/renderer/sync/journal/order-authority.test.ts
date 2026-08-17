import { describe, expect, it } from 'vitest';

import { decodeCanonicalCbor } from '../protocol';
import { SyncChangeBuilder } from './change-builder';
import {
  appendAuthoredOrderMove,
  appendAuthoredOrderRebalance,
  authoredOrderRebalanceEntries,
  driftGroupOrderScope,
  fractionalPositionKeyBetween,
  fractionalPositionKeyForEntity,
  planAuthoredOrderMutation,
  assertFractionalPositionKey,
} from './order-authority';

describe('fractional authored order authority', () => {
  it('fails closed on ASCII strings outside the fractional-indexing grammar', () => {
    expect(() => assertFractionalPositionKey('a')).toThrow(/invalid fractional-indexing/u);
    expect(() => assertFractionalPositionKey('a00')).toThrow(/invalid fractional-indexing/u);
    expect(() => assertFractionalPositionKey('p1')).toThrow(/invalid fractional-indexing/u);
    expect(assertFractionalPositionKey('a0')).toBe('a0');
  });

  it('supports repeated inserts inside one gap without equal fallback keys', () => {
    const left = fractionalPositionKeyBetween(null, null);
    const right = fractionalPositionKeyBetween(left, null);
    const keys: string[] = [];
    let upper = right;
    for (let index = 0; index < 128; index += 1) {
      const key = fractionalPositionKeyBetween(left, upper);
      expect(left < key && key < upper).toBe(true);
      keys.push(key);
      upper = key;
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses current authority neighbours rather than a numeric projection', () => {
    const current = authoredOrderRebalanceEntries(['first', 'last']);
    const key = fractionalPositionKeyForEntity(current, ['first', 'middle', 'last'], 'middle');
    expect(current[0]!.positionKey < key).toBe(true);
    expect(key < current[1]!.positionKey).toBe(true);
  });

  it('plans pure insertion as moves and true reorder as one rebalance', () => {
    const current = authoredOrderRebalanceEntries(['a', 'c']);
    const insert = planAuthoredOrderMutation(current, ['a', 'b', 'c']);
    expect(insert).toMatchObject({ kind: 'moves', entries: [{ entityId: 'b' }] });
    const reorder = planAuthoredOrderMutation(current, ['c', 'a']);
    expect(reorder.kind).toBe('rebalance');
    expect(reorder.entries.map(({ entityId }) => entityId)).toEqual(['c', 'a']);
  });

  it('turns an insertion inside concurrent equal keys into an explicit rebalance', () => {
    const plan = planAuthoredOrderMutation(
      [
        { entityId: 'left', positionKey: 'a0' },
        { entityId: 'right', positionKey: 'a0' },
      ],
      ['left', 'middle', 'right'],
    );
    expect(plan).toMatchObject({
      kind: 'rebalance',
      entries: [
        { entityId: 'left' },
        { entityId: 'middle' },
        { entityId: 'right' },
      ],
    });
    expect(new Set(plan.entries.map(({ positionKey }) => positionKey)).size).toBe(3);
  });

  it('keeps every explicit rebalance entry inside one atomic change-set builder', async () => {
    const changes = new SyncChangeBuilder();
    const scope = driftGroupOrderScope('project-1', 'parent-1');
    appendAuthoredOrderRebalance(changes, {
      listKind: 'drift-group',
      scope,
      entries: authoredOrderRebalanceEntries(['group-z', 'group-ä']),
    });
    const finalized = await changes.finalize();
    expect(finalized.mutations).toHaveLength(2);
    for (const mutation of finalized.mutations) {
      const payload = decodeCanonicalCbor(mutation.payloadCbor);
      expect(mutation.mutation).toMatchObject({
        action: 'order.rebalance',
        target: { family: 'order', kind: 'drift-group' },
      });
      expect(payload.ok).toBe(true);
      if (!payload.ok) throw new Error(payload.message);
      expect(payload.value).toMatchObject({ scope });
    }
  });

  it('emits a fractional order.move', async () => {
    const changes = new SyncChangeBuilder();
    const positionKey = fractionalPositionKeyBetween(null, null);
    appendAuthoredOrderMove(changes, {
      listKind: 'storyline',
      scope: 'project-1',
      entityId: 'storyline-1',
      positionKey,
    });
    const finalized = await changes.finalize();
    const payload = decodeCanonicalCbor(finalized.mutations[0]!.payloadCbor);
    expect(payload).toMatchObject({
      ok: true,
      value: { positionKey, scope: 'project-1' },
    });
  });
});
