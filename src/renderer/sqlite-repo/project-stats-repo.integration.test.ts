import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { isProseMetricBasisHash } from '@drifting/prose-metrics';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_NOW } from '../services/workspace-projection.test-support';
import { BookNodeTable, NodeStorylineLinkTable, InlineMentionTable } from '../schema/drizzle';
import { readProjectStats } from './project-stats-repo';

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => {
  if (fixture) {
    expect(fixture.gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    await fixture.close(); fixture = undefined;
  }
});
const validHash = `sha256:${'a'.repeat(64)}`;

describe('project shelf aggregate', () => {
  it('counts every collection in one snapshot, excluding deleted nodes and their memberships', async () => {
    fixture = await createWorkspaceProjectionFixture();
    const { db, gateway } = fixture;
    await db.update(BookNodeTable).set({ wordCount: 12, wordCountBasisKind: 'seed', wordCountBasisHash: validHash }).where(eq(BookNodeTable.id, 'chapter'));
    await db.insert(BookNodeTable).values({ id: 'trash', positionX: 0, positionY: 0, projectId: 'synthetic-workspace', kind: 'chapter', title: 'Trash', wordCount: 900, deletedAt: WORKSPACE_TEST_NOW, createdAt: WORKSPACE_TEST_NOW, updatedAt: WORKSPACE_TEST_NOW });
    await db.insert(NodeStorylineLinkTable).values([{ nodeId: 'trash', storylineId: 'main' }, { nodeId: 'chapter', storylineId: 'support' }]);
    await db.insert(InlineMentionTable).values({ id: 'mention', projectId: 'synthetic-workspace', fromKind: 'node', fromId: 'chapter', fromBlockId: 'block', fromSpansJson: '[]', toKind: 'element', toId: 'element', createdAt: WORKSPACE_TEST_NOW, updatedAt: WORKSPACE_TEST_NOW });
    const query = vi.spyOn(gateway, 'query');
    expect(await readProjectStats('synthetic-workspace', db)).toEqual({ nodes: 2, words: 12, wordsReady: true, storylines: 2, storylineLinks: 2, elements: 1, categories: 1, entityRelations: 1, inlineMentions: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    expect((await query.mock.results[0].value).rows).toHaveLength(1);
    expect(query.mock.calls[0][1]).toHaveLength(7);
    expect(await readProjectStats('other-project', db)).toEqual({ nodes: 0, words: 0, wordsReady: true, storylines: 0, storylineLinks: 0, elements: 0, categories: 0, entityRelations: 0, inlineMentions: 0 });
  });

  it('matches the portable hash predicate and existing seed/revision/sequence semantics', async () => {
    fixture = await createWorkspaceProjectionFixture();
    const { db } = fixture;
    const hashes = [null, '', validHash, validHash.toUpperCase(), validHash.slice(0, -1), `${validHash}a`, `sha256:${'g'.repeat(64)}`, `${validHash}\n`, `${validHash}\0`, `${validHash}\0extra`, `sha256:${'a'.repeat(63)}é`, `SHA256:${'a'.repeat(64)}`];
    const bases = [
      { wordCountBasisKind: null, wordCountBasisRevision: null, wordCountBasisServerSeq: null },
      { wordCountBasisKind: '', wordCountBasisRevision: 0, wordCountBasisServerSeq: null },
      { wordCountBasisKind: 'seed', wordCountBasisRevision: null, wordCountBasisServerSeq: null },
      { wordCountBasisKind: 'yjs', wordCountBasisRevision: null, wordCountBasisServerSeq: null },
      { wordCountBasisKind: 'yjs', wordCountBasisRevision: 0, wordCountBasisServerSeq: null },
      { wordCountBasisKind: 'yjs', wordCountBasisRevision: null, wordCountBasisServerSeq: 0 },
      { wordCountBasisKind: 'future-kind', wordCountBasisRevision: 1, wordCountBasisServerSeq: null },
    ];
    for (const wordCountBasisHash of hashes) for (const basis of bases) {
      await db.update(BookNodeTable).set({ ...basis, wordCountBasisHash, wordCount: 17 }).where(eq(BookNodeTable.id, 'chapter'));
      const expected = Boolean(basis.wordCountBasisKind && isProseMetricBasisHash(wordCountBasisHash)) && (basis.wordCountBasisKind === 'seed' || basis.wordCountBasisRevision != null || basis.wordCountBasisServerSeq != null);
      const stats = await readProjectStats('synthetic-workspace', db);
      expect({ words: stats.words, ready: stats.wordsReady }, JSON.stringify({ wordCountBasisHash, ...basis })).toEqual({ words: expected ? 17 : 0, ready: expected });
    }
  });

  it('keeps partial words while any live chapter is pending, and ignores nonchapter metrics', async () => {
    fixture = await createWorkspaceProjectionFixture();
    const { db } = fixture;
    await db.update(BookNodeTable).set({ wordCount: 900, wordCountBasisKind: 'seed', wordCountBasisHash: validHash }).where(eq(BookNodeTable.id, 'drift'));
    await db.insert(BookNodeTable).values({ id: 'ready', positionX: 0, positionY: 0, projectId: 'synthetic-workspace', title: 'Ready', kind: 'chapter', wordCount: 7, wordCountBasisKind: 'yjs', wordCountBasisHash: validHash, wordCountBasisRevision: 0, createdAt: WORKSPACE_TEST_NOW, updatedAt: WORKSPACE_TEST_NOW });
    expect(await readProjectStats('synthetic-workspace', db)).toMatchObject({ nodes: 3, words: 7, wordsReady: false });
    await db.update(BookNodeTable).set({ deletedAt: WORKSPACE_TEST_NOW }).where(eq(BookNodeTable.id, 'chapter'));
    expect(await readProjectStats('synthetic-workspace', db)).toMatchObject({ nodes: 2, words: 7, wordsReady: true });
  });

  it('does not publish invented zero counts when the gateway fails', async () => {
    fixture = await createWorkspaceProjectionFixture();
    vi.spyOn(fixture.gateway, 'query').mockRejectedValueOnce(new Error('synthetic gateway failure'));
    await expect(readProjectStats('synthetic-workspace', fixture.db)).rejects.toThrow();
  });
});
