import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

const getConversation = vi.fn();
const revertEntityBlock = vi.fn();

vi.mock('../../sqlite-repo/agent-conversation-repo', () => ({
  createAgentConversationRepository: () => ({
    get: getConversation,
  }),
}));
vi.mock('./chapter-prose', () => ({
  revertEntityBlock,
}));

const { useAgentCheckpointStore } = await import(
  '../../store/agent-checkpoint-store'
);
const { LEGACY_TURN_REVERT_UNAVAILABLE, revertToTurn } = await import(
  './turn-revert'
);

describe('whole-turn revert compatibility gate', () => {
  beforeEach(() => {
    storage.clear();
    getConversation.mockReset();
    revertEntityBlock.mockReset();
    useAgentCheckpointStore.setState({
      activeTurn: null,
      providerNeutralProjectBarriers: {},
      checkpoints: [
        {
          turnId: 'turn-1',
          convId: 'conversation-1',
          projectId: 'project-1',
          label: 'edit',
          ts: 1,
          entities: {
            'node:chapter-1': {
              entityType: 'node',
              id: 'chapter-1',
              changes: [
                {
                  blockId: 'block-1',
                  op: 'changed',
                  oldText: 'before',
                  newText: 'after',
                  afterPrevId: null,
                },
              ],
            },
          },
        },
      ],
    });
  });

  it('does not invoke a ledger-blind inverse for a provider-neutral conversation', async () => {
    getConversation.mockResolvedValue({
      id: 'conversation-1',
      projectId: 'project-1',
      sdkSessionId: null,
      runtimeSessionId: 'runtime-session-1',
    });

    await expect(revertToTurn('project-1', 'turn-1')).rejects.toThrow(
      LEGACY_TURN_REVERT_UNAVAILABLE,
    );
    expect(revertEntityBlock).not.toHaveBeenCalled();
    expect(useAgentCheckpointStore.getState().checkpoints).toHaveLength(1);
  });

  it('does not even consult legacy identity after the project crosses the runtime barrier', async () => {
    useAgentCheckpointStore.setState({
      providerNeutralProjectBarriers: { 'project-1': 1 },
    });

    await expect(revertToTurn('project-1', 'turn-1')).rejects.toThrow(
      LEGACY_TURN_REVERT_UNAVAILABLE,
    );
    expect(getConversation).not.toHaveBeenCalled();
    expect(revertEntityBlock).not.toHaveBeenCalled();
  });
});
