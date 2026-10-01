import { createAgentChatDisplayProjection } from '../features/agent/chat-display-projection';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeEvent, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import { revealDesktopAgentView } from './desktop-agent-navigation';
import { useUiStore } from './ui-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { useAgentChatStore } from './agent-chat-store';
import { createAgentChatViewSource } from './agent-chat-view-source';
import type { AgentConversation } from '../domain/agent-conversation';
import { useAgentEditStore } from './agent-edit-store';
import { useSettingsStore } from './settings-store';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { armAgentAutomaticContinuation, createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport, type GeneralAgentTransport } from '../lib/agent/transport';

const ports = vi.hoisted(() => ({
  get: vi.fn(), projection: vi.fn(),
  create: vi.fn(async () => undefined), update: vi.fn(async () => undefined),
  listByProject: vi.fn(async () => []), softDelete: vi.fn(async (id: string) => [{ id, projectId: 'synthetic-preparation-project', deletedAt: '2026-09-13' }]), softDeleteAllByProject: vi.fn(async (projectId: string) => [{ id: 'synthetic-preparation-conversation', projectId, deletedAt: '2026-09-13' }]),
  fork: vi.fn(async (id: string) => id),
  memories: vi.fn(async (): Promise<Array<{ kind: string; body: string }>> => []),
  working: vi.fn(async (): Promise<{ contentMd: string; revision: number; approxTokens: number } | null> => null),
  start: vi.fn<GeneralAgentTransport['start']>(async () => ({ ok: false, code: 'SYNTHETIC', error: 'Synthetic startup stopped' })),
  abort: vi.fn(async () => ({ ok: false as const, code: 'SYNTHETIC', error: 'Synthetic abort' })),
  resolvePermission: vi.fn<GeneralAgentTransport['resolvePermission']>(async () => ({ ok: true, value: undefined })),
  steer: vi.fn<GeneralAgentTransport['steer']>(async () => ({ ok: true, value: undefined })),
  stopAfterTool: vi.fn(async () => ({ ok: true as const, value: undefined })),
}));
vi.mock('../sqlite-repo/agent-conversation-repo', () => ({ createAgentConversationRepository: () => ports }));
vi.mock('../sync/agent-chat/repository', () => ({ AgentConversationSyncRepository: class { forkForContinuation = ports.fork; } }));
vi.mock('../usecase/useAgentMemory', () => ({ loadActiveMemoryHints: ports.memories }));
vi.mock('../usecase/useAgentWorkingMemory', () => ({ prepareAgentWorkingMemoryForTurn: ports.working }));

vi.mock('../lib/agent/runtime/recovered-transcript', () => ({ loadCanonicalAgentChatProjection: ports.projection, findCanonicalAgentChatSessionId: async () => null }));
vi.mock('../sqlite-repo/agent-runtime-long-task-repo', () => ({ createAgentRuntimeLongTaskRepository: () => ({ getLatestPlan: async () => null }) }));
const otherProject = 'synthetic-other-project';
const conversation = (id: string): AgentConversation => ({ id, projectId, title: id, mode: 'byok', sdkSessionId: null, runtimeSessionId: null, messages: [], createdAt: '2026-10-01', updatedAt: '2026-10-01' });
const initial = useAgentChatStore.getState(); const initialEdits = useAgentEditStore.getState();
const initialUi = useUiStore.getState();
const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
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
  vi.clearAllMocks(); ports.get.mockReset().mockResolvedValue(null); ports.projection.mockReset().mockResolvedValue(null);
  ports.memories.mockReset().mockResolvedValue([]); ports.working.mockReset().mockResolvedValue(null);
  ports.start.mockReset().mockResolvedValue({ ok: false, code: 'SYNTHETIC', error: 'Synthetic startup stopped' });
  restoreTransport = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    start: ports.start, abort: ports.abort, stopAfterTool: ports.stopAfterTool, resolvePermission: ports.resolvePermission, steer: ports.steer,
    listPendingControls: async () => ({ ok: true, value: [] }),
    subscribeJournal: listener => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; },
  });
  useAgentChatStore.setState({ ...initial, boundProjectId: projectId, activeConvId: conversationId,
    runs: { [conversationId]: run(), target: { ...run(), runtimeSessionId: 'synthetic-second-session' } }, prompt: 'Synthetic author prompt', refreshList: () => undefined }, true);
  useAgentEditStore.setState({ pendingReverts: [revert] });
});
afterEach(() => {
  vi.useRealTimers(); useUiStore.setState(initialUi, true);
  restoreTransport(); useAgentChatStore.setState(initial, true);
  useAgentEditStore.setState(initialEdits, true); useSettingsStore.setState(initialSettings, true);
});

async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function emit(event: AgentRuntimeEvent, id = conversationId, turnId = 'synthetic-first-turn') {
  const entry: AgentRuntimeJournalEntry = { schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION, sessionId: id === conversationId ? sessionId : 'synthetic-second-session',
    turnId, route: { kind: 'chat', projectId, conversationId: id }, seq: 1, eventId: `${id}:${event.type}`, wallTimeMs: Date.now(), event };
  for (const listener of listeners) listener(entry);
}

describe('independent Agent pane acceptance', () => {
  it('lets another pane prepare and send while its sibling is awaiting memories', async () => {
    const first = createAgentChatViewSource('default');
    const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation('target');
    second.getState().setPrompt('Synthetic second prompt');
    const pending = deferred<never[]>();
    ports.memories.mockImplementationOnce(() => pending.promise);
    const sending = first.getState().send();
    try {
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(1));
      expect(second.getState().starting).toBe(false);
      useAgentChatStore.getState().focusView('sidebar:secondary');
      await second.getState().send();
      expect(ports.start.mock.calls[0][0]).toMatchObject({ prompt: 'Synthetic second prompt', route: { conversationId: 'target' } });
      expect(first.getState().starting).toBe(true);
      second.getState().setPrompt('Synthetic next second draft');
      await second.getState().stopAfterTool();
      expect(ports.stopAfterTool).not.toHaveBeenCalled();
    } finally { pending.resolve([]); await sending; }
    expect(ports.start).toHaveBeenCalledTimes(2);
    expect(ports.start.mock.calls[1][0].route).toMatchObject({ conversationId });
    expect(first.getState()).toMatchObject({ activeConvId: conversationId, prompt: '', starting: false });
    expect(second.getState()).toMatchObject({ activeConvId: 'target', prompt: 'Synthetic next second draft', starting: false });
  });

  it('cancels only the pane that starts a new chat during parallel preparation', async () => {
    const first = createAgentChatViewSource('default');
    const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation('target');
    second.getState().setPrompt('Synthetic second prompt');
    const a = deferred<never[]>(); const b = deferred<never[]>();
    ports.memories.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const sendingA = first.getState().send();
    await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(1));
    const sendingB = second.getState().send();
    try {
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(2));
      first.getState().newConversation();
      expect(first.getState().starting).toBe(false);
      expect(second.getState().starting).toBe(true);
    } finally { a.resolve([]); b.resolve([]); await Promise.all([sendingA, sendingB]); }
    expect(ports.start).toHaveBeenCalledTimes(1);
    expect(ports.start.mock.calls[0][0].route).toMatchObject({ conversationId: 'target' });
  });

  it('deduplicates preparation when both panes intentionally select the same conversation', async () => {
    const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation(conversationId);
    second.getState().setPrompt('Synthetic sibling draft');
    const pending = deferred<never[]>();
    ports.memories.mockImplementationOnce(() => pending.promise);
    const sending = useAgentChatStore.getState().send();
    try {
      await vi.waitFor(() => expect(ports.memories).toHaveBeenCalledTimes(1));
      await second.getState().send();
      expect(ports.memories).toHaveBeenCalledTimes(1);
      expect(second.getState().prompt).toBe('Synthetic sibling draft');
    } finally { pending.resolve([]); await sending; }
    expect(ports.start).toHaveBeenCalledTimes(1);
  });

  it('keeps drafts and the surviving conversation when the other view deletes its history', async () => {
    const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation('target');
    second.getState().setPrompt('Synthetic sibling draft');
    await useAgentChatStore.getState().deleteConversation(conversationId);
    expect(useAgentChatStore.getState().activeConvId).toBeNull();
    expect(second.getState()).toMatchObject({ activeConvId: 'target', prompt: 'Synthetic sibling draft' });
    expect(second.getState().runs.target).toBeDefined();
  });

  it('loads different conversations concurrently without cancelling the other view', async () => {
    useAgentChatStore.setState({ boundProjectId: projectId });
    const first = createAgentChatViewSource('default');
    const second = createAgentChatViewSource('sidebar:secondary');
    const a = deferred<AgentConversation | null>(); const b = deferred<AgentConversation | null>();
    ports.get.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const loadA = first.getState().loadConversation('A'); const loadB = second.getState().loadConversation('B');
    b.resolve(conversation('B')); await loadB;
    second.getState().setPrompt('Synthetic B draft');
    useAgentChatStore.getState().focusView('sidebar:secondary');
    a.resolve(conversation('A')); await loadA;
    expect(first.getState().activeConvId).toBe('A');
    expect(second.getState()).toMatchObject({ activeConvId: 'B', prompt: 'Synthetic B draft' });
    expect(useAgentChatStore.getState().activeConvId).toBe('B');
  });

  it('binds stable pane identities without copying an existing conversation or draft', () => {
    useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: 'A', prompt: 'Synthetic A draft' });
    const chat = useAgentChatStore.getState();
    chat.bindView('sidebar:secondary'); chat.bindView('sidebar:primary');
    expect(useAgentChatStore.getState().viewBindings).toEqual({ 'sidebar:secondary': 'default', 'sidebar:primary': 'sidebar:primary' });
    const extra = createAgentChatViewSource('sidebar:primary');
    expect(extra.getState()).toMatchObject({ activeConvId: null, prompt: '' });
    extra.getState().setPrompt('Synthetic extra draft');
    chat.focusView('sidebar:primary');
    // Closing/reopening a pane or swapping its Tab reuses its stable binding.
    chat.bindView('sidebar:primary'); chat.bindView('sidebar:secondary');
    expect(createAgentChatViewSource('default').getState()).toMatchObject({ activeConvId: 'A', prompt: 'Synthetic A draft' });
    expect(extra.getState().prompt).toBe('Synthetic extra draft');
    chat.bindProject(otherProject, { restoreLastConversation: false });
    expect(extra.getState()).toMatchObject({ activeConvId: null, prompt: '', starting: false });
    expect(createAgentChatViewSource('default').getState().activeConvId).toBeNull();
  });

  it('routes stop, permission and steering to the pane conversation after focus moves elsewhere', async () => {
    const first = createAgentChatViewSource('default');
    const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation('target');
    useAgentChatStore.getState().bindProject(projectId);
    useAgentChatStore.setState({ runningTurns: { [conversationId]: 'synthetic-first-turn', target: 'synthetic-second-turn' } });
    emit({ type: 'permission_requested', request: {
      requestId: 'permission', sessionId, turnId: 'synthetic-first-turn', callId: 'write', toolName: 'write_node',
      access: 'write', arguments: {}, argumentsHash: `sha256:${'a'.repeat(64)}`, revision: null, allowedScopes: ['once'],
    } });
    useAgentChatStore.getState().focusView('sidebar:secondary');
    await first.getState().respondPermission('allow');
    await first.getState().stopAfterTool();
    expect(ports.resolvePermission).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'synthetic-first-turn', sessionId, decision: 'allow' }));
    expect(ports.stopAfterTool).toHaveBeenCalledWith({ turnId: 'synthetic-first-turn' });
    second.getState().setPrompt('Synthetic second steering');
    await second.getState().send();
    expect(ports.steer).toHaveBeenCalledWith({ turnId: 'synthetic-second-turn', text: 'Synthetic second steering' });
    expect(first.getState().prompt).toBe('Synthetic author prompt');
    expect(second.getState().prompt).toBe('');
  });

  it('publishes separate transcripts from the one app journal subscription', async () => {
    const first = createAgentChatViewSource('default'); const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation('target');
    useAgentChatStore.getState().bindProject(projectId);
    const scheduler = { requestFrame: () => 1, cancelFrame: () => undefined,
      setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimer: clearTimeout,
      isHidden: () => false, subscribeVisibility: () => () => undefined };
    const a = createAgentChatDisplayProjection(first, scheduler); const b = createAgentChatDisplayProjection(second, scheduler);
    const stopA = a.subscribe(() => undefined); const stopB = b.subscribe(() => undefined);
    try {
      expect(listeners.size).toBe(1);
      emit({ type: 'text_delta', iteration: 1, text: 'Synthetic first answer' });
      emit({ type: 'text_delta', iteration: 1, text: 'Synthetic second answer' }, 'target', 'synthetic-second-turn');
      // A control boundary flushes each independent display without waiting for a frame.
      emit({ type: 'cancellation_requested', reason: 'author' });
      emit({ type: 'cancellation_requested', reason: 'author' }, 'target', 'synthetic-second-turn');
      expect(a.getSnapshot()).toEqual([expect.objectContaining({ text: 'Synthetic first answer' })]);
      expect(b.getSnapshot()).toEqual([expect.objectContaining({ text: 'Synthetic second answer' })]);
    } finally { stopA(); stopB(); }
  });

  it('continues the first pane task while the other pane has focus and an unrelated draft', async () => {
    vi.useFakeTimers();
    const second = createAgentChatViewSource('sidebar:secondary');
    await second.getState().loadConversation('target');
    useAgentChatStore.getState().setPrompt('');
    second.getState().setPrompt('Synthetic unrelated draft');
    useAgentChatStore.getState().focusView('sidebar:secondary');
    const send = vi.fn(async () => undefined);
    useAgentChatStore.setState(state => ({ send, runs: { ...state.runs, [conversationId]: {
      ...state.runs[conversationId], automaticContinuation: armAgentAutomaticContinuation(null, Date.now()),
    } } }));
    useAgentChatStore.getState().bindProject(projectId);
    emit({ type: 'turn_finished', outcome: 'budget_exceeded', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, modelIterations: 1, durationMs: 100 });
    await settle(); await vi.advanceTimersByTimeAsync(600);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ origin: 'automatic_continuation', viewId: 'default' }));
    expect(second.getState().prompt).toBe('Synthetic unrelated draft');
  });

  it('opens an external task in the visible Agent pane while preserving the other pane', async () => {
    const ui = useUiStore.getState();
    ui.setSidebarSplitAvailable('right', true);
    ui.toggleRightSidebarTab('primary', 'companion');
    ui.toggleRightSidebarTab('secondary', 'companion');
    const chat = useAgentChatStore.getState();
    chat.bindView('sidebar:primary'); chat.bindView('sidebar:secondary');
    chat.focusView('default');
    // Navigation follows sidebar focus, not the last chat composer that happened to be focused.
    const viewId = revealDesktopAgentView();
    await chat.loadConversation('target', viewId);
    expect(viewId).toBe('sidebar:secondary');
    expect(createAgentChatViewSource('default').getState()).toMatchObject({ activeConvId: conversationId, prompt: 'Synthetic author prompt' });
    expect(createAgentChatViewSource(viewId).getState().activeConvId).toBe('target');
  });
});
