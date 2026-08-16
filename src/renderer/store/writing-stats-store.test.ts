import { describe, expect, it } from 'vitest';

import {
  deriveWritingStats,
  migrateWritingStatsState,
  recordTotalWordsInHistory,
  todayKey,
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

  it('converts the first v2 total into a zero-contribution baseline', () => {
    const current = useWritingStatsStore.getState();
    const migrated = migrateWritingStatsState(
      {
        ...current,
        history: {
          'project-1': {
            '2026-08-14': 42_000,
            '2026-08-15': 42_300,
          },
        },
      },
      2,
    );

    expect(migrated.history['project-1']).toEqual({
      '2026-08-14': { startTotal: 42_000, latestTotal: 42_000 },
      '2026-08-15': { startTotal: 42_000, latestTotal: 42_300 },
    });
  });

  it('removes both rebuildable history and author goals for a deleted project', () => {
    const previous = useWritingStatsStore.getState();
    useWritingStatsStore.setState({
      history: {
        'project-delete': { '2026-08-14': { startTotal: 0, latestTotal: 100 } },
        'project-keep': { '2026-08-14': { startTotal: 0, latestTotal: 200 } },
      },
      plans: {
        'project-delete': { projectWordTarget: 1_000, dailyWordGoal: 100 },
        'project-keep': { projectWordTarget: 2_000, dailyWordGoal: 200 },
      },
    });

    useWritingStatsStore.getState().clearProject('project-delete');

    expect(useWritingStatsStore.getState().history).toEqual({
      'project-keep': { '2026-08-14': { startTotal: 0, latestTotal: 200 } },
    });
    expect(useWritingStatsStore.getState().plans).toEqual({
      'project-keep': { projectWordTarget: 2_000, dailyWordGoal: 200 },
    });
    useWritingStatsStore.setState({ history: previous.history, plans: previous.plans });
  });
});

describe('writing stats daily baseline', () => {
  it('does not count an existing book as words written today', () => {
    const day = todayKey();
    const initial = recordTotalWordsInHistory(undefined, 42_000, day);

    expect(initial[day]).toEqual({ startTotal: 42_000, latestTotal: 42_000 });
    expect(deriveWritingStats(initial, 42_000).todayWords).toBe(0);
  });

  it('counts only growth after the first trusted total of the day', () => {
    const day = todayKey();
    const initial = recordTotalWordsInHistory(undefined, 42_000, day);
    const updated = recordTotalWordsInHistory(initial, 42_375, day);

    expect(updated[day]).toEqual({ startTotal: 42_000, latestTotal: 42_375 });
    expect(deriveWritingStats(updated, 42_375).todayWords).toBe(375);
  });
});
