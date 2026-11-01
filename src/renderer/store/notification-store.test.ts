import { beforeEach, describe, expect, it } from 'vitest';

import { useNotificationStore } from './notification-store';

describe('notification store', () => {
  beforeEach(() => {
    useNotificationStore.setState({ items: [], centerOpen: false, centerOwner: null });
  });

  it('folds cloud sync byte progress and its terminal result into one row', () => {
    const ingest = useNotificationStore.getState().ingest;
    ingest({
      id: 'hosted-sync:generation-a:1',
      source: 'hosted-sync',
      state: 'started',
      title: 'Downloading from the cloud…',
      detail: '8 MB / 16 MB · 1 / 2 items',
      progress: {
        value: 0.5,
        transferredBytes: 8,
        totalBytes: 16,
        completedObjects: 1,
        totalObjects: 2,
      },
      at: 10,
    });
    ingest({
      id: 'hosted-sync:generation-a:1',
      source: 'hosted-sync',
      state: 'completed',
      title: 'Cloud sync complete',
      detail: 'Novel',
      outcome: 'ok',
      at: 20,
    });

    expect(useNotificationStore.getState().items).toEqual([
      expect.objectContaining({
        id: 'hosted-sync:generation-a:1',
        source: 'hosted-sync',
        state: 'completed',
        title: 'Cloud sync complete',
        detail: 'Novel',
        progress: undefined,
        read: false,
      }),
    ]);
  });

  it('keeps a sync problem first in mind until it resolves, then lets it go like any row', () => {
    const { ingest } = useNotificationStore.getState();
    const problem = {
      problem: 'failing' as const,
      projectId: 'project-a',
      syncGenerationIds: ['sync-a'],
      errorCode: 'SYNC_CYCLE_FAILED',
      failures: 3,
    };
    ingest({
      id: 'sync-problem:project-a',
      source: 'hosted-sync',
      state: 'failed',
      title: 'Cloud sync failed',
      error: 'Error code: SYNC_CYCLE_FAILED · 3 times in a row',
      at: 10,
      syncProblem: problem,
    });
    ingest({ id: 'other', source: 'app-update', state: 'completed', title: 'Updated', at: 20 });

    useNotificationStore.getState().remove('sync-problem:project-a');
    useNotificationStore.getState().clear();
    expect(useNotificationStore.getState().items.map((n) => n.id)).toEqual(['sync-problem:project-a']);

    ingest({
      id: 'sync-problem:project-a',
      source: 'hosted-sync',
      state: 'completed',
      title: 'Sync resumed',
      error: undefined,
      at: 30,
      syncProblem: null,
    });
    const [resumed] = useNotificationStore.getState().items;
    expect(resumed).toMatchObject({ state: 'completed', title: 'Sync resumed', read: false });
    expect(resumed.error).toBeUndefined();
    expect(resumed.detail).toBeUndefined();
    expect(resumed.syncProblem).toBeUndefined();
    useNotificationStore.getState().remove('sync-problem:project-a');
    expect(useNotificationStore.getState().items).toEqual([]);
  });

  it('remembers which bell opened the center', () => {
    useNotificationStore.getState().toggleCenter('bell-a');
    expect(useNotificationStore.getState()).toMatchObject({ centerOpen: true, centerOwner: 'bell-a' });
    useNotificationStore.getState().setCenterOpen(false);
    expect(useNotificationStore.getState()).toMatchObject({ centerOpen: false, centerOwner: null });
  });
});
