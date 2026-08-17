import { describe, expect, it } from 'vitest';

import { appendAuthoredDomainMutation } from './domain-mutation';
import { SyncChangeBuilder } from './change-builder';

describe('authored domain mutation wire classification', () => {
  it('keeps authored fields and removes SQLite identity, timestamps and projections', async () => {
    const changes = new SyncChangeBuilder();
    appendAuthoredDomainMutation(changes, {
      entityType: 'agentMemory',
      mutationType: 'update',
      entityId: 'memory-1',
      projectId: 'project-1',
      payload: {
        id: 'memory-1',
        projectId: 'project-1',
        body: 'Portable authored memory',
        createdAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:01:00.000Z',
      },
    });

    const finalized = await changes.finalize();
    expect(finalized.mutations.map(({ mutation }) => mutation)).toMatchObject([
      {
        action: 'field.set',
        target: { kind: 'agent-memory', id: 'memory-1' },
        payload: { field: 'body', value: 'Portable authored memory' },
      },
    ]);
  });

  it('leaves asset ownership and ordering to their dedicated mutations', async () => {
    const changes = new SyncChangeBuilder();
    appendAuthoredDomainMutation(changes, {
      entityType: 'libraryItem',
      mutationType: 'update',
      entityId: 'library-1',
      projectId: 'project-1',
      payload: {
        title: 'Reference',
        assetId: 'asset-owned-by-asset.bind',
        orderKey: 42,
        previewImageUrl: 'https://example.invalid/derived-preview.png',
      },
    });

    const finalized = await changes.finalize();
    expect(finalized.mutations).toHaveLength(1);
    expect(finalized.mutations[0]!.mutation.payload).toEqual({
      field: 'title',
      value: 'Reference',
    });
  });

  it('keeps continuous timeline coordinates in scalar LWW mutations', async () => {
    const changes = new SyncChangeBuilder();
    appendAuthoredDomainMutation(changes, {
      entityType: 'node',
      mutationType: 'update',
      entityId: 'chapter-1',
      projectId: 'project-1',
      payload: { bookOrder: 7.375, narrativeOrder: 2.625 },
    });
    appendAuthoredDomainMutation(changes, {
      entityType: 'bookAct',
      mutationType: 'update',
      entityId: 'act-1',
      projectId: 'project-1',
      payload: { startOrder: 4.125 },
    });

    const finalized = await changes.finalize();
    expect(finalized.mutations.map(({ mutation }) => mutation)).toEqual([
      expect.objectContaining({
        action: 'field.set',
        target: expect.objectContaining({ kind: 'node', id: 'chapter-1' }),
        payload: { field: 'bookOrder', value: 7.375 },
      }),
      expect.objectContaining({
        action: 'field.set',
        target: expect.objectContaining({ kind: 'node', id: 'chapter-1' }),
        payload: { field: 'narrativeOrder', value: 2.625 },
      }),
      expect.objectContaining({
        action: 'field.set',
        target: expect.objectContaining({ kind: 'book-act', id: 'act-1' }),
        payload: { field: 'startOrder', value: 4.125 },
      }),
    ]);
  });

  it('keeps main prose contentJson out of entity seeds and incremental field registers', async () => {
    const changes = new SyncChangeBuilder();
    appendAuthoredDomainMutation(changes, {
      entityType: 'element',
      mutationType: 'create',
      entityId: 'element-1',
      projectId: 'project-1',
      payload: {
        name: 'Character',
        summary: 'Portable metadata',
        contentJson: '{"type":"doc","content":[]}',
      },
    });
    appendAuthoredDomainMutation(changes, {
      entityType: 'storyline',
      mutationType: 'update',
      entityId: 'storyline-1',
      projectId: 'project-1',
      payload: {
        summary: 'Changed metadata',
        contentJson: '{"type":"doc","content":[]}',
      },
    });

    const finalized = await changes.finalize();
    expect(finalized.mutations.map(({ mutation }) => mutation)).toMatchObject([
      {
        action: 'entity.create',
        target: { kind: 'element', id: 'element-1' },
        payload: { seed: { name: 'Character', summary: 'Portable metadata' } },
      },
      {
        action: 'field.set',
        target: { kind: 'storyline', id: 'storyline-1' },
        payload: { field: 'summary', value: 'Changed metadata' },
      },
    ]);
    expect(JSON.stringify(finalized.mutations)).not.toContain('contentJson');
  });

  it('rejects projection-only contentJson as an authored update', () => {
    expect(() =>
      appendAuthoredDomainMutation(new SyncChangeBuilder(), {
        entityType: 'nodeContent',
        mutationType: 'update',
        entityId: 'node-1',
        projectId: 'project-1',
        payload: { contentJson: '{"type":"doc","content":[]}' },
      }),
    ).toThrow(/must contain at least one authored field/u);
  });

  it('fails closed when a project-scoped field has no manifest classification', () => {
    const changes = new SyncChangeBuilder();
    expect(() =>
      appendAuthoredDomainMutation(changes, {
        entityType: 'node',
        mutationType: 'update',
        entityId: 'node-1',
        projectId: 'project-1',
        payload: { futureUnclassifiedField: true },
      }),
    ).toThrow(/not classified by the sync domain manifest/u);
  });
});
