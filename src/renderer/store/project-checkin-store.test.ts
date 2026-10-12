import { describe, expect, it, vi } from 'vitest';
import {
  CHECKIN_ATTEMPT_COOLDOWN_MS,
  CHECKIN_AWAY_MS,
  CHECKIN_LOOKBACK_MS,
  EMPTY_PROJECT_CHECKIN,
  decideCheckin,
  migrateProjectCheckinState,
  type ProjectCheckinRecord,
} from './project-checkin-store';

const NOW = new Date('2026-10-12T09:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function decide(
  record: Partial<ProjectCheckinRecord>,
  options: {
    changesSince?: (since: string) => boolean;
    previousOpenedAt?: string | null;
    force?: boolean;
    enabled?: boolean;
    running?: boolean;
  } = {},
) {
  const hasChangesSince = vi.fn(async (since: string) => options.changesSince?.(since) ?? false);
  return {
    hasChangesSince,
    decision: decideCheckin({
      now: NOW,
      enabled: options.enabled ?? true,
      running: options.running ?? false,
      force: options.force ?? false,
      record: { ...EMPTY_PROJECT_CHECKIN, ...record },
      previousOpenedAt: options.previousOpenedAt ?? null,
      hasChangesSince,
    }),
  };
}

describe('project check-in decision', () => {
  it('checks in on any change since the last check-in', async () => {
    const last = ago(3 * 60 * 60 * 1000);
    const { decision } = decide({ lastCheckinAt: last }, { changesSince: (since) => since === last });
    await expect(decision).resolves.toEqual({ run: true, sinceIso: last, mode: 'changes' });
  });

  it('looks back a week for the first check-in or a stale horizon', async () => {
    const { decision } = decide(
      { lastCheckinAt: ago(30 * 24 * 60 * 60 * 1000) },
      { changesSince: () => true },
    );
    await expect(decision).resolves.toEqual({
      run: true,
      sinceIso: ago(CHECKIN_LOOKBACK_MS),
      mode: 'changes',
    });
  });

  it('respects the attempt cooldown unless forced', async () => {
    const record = { lastAttemptAt: ago(CHECKIN_ATTEMPT_COOLDOWN_MS - 1000) };
    const cooled = decide(record, { changesSince: () => true });
    await expect(cooled.decision).resolves.toEqual({ run: false, reason: 'cooldown' });
    expect(cooled.hasChangesSince).not.toHaveBeenCalled();
    const forced = decide(record, { changesSince: () => true, force: true });
    await expect(forced.decision).resolves.toMatchObject({ run: true });
  });

  it('offers a pick-up check-in after an absence when no card is waiting', async () => {
    const last = ago(60 * 60 * 1000 * 30);
    const changesSince = (since: string) => since === ago(CHECKIN_LOOKBACK_MS);
    const away = decide(
      { lastCheckinAt: last },
      { changesSince, previousOpenedAt: ago(CHECKIN_AWAY_MS + 1000) },
    );
    await expect(away.decision).resolves.toEqual({
      run: true,
      sinceIso: ago(CHECKIN_LOOKBACK_MS),
      mode: 'resume',
    });
    const recent = decide({ lastCheckinAt: last }, { changesSince, previousOpenedAt: ago(1000) });
    await expect(recent.decision).resolves.toEqual({ run: false, reason: 'nothing-new' });
    const waiting = decide(
      {
        lastCheckinAt: last,
        cards: [
          {
            id: 'card',
            title: 't',
            detail: 'd',
            instruction: 'i',
            target: null,
            createdAt: last,
            status: 'open',
          },
        ],
      },
      { changesSince, previousOpenedAt: ago(CHECKIN_AWAY_MS + 1000) },
    );
    await expect(waiting.decision).resolves.toEqual({ run: false, reason: 'nothing-new' });
  });

  it('stays quiet when disabled or already running', async () => {
    await expect(decide({}, { enabled: false, changesSince: () => true }).decision).resolves.toEqual({
      run: false,
      reason: 'disabled',
    });
    await expect(decide({}, { running: true, changesSince: () => true }).decision).resolves.toEqual({
      run: false,
      reason: 'running',
    });
  });

  it('migrates v1 cards to the single card kind and drops finished ones', () => {
    const base = { title: 't', detail: 'd', target: null, createdAt: NOW.toISOString() };
    const migrated = migrateProjectCheckinState(
      {
        enabled: false,
        projects: {
          p: {
            ...EMPTY_PROJECT_CHECKIN,
            lastCheckinAt: NOW.toISOString(),
            cards: [
              { ...base, id: 'question', kind: 'question', instruction: 'ask', status: 'open' },
              { ...base, id: 'todo', kind: 'todo', instruction: '', status: 'open' },
              { ...base, id: 'done', kind: 'todo', instruction: 'x', status: 'done' },
              { ...base, id: 'started', kind: 'action', instruction: 'do', status: 'started', conversationId: 'c' },
            ],
          },
        },
      },
      1,
    );
    expect(migrated.enabled).toBe(false);
    expect(migrated.projects.p!.lastCheckinAt).toBe(NOW.toISOString());
    expect(migrated.projects.p!.cards.map((card) => card.id)).toEqual(['question', 'todo', 'started']);
    expect(migrated.projects.p!.cards[1]!.instruction).toBe('把这件事记成项目待办：d');
    expect(migrated.projects.p!.cards[0]).not.toHaveProperty('kind');
  });
});
