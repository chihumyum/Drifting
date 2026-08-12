import { describe, expect, it } from 'vitest';
import {
  coalescePendingMutation,
  isCreatePayloadConflict,
  isTerminalPayloadValidationFailure,
} from './entity-sync-coalescing';

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

  it('does not rewrite a create that may already have committed remotely', () => {
    expect(
      coalescePendingMutation(
        { mutationType: 'create', payload: { id: 'node-1', title: 'A' } },
        { mutationType: 'update', payload: { title: 'B' } },
        { existingMayHaveReachedServer: true },
      ),
    ).toEqual({ kind: 'append' });
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

describe('isCreatePayloadConflict', () => {
  it('treats only a CREATE 409 as a terminal same-id payload conflict', () => {
    expect(isCreatePayloadConflict('create', 409)).toBe(true);
    expect(isCreatePayloadConflict('update', 409)).toBe(false);
    expect(isCreatePayloadConflict('create', 500)).toBe(false);
    expect(isCreatePayloadConflict('create', undefined)).toBe(false);
  });
});

describe('isTerminalPayloadValidationFailure', () => {
  it('quarantines deterministic 422 payload failures without classifying transient errors', () => {
    expect(isTerminalPayloadValidationFailure(422)).toBe(true);
    expect(isTerminalPayloadValidationFailure(400)).toBe(false);
    expect(isTerminalPayloadValidationFailure(401)).toBe(false);
    expect(isTerminalPayloadValidationFailure(429)).toBe(false);
    expect(isTerminalPayloadValidationFailure(500)).toBe(false);
    expect(isTerminalPayloadValidationFailure(undefined)).toBe(false);
  });
});
