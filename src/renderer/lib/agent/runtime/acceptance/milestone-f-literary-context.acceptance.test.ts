import { describe, expect, it } from 'vitest';

import { rankAgentContextEvidence } from '../context-evidence-retrieval';
import { loadMilestoneFLiteraryFixture } from './milestone-f-literary-fixture';

function recall(hits: number, total: number): number {
  return total === 0 ? 1 : hits / total;
}

describe('Milestone F literary context acceptance', () => {
  it('recalls canon, voice, aliases, writing rules, and chapter evidence from the real-book fixture', () => {
    const fixture = loadMilestoneFLiteraryFixture();
    const byDimension = new Map<string, { hits: number; total: number }>();
    const misses: string[] = [];

    for (const item of fixture.oracle) {
      const results = rankAgentContextEvidence({
        query: item.query,
        documents: fixture.documents,
        limit: 5,
      });
      const bucket = byDimension.get(item.dimension) ?? { hits: 0, total: 0 };
      bucket.total += 1;
      if (results.some((result) => result.evidenceId === item.expectedEvidenceId)) {
        bucket.hits += 1;
      } else {
        misses.push(`${item.id}: ${results.map((result) => result.evidenceId).join(', ')}`);
      }
      byDimension.set(item.dimension, bucket);
    }

    const metrics = Object.fromEntries(
      [...byDimension].map(([dimension, value]) => [
        dimension,
        { ...value, recallAt5: recall(value.hits, value.total) },
      ]),
    );
    console.info({
      literaryOracleCases: fixture.oracle.length,
      privateCorpusAvailable: fixture.privateCorpus.available,
      privateCorpusFiles: fixture.privateCorpus.files,
      privateCorpusBytes: fixture.privateCorpus.bytes,
      metrics,
      misses,
    });

    expect(misses).toEqual([]);
    for (const metric of Object.values(metrics)) {
      expect(metric.recallAt5).toBe(1);
    }
    if (fixture.privateCorpus.available) {
      expect(fixture.privateCorpus.files).toBeGreaterThanOrEqual(16);
      expect(fixture.privateCorpus.bytes).toBeGreaterThan(250_000);
    }
  });
});
