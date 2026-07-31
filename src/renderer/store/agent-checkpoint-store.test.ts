import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

const { useAgentCheckpointStore } = await import('./agent-checkpoint-store');

const change = {
  blockId: 'block-1',
  op: 'changed' as const,
  oldText: 'before',
  newText: 'after',
  afterPrevId: null,
};

describe('agent checkpoint compatibility boundary', () => {
  beforeEach(() => {
    storage.clear();
    useAgentCheckpointStore.setState({
      checkpoints: [],
      activeTurn: null,
      providerNeutralProjectBarriers: {},
    });
  });

  it('seals a provider-neutral project and refuses to collect its writes', () => {
    const store = useAgentCheckpointStore.getState();
    store.beginTurn({
      turnId: 'runtime-turn',
      convId: 'runtime-conversation',
      projectId: 'project-1',
      label: 'runtime',
    });
    useAgentCheckpointStore
      .getState()
      .recordChanges('node', 'chapter-1', [change]);

    const state = useAgentCheckpointStore.getState();
    expect(state.activeTurn).toBeNull();
    expect(state.providerNeutralProjectBarriers['project-1']).toEqual(
      expect.any(Number),
    );
    expect(state.checkpoints).toEqual([]);
  });

  it('keeps checkpoint collection only for an explicitly legacy SDK turn', () => {
    const store = useAgentCheckpointStore.getState();
    store.beginTurn({
      turnId: 'legacy-turn',
      convId: 'legacy-conversation',
      projectId: 'project-1',
      label: 'legacy',
      revertAuthority: 'legacy-sdk',
    });
    useAgentCheckpointStore
      .getState()
      .recordChanges('node', 'chapter-1', [change]);

    expect(useAgentCheckpointStore.getState().checkpoints).toEqual([
      expect.objectContaining({
        turnId: 'legacy-turn',
        revertAuthority: 'legacy-sdk',
        projectId: 'project-1',
      }),
    ]);
  });
});
