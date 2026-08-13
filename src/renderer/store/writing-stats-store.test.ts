import { describe, expect, it } from 'vitest';

import {
  migrateWritingStatsState,
  useWritingStatsStore,
  WRITING_STATS_STORAGE_VERSION,
} from './writing-stats-store';

describe('writing stats storage migration', () => {
  it('drops the incompatible v1 aggregate baseline but preserves plans', () => {
    const current = useWritingStatsStore.getState();
    const migrated = migrateWritingStatsState(
      {
        ...current,
        history: { 'project-1': { '2026-08-13': 42_000 } },
        plans: {
          'project-1': { projectWordTarget: 120_000, dailyWordGoal: 1_500 },
        },
      },
      1,
    );

    expect(migrated.history).toEqual({});
    expect(migrated.plans['project-1']).toEqual({
      projectWordTarget: 120_000,
      dailyWordGoal: 1_500,
    });
  });

  it('leaves the current canonical history unchanged', () => {
    const current = useWritingStatsStore.getState();
    expect(migrateWritingStatsState(current, WRITING_STATS_STORAGE_VERSION)).toBe(current);
  });
});
