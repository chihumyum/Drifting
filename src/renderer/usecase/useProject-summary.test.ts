import { describe, expect, it } from 'vitest';

import {
  localProjectIdsNeedingProseMetricReconciliation,
  type ProjectSummary,
} from './useProject';

function summary(id: string, nodes: number, wordsReady: boolean): ProjectSummary {
  return {
    id,
    userId: 'user-1',
    name: 'Book',
    summary: '',
    kvJson: '[]',
    storylineTemplateKvJson: '[]',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    source: 'local',
    stats: {
      nodes,
      words: 0,
      wordsReady,
      storylines: 0,
      storylineLinks: 0,
      elements: 0,
      categories: 0,
      entityRelations: 0,
      inlineMentions: 0,
    },
  };
}

describe('project shelf prose metrics', () => {
  it('reconciles local projects with nodes whose canonical words are pending', () => {
    expect(
      localProjectIdsNeedingProseMetricReconciliation([
        summary('pending', 2, false),
        summary('ready', 2, true),
        summary('empty', 0, false),
      ]),
    ).toEqual(['pending']);
  });
});
