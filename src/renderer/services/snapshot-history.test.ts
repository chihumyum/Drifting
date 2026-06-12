import { describe, expect, it } from 'vitest';
import { computeThinningVictims } from './snapshot-history.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const NOW = Date.parse('2026-06-12T12:00:00.000Z');

function row(id: string, msAgo: number) {
  return { id, createdAt: new Date(NOW - msAgo).toISOString() };
}

describe('computeThinningVictims', () => {
  it('keeps everything when rows land in distinct buckets', () => {
    const rows = [row('a', 10_000), row('b', 2 * HOUR), row('c', 3 * DAY)];
    expect(computeThinningVictims(rows, NOW)).toEqual([]);
  });

  it('keeps only the newest row per hour within the last 24h', () => {
    // newest first, both in the same clock-hour bucket
    const rows = [row('new', 5 * 60_000), row('old', 25 * 60_000)];
    const victims = computeThinningVictims(rows, NOW);
    // 5min ago = 11:55, 25min ago = 11:35 — same 11:00 hour bucket
    expect(victims).toEqual(['old']);
  });

  it('keeps only the newest row per day beyond 24h', () => {
    const base = 3 * DAY;
    const rows = [row('n1', base + HOUR), row('n2', base + 2 * HOUR), row('n3', base + 3 * HOUR)];
    const victims = computeThinningVictims(rows, NOW);
    // All three are 3 days ago within the same UTC day bucket — keep newest.
    expect(victims).toEqual(['n2', 'n3']);
  });

  it('never drops the newest row overall', () => {
    const rows = [row('newest', 1_000), row('dup', 2_000)];
    expect(computeThinningVictims(rows, NOW)).not.toContain('newest');
  });

  it('ignores malformed timestamps rather than throwing', () => {
    const rows = [
      { id: 'bad', createdAt: 'not-a-date' },
      row('good', 1_000),
    ];
    expect(computeThinningVictims(rows, NOW)).toEqual([]);
  });
});
