import { describe, expect, it } from 'vitest';

import { createYjsProseSeedState } from '../lib/agent/runtime/yjs-prose-command';
import {
  canReuseCanonicalProjection,
  deriveCanonicalNodeProseProjection,
} from './node-prose-metrics.service';
import type { BookNode } from '../domain/book-node';

const contentJson = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '重建 exact metric' }] }],
});

describe('node prose metric projection', () => {
  it('records a seed basis without inventing a Yjs revision', async () => {
    const stateUpdate = await createYjsProseSeedState(contentJson);
    const projection = await deriveCanonicalNodeProseProjection('node-1', {
      docId: 'node-content:node-1',
      sourceKind: 'seed',
      revision: 0,
      stateVector: new Uint8Array(),
      stateHash: 'unused',
      stateUpdate,
    });
    expect(projection.wordCount).toBe(4);
    expect(projection.wordCountBasisKind).toBe('seed');
    expect(projection.wordCountBasisRevision).toBeNull();
  });

  it('binds the same semantic projection to an exact durable Yjs revision', async () => {
    const stateUpdate = await createYjsProseSeedState(contentJson);
    const projection = await deriveCanonicalNodeProseProjection('node-1', {
      docId: 'node-content:node-1',
      sourceKind: 'closed',
      revision: 7,
      stateVector: new Uint8Array(),
      stateHash: 'unused',
      stateUpdate,
    });
    expect(projection.wordCountBasisKind).toBe('yjs');
    expect(projection.wordCountBasisRevision).toBe(7);
    expect(projection.wordCountBasisHash).toMatch(/^sha256:/u);
  });

  it('rebuilds non-zero legacy or wrong-hash scalars but reuses an exact Server basis', async () => {
    const stateUpdate = await createYjsProseSeedState(contentJson);
    const projection = await deriveCanonicalNodeProseProjection('node-1', {
      docId: 'node-content:node-1',
      sourceKind: 'closed',
      revision: 7,
      stateVector: new Uint8Array(),
      stateHash: 'unused',
      stateUpdate,
    });
    const baseNode = {
      id: 'node-1',
      projectId: 'project-1',
      title: 'Chapter',
      summary: '',
      narrativeOrder: null,
      driftGroupId: null,
      position: { x: 0, y: 0 },
      wordCount: projection.wordCount,
      kind: 'chapter',
      bookOrder: 0,
      writingStatus: 'draft',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    } satisfies BookNode;
    const content = {
      contentJson: projection.contentJson,
      outlineJson: projection.outlineJson,
    };

    expect(canReuseCanonicalProjection(baseNode, content, projection)).toBe(false);
    expect(
      canReuseCanonicalProjection(
        { ...baseNode, wordCountBasisKind: 'seed', wordCountBasisHash: 'sha256:stale' },
        content,
        projection,
      ),
    ).toBe(false);
    expect(
      canReuseCanonicalProjection(
        {
          ...baseNode,
          wordCountBasisKind: 'yjs',
          wordCountBasisHash: projection.wordCountBasisHash,
          wordCountBasisRevision: null,
          wordCountBasisServerSeq: 22,
        },
        content,
        projection,
      ),
    ).toBe(true);
    expect(
      canReuseCanonicalProjection(
        {
          ...baseNode,
          wordCountBasisKind: 'yjs',
          wordCountBasisHash: projection.wordCountBasisHash,
          wordCountBasisRevision: 6,
          wordCountBasisServerSeq: null,
        },
        content,
        projection,
      ),
    ).toBe(false);

    const seedProjection = { ...projection, wordCountBasisKind: 'seed' as const };
    expect(
      canReuseCanonicalProjection(
        {
          ...baseNode,
          wordCountBasisKind: 'yjs',
          wordCountBasisHash: projection.wordCountBasisHash,
          wordCountBasisRevision: 7,
          wordCountBasisServerSeq: null,
        },
        content,
        seedProjection,
      ),
    ).toBe(false);
  });
});
