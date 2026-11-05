import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PROJECT_ORGANIZE,
  ORGANIZE_FIRST_LOOKBACK_MS,
  ORGANIZE_MAX_LOOKBACK_MS,
  migrateProjectOrganizeState,
  newOrganizeRun,
  organizeSince,
  readProjectOrganize,
  useProjectOrganizeStore,
} from './project-organize-store';

const NOW = new Date('2026-10-30T09:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('organize card horizon', () => {
  it('covers the author prose written since the horizon', () => {
    const horizon = ago(2 * 60 * 60 * 1000);
    expect(organizeSince(NOW, { ...EMPTY_PROJECT_ORGANIZE, horizonAt: horizon })).toBe(horizon);
  });

  it('looks back a day the first time and never past a week', () => {
    expect(organizeSince(NOW, EMPTY_PROJECT_ORGANIZE)).toBe(ago(ORGANIZE_FIRST_LOOKBACK_MS));
    expect(
      organizeSince(NOW, { ...EMPTY_PROJECT_ORGANIZE, horizonAt: ago(30 * 24 * 60 * 60 * 1000) }),
    ).toBe(ago(ORGANIZE_MAX_LOOKBACK_MS));
  });

  it('drops the retired automatic switch and failure backoff from stored state', () => {
    expect(
      migrateProjectOrganizeState({
        enabled: false,
        projects: { p1: { horizonAt: '2026-10-29T00:00:00.000Z', lastFailureAt: '2026-10-29T01:00:00.000Z', run: null } },
      }),
    ).toEqual({ projects: { p1: { horizonAt: '2026-10-29T00:00:00.000Z', run: null } } });
  });
});

describe('organize runs', () => {
  beforeEach(() => {
    useProjectOrganizeStore.setState({ projects: {}, active: {}, offers: {} });
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
    store.startRun('p1', run());
    store.finishRun('p1', 'run-1', { status: 'completed', finishedAt: '2026-10-30T08:05:00.000Z', summary: '好了' });
    expect(readProjectOrganize('p1')).toMatchObject({
      horizonAt: '2026-10-30T08:00:00.000Z',
      run: { status: 'completed', summary: '好了', dismissed: false },
    });
  });

  it('keeps the horizon for failed and interrupted runs', () => {
    const store = useProjectOrganizeStore.getState();
    store.startRun('p1', run());
    store.finishRun('p1', 'run-1', { status: 'failed', finishedAt: '2026-10-30T08:05:00.000Z', error: 'quota' });
    expect(readProjectOrganize('p1')).toMatchObject({
      horizonAt: null,
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
