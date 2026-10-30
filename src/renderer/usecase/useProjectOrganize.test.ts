import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import type { AgentChatMessage } from '../domain/agent-conversation';
import type { CheckinChangedDocument } from '../lib/agent/checkin/checkin-delta';

const delta = vi.hoisted(() => ({
  documents: [] as CheckinChangedDocument[],
  hasCheckinDelta: vi.fn(async (..._args: unknown[]) => true),
  collectCheckinDelta: vi.fn(async (..._args: unknown[]): Promise<CheckinChangedDocument[]> => []),
}));
vi.mock('../lib/agent/checkin/checkin-delta', () => ({
  hasCheckinDelta: delta.hasCheckinDelta,
  collectCheckinDelta: delta.collectCheckinDelta,
}));

const checkin = vi.hoisted(() => ({ maybeRunProjectCheckin: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock('./useProjectCheckin', () => checkin);

const transport = vi.hoisted(() => ({
  usable: true,
}));
vi.mock('../lib/agent/transport', () => ({
  generalAgentTransport: {
    capability: { available: true },
    authStatus: vi.fn(async () => ({
      ok: true,
      value: { byokConnected: transport.usable, apiKeyConnected: transport.usable, hostedAvailable: transport.usable },
    })),
  },
}));
vi.mock('../store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ agentAuth: 'byok' }) },
}));

vi.mock('../store/project-store', async () => {
  const { create } = await import('zustand');
  return {
    useProjectStore: create(() => ({ currentProject: { id: 'p1', name: '雾港纪事' }, projects: [] })),
  };
});

vi.mock('../store/agent-chat-store', async () => {
  const { create } = await import('zustand');
  return {
    useAgentChatStore: create<Record<string, unknown>>(() => ({
      boundProjectId: 'p1',
      runningTurns: {},
      runs: {},
      bindProject: vi.fn(),
      send: vi.fn(),
    })),
  };
});

const { useAgentChatStore } = await import('../store/agent-chat-store');
const { useNotificationStore } = await import('../store/notification-store');
const { readProjectOrganize, useProjectOrganizeStore } = await import('../store/project-organize-store');
const { maybeRunProjectOrganize, recoverInterruptedOrganize } = await import('./useProjectOrganize');

const chapter: CheckinChangedDocument = {
  ref: 'c1',
  entityType: 'node',
  entityId: 'node-1',
  objectKind: 'chapter',
  title: '第一章',
  lastChangedAt: '2026-10-30T08:00:00.000Z',
  revisions: { user: 2, agent: 0, remote: 0 },
  hasBaseline: true,
  digest: '+ 新来的旅人自称阿岚。',
};

function liveRun(messages: AgentChatMessage[], outcome: 'completed' | 'failed' | 'aborted' | null) {
  return {
    projectId: 'p1',
    backgroundTask: true,
    transcript: AgentChatTranscript.from(messages),
    lastTerminal: outcome ? { turnId: 'turn-1', outcome } : null,
    automaticContinuation: { status: 'off' },
  };
}

function setChat(patch: Record<string, unknown>) {
  (useAgentChatStore as unknown as { setState: (patch: Record<string, unknown>) => void }).setState(patch);
}

describe('organize on return', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.usable = true;
    delta.hasCheckinDelta.mockResolvedValue(true);
    delta.collectCheckinDelta.mockResolvedValue([chapter]);
    useProjectOrganizeStore.setState({ enabled: true, projects: {}, active: {} });
    useNotificationStore.setState({ items: [], centerOpen: false });
    setChat({ runningTurns: {}, runs: {}, send: vi.fn() });
  });

  it('organizes the author prose in a background session and hands over to the check-in', async () => {
    const send = vi.fn(async (options: { onStarted?: (id: string) => void }) => {
      setChat({ runningTurns: { 'conv-1': 'turn-1' }, runs: { 'conv-1': liveRun([], null) } });
      options.onStarted?.('conv-1');
    });
    setChat({ send });

    const pending = maybeRunProjectOrganize('p1');
    // Claimed before any await, so a check-in fired by the same return waits.
    expect(useProjectOrganizeStore.getState().active.p1).toBe(true);
    await pending;

    expect(delta.collectCheckinDelta).toHaveBeenCalledWith('p1', expect.any(String), 12, {
      sources: ['user'],
      objectKinds: ['chapter', 'idea'],
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        toolAccess: 'read_write',
        background: { title: '整理：第一章' },
        runtimePrompt: expect.stringContaining('+ 新来的旅人自称阿岚。'),
      }),
    );
    const started = readProjectOrganize('p1').run;
    expect(started).toMatchObject({ conversationId: 'conv-1', status: 'running', documents: ['第一章'] });
    expect(useNotificationStore.getState().items[0]).toMatchObject({
      id: `agent-organize:${started?.id}`,
      source: 'agent-organize',
      state: 'running',
      projectHomeId: 'p1',
    });
    expect(checkin.maybeRunProjectCheckin).not.toHaveBeenCalled();

    setChat({
      runningTurns: {},
      runs: {
        'conv-1': liveRun(
          [
            { kind: 'user', text: '整理' },
            { kind: 'tool', id: 't1', name: 'create_element', status: 'ok' },
            { kind: 'tool', id: 't2', name: 'create_element_patch', status: 'ok' },
            { kind: 'assistant', text: '新建了阿岚。' },
          ],
          'completed',
        ),
      },
    });

    expect(readProjectOrganize('p1')).toMatchObject({
      horizonAt: started?.startedAt,
      run: {
        status: 'completed',
        summary: '新建了阿岚。',
        counts: { elementsCreated: 1, elementsUpdated: 0, patches: 1, relations: 0 },
      },
    });
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(useNotificationStore.getState().items[0]).toMatchObject({
      state: 'completed',
      read: false,
      projectHomeId: 'p1',
    });
    expect(useProjectOrganizeStore.getState().active.p1).toBe(false);
    expect(checkin.maybeRunProjectCheckin).toHaveBeenCalledWith('p1', '雾港纪事', { afterOrganize: true });
  });

  it('reports a failed session and keeps its prose for a later return', async () => {
    setChat({
      send: vi.fn(async (options: { onStarted?: (id: string) => void }) => {
        setChat({ runs: { 'conv-2': liveRun([{ kind: 'user', text: '整理' }], 'failed') } });
        options.onStarted?.('conv-2');
      }),
    });
    await maybeRunProjectOrganize('p1');
    expect(readProjectOrganize('p1')).toMatchObject({ horizonAt: null, run: { status: 'failed' } });
    expect(readProjectOrganize('p1').lastFailureAt).not.toBeNull();
    expect(useNotificationStore.getState().items[0]).toMatchObject({ state: 'failed', source: 'agent-organize' });
    expect(checkin.maybeRunProjectCheckin).toHaveBeenCalledWith('p1', '雾港纪事', { afterOrganize: false });
  });

  it('starts nothing when the author wrote nothing new or only reformatted', async () => {
    delta.hasCheckinDelta.mockResolvedValueOnce(false);
    await maybeRunProjectOrganize('p1');
    delta.collectCheckinDelta.mockResolvedValueOnce([{ ...chapter, digest: '（只有格式或空白变化）' }]);
    await maybeRunProjectOrganize('p1');
    const send = useAgentChatStore.getState().send;
    expect(send).not.toHaveBeenCalled();
    expect(readProjectOrganize('p1').horizonAt).not.toBeNull();
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(checkin.maybeRunProjectCheckin).toHaveBeenCalledTimes(2);
    expect(useProjectOrganizeStore.getState().active.p1).toBe(false);
  });

  it('skips quietly while no Agent provider is connected', async () => {
    transport.usable = false;
    await maybeRunProjectOrganize('p1');
    expect(useAgentChatStore.getState().send).not.toHaveBeenCalled();
    expect(readProjectOrganize('p1')).toMatchObject({ horizonAt: null, lastFailureAt: null, run: null });
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(checkin.maybeRunProjectCheckin).toHaveBeenCalledWith('p1', '雾港纪事', { afterOrganize: false });
  });

  it('leaves the check-in alone when organizing is turned off', async () => {
    useProjectOrganizeStore.setState({ enabled: false });
    await maybeRunProjectOrganize('p1');
    expect(delta.hasCheckinDelta).not.toHaveBeenCalled();
    expect(checkin.maybeRunProjectCheckin).not.toHaveBeenCalled();
    expect(useProjectOrganizeStore.getState().active.p1).toBeUndefined();
  });

  it('marks a run cut off by a quit as interrupted without moving the horizon', () => {
    useProjectOrganizeStore.getState().startRun('p1', {
      id: 'old-run',
      conversationId: 'conv-old',
      startedAt: '2026-10-29T08:00:00.000Z',
      sinceIso: '2026-10-28T08:00:00.000Z',
      finishedAt: null,
      status: 'running',
      documents: ['第一章'],
      summary: '',
      counts: { elementsCreated: 0, elementsUpdated: 0, patches: 0, relations: 0 },
      entities: [],
      error: null,
      dismissed: false,
    });
    recoverInterruptedOrganize('p1');
    expect(readProjectOrganize('p1')).toMatchObject({ horizonAt: null, run: { status: 'interrupted' } });
  });
});
