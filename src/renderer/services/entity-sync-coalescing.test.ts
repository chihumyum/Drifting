import { describe, expect, it } from 'vitest';
import { coalescePendingMutation } from './entity-sync-coalescing';

describe('coalescePendingMutation', () => {
  it('merges partial update payloads instead of dropping earlier fields', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'update', payload: { title: 'A', wordCount: 10 } },
        { mutationType: 'update', payload: { summary: 'B', wordCount: 12 } },
      ),
    ).toEqual({
      kind: 'replace',
      mutationType: 'update',
      payload: { title: 'A', summary: 'B', wordCount: 12 },
    });
  });

  it('folds an update into a pending create', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'create', payload: { id: 'node-1', title: 'A' } },
        { mutationType: 'update', payload: { title: 'B' } },
      ),
    ).toEqual({
      kind: 'replace',
      mutationType: 'create',
      payload: { id: 'node-1', title: 'B' },
    });
  });

  it('cancels a create followed by a hard delete', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'create', payload: { id: 'node-1' } },
        { mutationType: 'delete' },
      ),
    ).toEqual({ kind: 'cancel' });
  });

  it('keeps parent create/delete ordering when child mutations may sit between them', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'create', payload: { id: 'storyline-1' } },
        { mutationType: 'delete' },
        { cancelCreateDelete: false },
      ),
    ).toEqual({ kind: 'append' });
  });

  it('cancels adjacent soft-delete and restore pairs in either direction', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'softDelete' },
        { mutationType: 'restore' },
      ),
    ).toEqual({ kind: 'cancel' });
    expect(
      coalescePendingMutation(
        { mutationType: 'restore' },
        { mutationType: 'softDelete' },
      ),
    ).toEqual({ kind: 'cancel' });
  });

  it('preserves ordering across incompatible operations', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'softDelete' },
        { mutationType: 'update', payload: { title: 'after restore only' } },
      ),
    ).toEqual({ kind: 'append' });
  });
});
