import { beforeEach, describe, expect, it } from 'vitest';

import { useNotificationStore } from './notification-store';

describe('notification store', () => {
  beforeEach(() => {
    useNotificationStore.setState({ items: [], centerOpen: false });
  });

  it('folds Google Drive byte progress and its terminal result into one row', () => {
    const ingest = useNotificationStore.getState().ingest;
    ingest({
      id: 'hosted-sync:generation-a:1',
      source: 'hosted-sync',
      state: 'started',
      title: 'Pulling from Google Drive…',
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
      title: 'Google Drive sync complete',
      detail: 'Novel',
      outcome: 'ok',
      at: 20,
    });

    expect(useNotificationStore.getState().items).toEqual([
      expect.objectContaining({
        id: 'hosted-sync:generation-a:1',
        source: 'hosted-sync',
        state: 'completed',
        title: 'Google Drive sync complete',
        detail: 'Novel',
        progress: undefined,
        read: false,
      }),
    ]);
  });
});
