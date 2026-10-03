import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { beginDevActivity, devActivitiesBetween, resetDevActivitiesForTest } from './dev-activity';
import { BEAT_MS, startDevWatchdog, type DevWatchdogBeat, type DevWatchdogHost } from './dev-watchdog';

function createHost(overrides: Partial<DevWatchdogHost> = {}) {
  const beats: DevWatchdogBeat[] = [];
  let visible = true;
  const visibilityTarget = new EventTarget();
  const host: DevWatchdogHost = {
    send: vi.fn(async (beat: DevWatchdogBeat) => {
      beats.push(beat);
    }),
    now: () => Date.now(),
    wallNow: () => Date.now(),
    visible: () => visible,
    context: () => ({ route: '#/project/p1' }),
    inputTarget: new EventTarget(),
    visibilityTarget,
    ...overrides,
  };
  const setVisible = (next: boolean) => {
    visible = next;
    visibilityTarget.dispatchEvent(new Event('visibilitychange'));
  };
  return { host, beats, setVisible };
}

function last(beats: DevWatchdogBeat[]): DevWatchdogBeat | undefined {
  return beats[beats.length - 1];
}

/** Advance the clock without running timers, as a blocked main thread would. */
function block(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('dev watchdog heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T06:00:00Z'));
    resetDevActivitiesForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDevActivitiesForTest();
  });

  it('beats every interval without reporting a stall', () => {
    const { host, beats } = createHost();
    const stop = startDevWatchdog(host, 'session-1');
    vi.advanceTimersByTime(BEAT_MS * 4);
    stop();
    vi.advanceTimersByTime(BEAT_MS * 4);

    expect(beats).toHaveLength(5);
    expect(beats.every((beat) => beat.sessionId === 'session-1' && beat.active)).toBe(true);
    expect(beats.some((beat) => beat.recovered)).toBe(false);
    expect(beats[0].context).toMatchObject({ route: '#/project/p1', lastInput: null, openActivities: [] });
  });

  it('reports a late timer with the last input and overlapping work', () => {
    const { host, beats } = createHost();
    startDevWatchdog(host, 'session-1');
    vi.advanceTimersByTime(BEAT_MS);

    host.inputTarget.dispatchEvent(new Event('keydown'));
    const end = beginDevActivity('agent-diff', { oldTokens: 9000, newTokens: 9100 });
    block(1_800);
    end();
    vi.advanceTimersByTime(BEAT_MS);

    const recovered = last(beats)?.recovered;
    expect(recovered).toMatchObject({
      blockedMs: 1_800,
      lastInput: { type: 'keydown', msAfterPreviousTick: 0 },
      activities: [
        {
          label: 'agent-diff',
          detail: { oldTokens: 9000, newTokens: 9100 },
          msAfterPreviousTick: 0,
          durationMs: 1_800,
          open: false,
        },
      ],
    });
    vi.advanceTimersByTime(BEAT_MS);
    expect(last(beats)?.recovered).toBeUndefined();
  });

  it('lists still-running labelled work in every heartbeat context', () => {
    const { host, beats } = createHost();
    startDevWatchdog(host, 'session-1');
    const end = beginDevActivity('markdown-projection', { forced: false });
    vi.advanceTimersByTime(BEAT_MS * 2);
    end();

    expect(last(beats)?.context.openActivities).toEqual([
      { label: 'markdown-projection', detail: { forced: false }, ageMs: BEAT_MS * 2 },
    ]);
  });

  it('does not treat hidden-page timer throttling as a stall', () => {
    const { host, beats, setVisible } = createHost();
    startDevWatchdog(host, 'session-1');
    setVisible(false);
    expect(last(beats)?.active).toBe(false);

    block(10_000);
    vi.advanceTimersByTime(BEAT_MS);
    expect(last(beats)?.recovered).toBeUndefined();

    block(10_000);
    setVisible(true);
    vi.advanceTimersByTime(BEAT_MS);
    expect(last(beats)).toMatchObject({ active: true });
    expect(last(beats)?.recovered).toBeUndefined();
  });

  it('stops after repeated delivery failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(() => Promise.reject(new Error('command not registered')));
    const { host } = createHost({ send });
    startDevWatchdog(host, 'session-1');
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(BEAT_MS);
    }

    expect(send).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('dev activity labels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T06:00:00Z'));
    resetDevActivitiesForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDevActivitiesForTest();
  });

  it('keeps only work long enough to matter and filters by overlap', () => {
    const start = Date.now();
    beginDevActivity('short')();
    const long = beginDevActivity('long');
    block(50);
    long();
    block(1_000);
    const running = beginDevActivity('running');
    block(5);

    expect(devActivitiesBetween(start, Date.now()).map(({ label }) => label)).toEqual([
      'long',
      'running',
    ]);
    expect(devActivitiesBetween(start + 100, Date.now()).map(({ label }) => label)).toEqual([
      'running',
    ]);
    running();
  });
});
