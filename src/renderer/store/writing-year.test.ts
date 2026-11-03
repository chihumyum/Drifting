import { describe, expect, it } from 'vitest';

import {
  deriveWritingYear,
  summarizeWritingDays,
  WRITING_YEAR_WEEKS,
  writingDayLevel,
  writingDayThresholds,
  writingYearStart,
} from './writing-stats-store';

describe('a year of writing days', () => {
  it('starts on the Monday 52 weeks before the week holding today', () => {
    // 2026-11-03 is a Tuesday.
    expect(writingYearStart('2026-11-03')).toBe('2025-11-03');
    expect(writingYearStart('2026-11-02')).toBe('2025-11-03');
    expect(writingYearStart('2026-11-08')).toBe('2025-11-03');
    expect(writingYearStart('2026-11-09')).toBe('2025-11-10');
    const year = deriveWritingYear([], '2026-11-03');
    expect(year.days[0]).toBe('2025-11-03');
    expect(year.days[year.days.length - 1]).toBe('2026-11-03');
    expect(year.days).toHaveLength((WRITING_YEAR_WEEKS - 1) * 7 + 2);
  });

  it('sums the books of a day and keeps each book apart, dropping days outside the year', () => {
    const year = deriveWritingYear([
      { projectId: 'a', day: '2026-11-03', words: 300 },
      { projectId: 'b', day: '2026-11-03', words: 120 },
      { projectId: 'a', day: '2026-11-01', words: 50 },
      { projectId: 'a', day: '2025-11-02', words: 999 },
      { projectId: 'b', day: '2026-11-04', words: 999 },
      { projectId: 'c', day: '2026-11-02', words: 0 },
    ], '2026-11-03');
    expect(year.total[year.total.length - 1]).toBe(420);
    expect(year.total[year.total.length - 3]).toBe(50);
    expect(year.byProject.a[year.byProject.a.length - 1]).toBe(300);
    expect(year.byProject.b[year.byProject.b.length - 1]).toBe(120);
    expect(year.byProject.c).toBeUndefined();
    expect(year.total.reduce((sum, words) => sum + words, 0)).toBe(470);
  });

  it('counts the words, the days written, the streak ending today and today', () => {
    expect(summarizeWritingDays([0, 200, 0, 100, 50, 30])).toEqual({ words: 380, daysWritten: 4, streakDays: 3, todayWords: 30 });
    // As the stats panel counts it, a day not yet written breaks the streak.
    expect(summarizeWritingDays([100, 100, 0]).streakDays).toBe(0);
    expect(summarizeWritingDays([])).toEqual({ words: 0, daysWritten: 0, streakDays: 0, todayWords: 0 });
  });

  it('puts the days written into four levels by their quartiles', () => {
    const daily = [0, 100, 200, 300, 400, 500, 600, 700, 800];
    const thresholds = writingDayThresholds(daily);
    expect(thresholds).toEqual([300, 500, 700]);
    expect(daily.map((words) => writingDayLevel(words, thresholds))).toEqual([0, 1, 1, 1, 2, 2, 3, 3, 4]);
    expect(writingDayThresholds([0, 0])).toEqual([1, 1, 1]);
    expect(writingDayLevel(-5, thresholds)).toBe(0);
  });
});
