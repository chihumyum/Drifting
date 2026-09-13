import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { useAgentChatStore } from './agent-chat-store';
import { useAgentEditStore } from './agent-edit-store';
import { useSettingsStore } from './settings-store';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport, type GeneralAgentResult, type GeneralAgentTransport } from '../lib/agent/transport';

const ports = vi.hoisted(() => ({
  create: vi.fn(async () => undefined), update: vi.fn(async () => undefined),
  listByProject: vi.fn(async () => []), softDelete: vi.fn(async (id: string) => [{ id, projectId: 'synthetic-preparation-project', deletedAt: '2026-09-13' }]), softDeleteAllByProject: vi.fn(async (projectId: string) => [{ id: 'synthetic-preparation-conversation', projectId, deletedAt: '2026-09-13' }]),
  fork: vi.fn(async (id: string) => id),
  memories: vi.fn(async (): Promise<Array<{ kind: string; body: string }>> => []),
  working: vi.fn(async (): Promise<{ contentMd: string; revision: number; approxTokens: number } | null> => null),
  start: vi.fn<GeneralAgentTransport['start']>(async () => ({ ok: false, code: 'SYNTHETIC', error: 'Synthetic startup stopped' })),
  abort: vi.fn(async () => ({ ok: false as const, code: 'SYNTHETIC', error: 'Synthetic abort' })),
  stopAfterTool: vi.fn(async () => ({ ok: true as const, value: undefined })),
}));
vi.mock('../sqlite-repo/agent-conversation-repo', () => ({ createAgentConversationRepository: () => ports }));
vi.mock('../sync/agent-chat/repository', () => ({ AgentConversationSyncRepository: class { forkForContinuation = ports.fork; } }));
vi.mock('../usecase/useAgentMemory', () => ({ loadActiveMemoryHints: ports.memories }));
vi.mock('../usecase/useAgentWorkingMemory', () => ({ prepareAgentWorkingMemoryForTurn: ports.working }));

const initial = useAgentChatStore.getState(); const initialEdits = useAgentEditStore.getState();
const initialSettings = useSettingsStore.getState();
const projectId = 'synthetic-preparation-project'; const conversationId = 'synthetic-preparation-conversation';
const sessionId = 'synthetic-preparation-session';
const revert = { projectId, sessionId, entityType: 'node' as const, id: 'synthetic-node', blockId: 'synthetic-block', op: 'changed' as const, restoredText: 'Synthetic restored prose' };
function run() {
  return { projectId, transcript: AgentChatTranscript.from([]), runtimeSessionId: sessionId,
    journalScope: createAgentChatJournalScope(), controlStatus: null, pendingControl: null, lastTerminal: null,
    longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let restoreTransport: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  ports.memories.mockReset().mockResolvedValue([]); ports.working.mockReset().mockResolvedValue(null);
  ports.start.mockReset().mockResolvedValue({ ok: false, code: 'SYNTHETIC', error: 'Synthetic startup stopped' });
  restoreTransport = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    start: ports.start, abort: ports.abort, stopAfterTool: ports.stopAfterTool,
    listPendingControls: async () => ({ ok: true, value: [] }),
    subscribeJournal: () => ({ ok: true, value: () => undefined }),
  });
  useAgentChatStore.setState({ ...initial, boundProjectId: projectId, activeConvId: conversationId,
    runs: { [conversationId]: run(), target: run() }, prompt: 'Synthetic author prompt', refreshList: () => undefined }, true);
  useAgentEditStore.setState({ pendingReverts: [revert] });
});
afterEach(() => {
  restoreTransport(); useAgentChatStore.setState(initial, true);
  useAgentEditStore.setState(initialEdits, true); useSettingsStore.setState(initialSettings, true);
});

describe('chat send preparation ownership', () => {
  for (const stage of ['memories', 'working'] as const) {
    for (const action of ['new', 'load', 'project', 'delete', 'abort'] as const) {
      it(`does not consume review context or start after ${action} during ${stage}`, async () => {
        const pending = deferred<never[]>();
        if (stage === 'memories') ports.memories.mockImplementationOnce(() => pending.promise);
        else ports.working.mockImplementationOnce(async () => { await pending.promise; return null; });
        const sending = useAgentChatStore.getState().send();
        try {
          await vi.waitFor(() => expect(ports[stage]).toHaveBeenCalledTimes(1));
          const state = useAgentChatStore.getState();
          if (action === 'new') state.newConversation();
          if (action === 'load') await state.loadConversation('target');
          if (action === 'project') state.bindProject('synthetic-other-project');
          if (action === 'delete') await state.deleteConversation(conversationId);
          if (action === 'abort') state.abort();
        } finally { pending.resolve([]); await sending; }
        expect(ports.start).not.toHaveBeenCalled();
        expect(useAgentEditStore.getState().pendingReverts).toEqual([revert]);
        expect(useAgentChatStore.getState().runningTurns).toEqual({});
        expect(useAgentChatStore.getState().starting).toBe(false);
        if (stage === 'memories') expect(ports.working).not.toHaveBeenCalled();
      });
    }
  }

  it('releases invalidated preparation immediately and prevents its finally from releasing a newer send', async () => {
    const first = deferred<never[]>(); const second = deferred<never[]>();
    ports.memories.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const firstSend = useAgentChatStore.getState().send(); let secondSend: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(1));
      useAgentChatStore.getState().newConversation();
      expect(useAgentChatStore.getState().starting).toBe(false);
      useAgentChatStore.getState().setPrompt('Synthetic newer intent');
      secondSend = useAgentChatStore.getState().send();
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(2));
      first.resolve([]); await firstSend;
      expect(useAgentChatStore.getState().starting).toBe(true);
      expect(ports.start).not.toHaveBeenCalled();
      await useAgentChatStore.getState().send();
      expect(ports.memories).toHaveBeenCalledTimes(2);
    } finally { first.resolve([]); second.resolve([]); await Promise.all([firstSend, secondSend]); }
    expect(ports.start).toHaveBeenCalledTimes(1);
    expect(ports.start.mock.calls[0][0].prompt).toBe('Synthetic newer intent');
    expect(useAgentEditStore.getState().pendingReverts).toEqual([revert]);
    expect(useAgentChatStore.getState().starting).toBe(false);
  });

  it('keeps accepted context in the runtime prompt and the author text in the displayed transcript', async () => {
    ports.memories.mockResolvedValueOnce([{ kind: 'preference', body: 'Synthetic approved hint' }]);
    ports.working.mockResolvedValueOnce({ contentMd: 'Synthetic working context', revision: 7, approxTokens: 8 });
    await useAgentChatStore.getState().send();
    expect(ports.start).toHaveBeenCalledTimes(1);
    const input = ports.start.mock.calls[0][0];
    expect(input).toMatchObject({ projectId, route: { kind: 'chat', projectId, conversationId }, resume: sessionId,
      memories: [{ kind: 'preference', body: 'Synthetic approved hint' }], workingMemory: { contentMd: 'Synthetic working context', revision: 7, approxTokens: 8 } });
    expect(input.prompt).toContain('用户拒绝并还原了以下改动');
    expect(input.prompt.endsWith('Synthetic author prompt')).toBe(true);
    expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray()[0]).toMatchObject({ kind: 'user', text: 'Synthetic author prompt' });
    expect(useAgentEditStore.getState().pendingReverts).toEqual([]);
  });

  for (const action of ['new', 'load', 'stopAfterTool'] as const) {
    it(`preserves an already-submitted turn after ${action} while its start acknowledgement is pending`, async () => {
      const result = deferred<GeneralAgentResult>(); ports.start.mockImplementationOnce(() => result.promise);
      const sending = useAgentChatStore.getState().send(); let turnId: string | undefined;
      try {
        await vi.waitFor(() => expect(ports.start).toHaveBeenCalledTimes(1));
        turnId = useAgentChatStore.getState().runningTurns[conversationId]; expect(turnId).toBeTruthy();
        if (action === 'new') useAgentChatStore.getState().newConversation();
        if (action === 'load') await useAgentChatStore.getState().loadConversation('target');
        if (action === 'stopAfterTool') await useAgentChatStore.getState().stopAfterTool();
      } finally { result.resolve({ ok: true, value: undefined }); await sending; }
      expect(useAgentChatStore.getState().runningTurns[conversationId]).toBe(turnId);
      expect(ports.abort).not.toHaveBeenCalled();
      expect(useAgentChatStore.getState().starting).toBe(false);
      if (action === 'stopAfterTool') expect(ports.stopAfterTool).toHaveBeenCalledWith({ turnId });
    });
  }

  for (const action of ['abort', 'project', 'delete', 'clear'] as const) {
    it(`reissues cancellation after a late successful start acknowledgement following ${action}`, async () => {
      const result = deferred<GeneralAgentResult>(); ports.start.mockImplementationOnce(() => result.promise);
      const sending = useAgentChatStore.getState().send(); let turnId: string | undefined;
      try {
        await vi.waitFor(() => expect(ports.start).toHaveBeenCalledTimes(1));
        turnId = useAgentChatStore.getState().runningTurns[conversationId];
        if (action === 'abort') useAgentChatStore.getState().abort();
        if (action === 'project') useAgentChatStore.getState().bindProject('synthetic-other-project');
        if (action === 'delete') await useAgentChatStore.getState().deleteConversation(conversationId);
        if (action === 'clear') await useAgentChatStore.getState().clearConversations();
        expect(ports.abort).toHaveBeenCalledTimes(1);
      } finally { result.resolve({ ok: true, value: undefined }); await sending; }
      expect(ports.abort).toHaveBeenCalledTimes(2);
      expect(ports.abort).toHaveBeenLastCalledWith({ turnId });
      expect(useAgentChatStore.getState().starting).toBe(false);
    });
  }

  it('keeps a late startup failure on its owning conversation without unlocking a newer preparation', async () => {
    const result = deferred<GeneralAgentResult>(); const memory = deferred<never[]>();
    ports.start.mockImplementationOnce(() => result.promise);
    const firstSend = useAgentChatStore.getState().send(); let secondSend: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(ports.start).toHaveBeenCalledTimes(1));
      useAgentChatStore.getState().newConversation();
      ports.memories.mockImplementationOnce(() => memory.promise);
      useAgentChatStore.getState().setPrompt('Synthetic next author');
      secondSend = useAgentChatStore.getState().send();
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(2));
      const active = useAgentChatStore.getState().activeConvId;
      result.resolve({ ok: false, code: 'SYNTHETIC', error: 'Synthetic late failure' }); await firstSend;
      expect(useAgentChatStore.getState().starting).toBe(true);
      expect(useAgentChatStore.getState().activeConvId).toBe(active);
      expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray().slice(-1)[0]).toEqual({ kind: 'error', text: 'Synthetic late failure' });
      expect(useAgentChatStore.getState().runs[active!].transcript.toArray()).toHaveLength(1);
    } finally { result.resolve({ ok: false, code: 'SYNTHETIC', error: 'Synthetic late failure' }); memory.resolve([]); await Promise.all([firstSend, secondSend]); }
  });

  it('cleans up a synchronous transport startup exception', async () => {
    ports.start.mockImplementationOnce(() => { throw new Error('Synthetic synchronous failure'); });
    await useAgentChatStore.getState().send();
    expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray().slice(-1)[0]).toEqual({ kind: 'error', text: 'Synthetic synchronous failure' });
    expect(useAgentChatStore.getState().starting).toBe(false);
    expect(useAgentChatStore.getState().runningTurns).toEqual({});
  });

  it('discards a late conversation-fork error after preparation has been invalidated', async () => {
    const error = deferred<Error>(); ports.fork.mockImplementationOnce(async () => { throw await error.promise; });
    const sending = useAgentChatStore.getState().send();
    try {
      await vi.waitFor(() => expect(ports.fork).toHaveBeenCalledTimes(1));
      useAgentChatStore.getState().newConversation();
    } finally { error.resolve(new Error('Synthetic stale fork failure')); await sending; }
    expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray()).toEqual([]);
    expect(useAgentChatStore.getState().starting).toBe(false);
    expect(ports.start).not.toHaveBeenCalled();
    expect(useAgentEditStore.getState().pendingReverts).toEqual([revert]);
  });
});
