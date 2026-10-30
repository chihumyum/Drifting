import { beforeEach, describe, expect, it, vi } from 'vitest';

const delta = vi.hoisted(() => ({ hasCheckinDelta: vi.fn(async (..._args: unknown[]) => false) }));
vi.mock('../lib/agent/checkin/checkin-delta', () => delta);
vi.mock('../lib/agent/checkin/checkin-runner', () => ({ runProjectCheckin: vi.fn() }));
vi.mock('../store/agent-chat-store', () => ({ useAgentChatStore: { getState: vi.fn() } }));

const { useProjectOrganizeStore } = await import('../store/project-organize-store');
const { maybeRunProjectCheckin } = await import('./useProjectCheckin');

describe('check-in after organizing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectOrganizeStore.setState({ enabled: true, projects: {}, active: {} });
  });

  it('waits while an organize pass holds the project, unless forced', async () => {
    useProjectOrganizeStore.getState().setActive('p1', true);
    await maybeRunProjectCheckin('p1', '雾港纪事');
    expect(delta.hasCheckinDelta).not.toHaveBeenCalled();
    await maybeRunProjectCheckin('p1', '雾港纪事', { force: true });
    expect(delta.hasCheckinDelta).toHaveBeenCalled();
  });
});
