import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import type { CreateAgentConversationInput } from '../sqlite-repo/agent-conversation-repo';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport, type GeneralAgentTransport } from '../lib/agent/transport';
import { useAgentChatStore } from './agent-chat-store';

const ports = vi.hoisted(() => ({
  create: vi.fn(async (_input: CreateAgentConversationInput) => undefined),
  update: vi.fn(async () => undefined),
  listByProject: vi.fn(async () => []),
  fork: vi.fn(async (id: string) => id),
  memories: vi.fn(async () => []),
  working: vi.fn(async () => null),
  start: vi.fn<GeneralAgentTransport['start']>(async () => ({ ok: true, value: undefined })),
  abort: vi.fn(async () => ({ ok: true as const, value: undefined })),
}));
vi.mock('../sqlite-repo/agent-conversation-repo', () => ({ createAgentConversationRepository: () => ports }));
vi.mock('../sync/agent-chat/repository', () => ({ AgentConversationSyncRepository: class { forkForContinuation = ports.fork; } }));
vi.mock('../usecase/useAgentMemory', () => ({ loadActiveMemoryHints: ports.memories }));
vi.mock('../usecase/useAgentWorkingMemory', () => ({ prepareAgentWorkingMemoryForTurn: ports.working }));

const initial = useAgentChatStore.getState();
const projectId = 'synthetic-todo-project';
const foregroundId = 'synthetic-foreground-chat';
function foregroundRun() {
  return {
    projectId,
    transcript: AgentChatTranscript.from([]),
    runtimeSessionId: null,
    journalScope: createAgentChatJournalScope(),
    controlStatus: null,
    pendingControl: null,
    lastTerminal: null,
    longTaskPlanState: null,
    contextUsage: null,
    automaticContinuation: createInactiveAgentAutomaticContinuation(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let restoreTransport: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  ports.memories.mockReset().mockResolvedValue([]);
  ports.working.mockReset().mockResolvedValue(null);
  ports.start.mockReset().mockResolvedValue({ ok: true, value: undefined });
  restoreTransport = installGeneralAgentTransport({
    ...unsupportedGeneralAgentTransport,
    start: ports.start,
    abort: ports.abort,
    listPendingControls: async () => ({ ok: true, value: [] }),
    subscribeJournal: () => ({ ok: true, value: () => undefined }),
  });
  useAgentChatStore.setState({
    ...initial,
    boundProjectId: projectId,
    activeConvId: foregroundId,
    runs: { [foregroundId]: foregroundRun() },
    prompt: 'Unsent author draft',
    refreshList: () => undefined,
  }, true);
});

afterEach(() => {
  restoreTransport();
  useAgentChatStore.setState(initial, true);
});

describe('Todo background Agent conversation', () => {
  it('starts a distinct durable chat without replacing the displayed chat or draft', async () => {
    const onStarted = vi.fn();
    await useAgentChatStore.getState().send({
      runtimePrompt: 'Handle the synthetic TODO',
      background: { title: 'Synthetic TODO task' },
      onStarted,
    });
    const state = useAgentChatStore.getState();
    const created = ports.create.mock.calls[0]![0];
    expect(created).toMatchObject({ projectId, title: 'Synthetic TODO task' });
    expect(ports.start).toHaveBeenCalledWith(expect.objectContaining({
      route: { kind: 'chat', projectId, conversationId: created.id },
      prompt: 'Handle the synthetic TODO',
      toolAccess: 'read_write',
    }));
    expect(onStarted).toHaveBeenCalledExactlyOnceWith(created.id);
    expect(state.activeConvId).toBe(foregroundId);
    expect(state.prompt).toBe('Unsent author draft');
    expect(state.runs[created.id].backgroundTask).toBe(true);
    expect(state.runs[created.id].transcript.toArray()[0]).toMatchObject({
      kind: 'user', text: 'Handle the synthetic TODO',
    });
  });

  it('survives same-project navigation while preparing', async () => {
    const pending = deferred<never[]>();
    ports.memories.mockImplementationOnce(() => pending.promise);
    const onStarted = vi.fn();
    const sending = useAgentChatStore.getState().send({
      runtimePrompt: 'Handle the synthetic TODO', background: {}, onStarted,
    });
    try {
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(1));
      useAgentChatStore.getState().newConversation();
      expect(useAgentChatStore.getState().activeConvId).toBeNull();
      expect(useAgentChatStore.getState().starting).toBe(true);
    } finally { pending.resolve([]); await sending; }
    expect(ports.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('cancels an unsubmitted task on project switch', async () => {
    const pending = deferred<never[]>();
    ports.memories.mockImplementationOnce(() => pending.promise);
    const onStarted = vi.fn();
    const sending = useAgentChatStore.getState().send({
      runtimePrompt: 'Handle the synthetic TODO', background: {}, onStarted,
    });
    try {
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(1));
      useAgentChatStore.getState().bindProject('synthetic-other-project', { restoreLastConversation: false });
    } finally { pending.resolve([]); await sending; }
    expect(ports.start).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('does not claim an Agent task started when transport rejects it', async () => {
    ports.start.mockResolvedValueOnce({ ok: false, code: 'SYNTHETIC', error: 'Synthetic auth failure' });
    const onStarted = vi.fn();
    await useAgentChatStore.getState().send({
      runtimePrompt: 'Handle the synthetic TODO', background: {}, onStarted,
    });
    expect(onStarted).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().activeConvId).toBe(foregroundId);
    expect(useAgentChatStore.getState().prompt).toBe('Unsent author draft');
  });
});
