import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_PROJECT_ORGANIZE,
  ORGANIZE_FAILURE_BACKOFF_MS,
  ORGANIZE_FIRST_LOOKBACK_MS,
  ORGANIZE_MAX_LOOKBACK_MS,
  decideOrganize,
  newOrganizeRun,
  readProjectOrganize,
  useProjectOrganizeStore,
  type ProjectOrganizeRecord,
} from './project-organize-store';

const NOW = new Date('2026-10-30T09:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function decide(
  record: Partial<ProjectOrganizeRecord>,
  options: { changesSince?: (since: string) => boolean; force?: boolean; enabled?: boolean } = {},
) {
  const hasChangesSince = vi.fn(async (since: string) => options.changesSince?.(since) ?? false);
  return {
    hasChangesSince,
    decision: decideOrganize({
      now: NOW,
      enabled: options.enabled ?? true,
      force: options.force ?? false,
      record: { ...EMPTY_PROJECT_ORGANIZE, ...record },
      hasChangesSince,
    }),
  };
}

describe('organize decision', () => {
  it('organizes the author prose written since the horizon', async () => {
    const horizon = ago(2 * 60 * 60 * 1000);
    const { decision } = decide({ horizonAt: horizon }, { changesSince: (since) => since === horizon });
    await expect(decision).resolves.toEqual({ run: true, sinceIso: horizon });
  });

  it('looks back a day the first time and never past a week', async () => {
    await expect(decide({}, { changesSince: () => true }).decision).resolves.toEqual({
      run: true,
      sinceIso: ago(ORGANIZE_FIRST_LOOKBACK_MS),
    });
    await expect(
      decide({ horizonAt: ago(30 * 24 * 60 * 60 * 1000) }, { changesSince: () => true }).decision,
    ).resolves.toEqual({ run: true, sinceIso: ago(ORGANIZE_MAX_LOOKBACK_MS) });
  });

  it('waits out a failure and stays off when disabled, unless forced', async () => {
    const failed = { lastFailureAt: ago(ORGANIZE_FAILURE_BACKOFF_MS - 1000) };
    const backoff = decide(failed, { changesSince: () => true });
    await expect(backoff.decision).resolves.toEqual({ run: false, reason: 'backoff' });
    expect(backoff.hasChangesSince).not.toHaveBeenCalled();
    await expect(decide({}, { enabled: false, changesSince: () => true }).decision).resolves.toEqual({
      run: false,
      reason: 'disabled',
    });
    await expect(
      decide(failed, { enabled: false, force: true, changesSince: () => true }).decision,
    ).resolves.toMatchObject({ run: true });
  });

  it('does nothing when the author wrote nothing new', async () => {
    await expect(decide({}).decision).resolves.toEqual({ run: false, reason: 'nothing-new' });
  });
});

describe('organize runs', () => {
  beforeEach(() => {
    useProjectOrganizeStore.setState({ enabled: true, projects: {}, active: {} });
  });

  const run = (id = 'run-1') =>
    newOrganizeRun({
      id,
      conversationId: `conv-${id}`,
      startedAt: '2026-10-30T08:00:00.000Z',
      sinceIso: '2026-10-29T08:00:00.000Z',
      documents: ['第一章'],
    });

  it('moves the horizon to the start of a completed run', () => {
    const store = useProjectOrganizeStore.getState();
    store.failAttempt('p1', '2026-10-29T00:00:00.000Z');
    store.startRun('p1', run());
    store.finishRun('p1', 'run-1', { status: 'completed', finishedAt: '2026-10-30T08:05:00.000Z', summary: '好了' });
    expect(readProjectOrganize('p1')).toMatchObject({
      horizonAt: '2026-10-30T08:00:00.000Z',
      lastFailureAt: null,
      run: { status: 'completed', summary: '好了', dismissed: false },
    });
  });

  it('keeps the horizon for failed and interrupted runs', () => {
    const store = useProjectOrganizeStore.getState();
    store.startRun('p1', run());
    store.finishRun('p1', 'run-1', { status: 'failed', finishedAt: '2026-10-30T08:05:00.000Z', error: 'quota' });
    expect(readProjectOrganize('p1')).toMatchObject({
      horizonAt: null,
      lastFailureAt: '2026-10-30T08:05:00.000Z',
      run: { status: 'failed', error: 'quota' },
    });
    store.startRun('p1', run('run-2'));
    store.finishRun('p1', 'run-2', { status: 'interrupted' });
    expect(readProjectOrganize('p1')).toMatchObject({ horizonAt: null, run: { id: 'run-2', status: 'interrupted' } });
  });

  it('ignores a stale run id, dismisses by id and never moves the horizon back', () => {
    const store = useProjectOrganizeStore.getState();
    store.startRun('p1', run('run-2'));
    store.finishRun('p1', 'run-1', { status: 'completed' });
    expect(readProjectOrganize('p1').run?.status).toBe('running');
    store.dismissRun('p1', 'run-2');
    expect(readProjectOrganize('p1').run?.dismissed).toBe(true);
    store.advanceHorizon('p1', '2026-10-30T08:00:00.000Z');
    store.advanceHorizon('p1', '2026-10-29T08:00:00.000Z');
    expect(readProjectOrganize('p1').horizonAt).toBe('2026-10-30T08:00:00.000Z');
  });
});
