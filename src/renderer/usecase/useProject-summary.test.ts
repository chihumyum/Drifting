import { describe, expect, it } from 'vitest';

import {
  localProjectIdsNeedingProseMetricReconciliation,
  mergeProjectSummaries,
  type ProjectSummary,
} from './useProject';

function summary(
  source: ProjectSummary['source'],
  overrides: Partial<ProjectSummary['stats']> = {},
): ProjectSummary {
  return {
    id: 'project-1',
    userId: 'user-1',
    name: 'Book',
    summary: '',
    kvJson: '[]',
    storylineTemplateKvJson: '[]',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    source,
    stats: {
      nodes: 2,
      words: 0,
      wordsReady: false,
      storylines: 0,
      storylineLinks: 0,
      elements: 0,
      categories: 0,
      entityRelations: 0,
      inlineMentions: 0,
      ...overrides,
    },
  };
}

describe('project shelf prose metrics', () => {
  it('reconciles local projects with nodes whose canonical words are pending', () => {
    expect(
      localProjectIdsNeedingProseMetricReconciliation([
        summary('local'),
        { ...summary('local', { wordsReady: true }), id: 'ready' },
        { ...summary('local', { nodes: 0 }), id: 'empty' },
      ]),
    ).toEqual(['project-1']);
  });

  it('keeps a ready local word projection when the Server summary is pending', () => {
    const merged = mergeProjectSummaries(
      [summary('local', { words: 42_000, wordsReady: true })],
      [summary('server', { words: 0, wordsReady: false })],
    );

    expect(merged[0]?.source).toBe('server');
    expect(merged[0]?.stats.words).toBe(42_000);
    expect(merged[0]?.stats.wordsReady).toBe(true);
  });

  it('does not treat an empty local cache as authoritative for a remote project', () => {
    const merged = mergeProjectSummaries(
      [summary('local', { nodes: 0, words: 0, wordsReady: true })],
      [summary('server', { nodes: 3, words: 0, wordsReady: false })],
    );

    expect(merged[0]?.stats.words).toBe(0);
    expect(merged[0]?.stats.wordsReady).toBe(false);
  });
});
