import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConversation, AgentConversationSummary } from '../domain/agent-conversation';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport, type GeneralAgentTransport } from '../lib/agent/transport';
import { useAgentChatStore } from './agent-chat-store';
import { useSettingsStore } from './settings-store';

const ports = vi.hoisted(() => ({
  listByProject: vi.fn(async (): Promise<AgentConversationSummary[]> => []),
  get: vi.fn(async (): Promise<AgentConversation | null> => null),
  update: vi.fn(async () => undefined),
  canonicalSession: vi.fn(async (): Promise<string | null> => null),
  projection: vi.fn(async (): Promise<unknown> => null),
  controls: vi.fn<GeneralAgentTransport['listPendingControls']>(async () => ({ ok: true, value: [] })),
  plan: vi.fn(async (): Promise<unknown> => null), manifest: vi.fn(async () => null),
}));
vi.mock('../sqlite-repo/agent-conversation-repo', () => ({ createAgentConversationRepository: () => ports }));
vi.mock('../sqlite-repo/agent-runtime-long-task-repo', () => ({ createAgentRuntimeLongTaskRepository: () => ({ getLatestPlan: ports.plan, getChapterManifestState: ports.manifest }) }));
vi.mock('../lib/agent/runtime/recovered-transcript', () => ({ findCanonicalAgentChatSessionId: ports.canonicalSession, loadCanonicalAgentChatProjection: ports.projection }));
const initial = useAgentChatStore.getState(); const settings = useSettingsStore.getState();
const projectId = 'synthetic-navigation-project'; const otherProject = 'synthetic-navigation-other';
const row = (id: string): AgentConversationSummary => ({ id, title: id, mode: 'byok', updatedAt: '2026-09-13T00:00:00.000Z' });
const conversation = (id: string): AgentConversation => ({ ...row(id), projectId, sdkSessionId: null, runtimeSessionId: null, messages: [{ kind: 'assistant', text: 'Synthetic cache' }], createdAt: '2026-09-13T00:00:00.000Z' });
const run = () => ({ projectId, transcript: AgentChatTranscript.from([]), runtimeSessionId: null,
  journalScope: createAgentChatJournalScope(), controlStatus: null, pendingControl: null, lastTerminal: null,
  longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
let restoreTransport: () => void;
beforeEach(() => {
  vi.resetAllMocks(); ports.listByProject.mockResolvedValue([]); ports.get.mockResolvedValue(null);
  ports.canonicalSession.mockResolvedValue(null); ports.projection.mockResolvedValue(null); ports.plan.mockResolvedValue(null); ports.controls.mockResolvedValue({ ok: true, value: [] });
  useAgentChatStore.setState(initial, true); useSettingsStore.setState({ lastAgentConvByProject: {} });
  restoreTransport = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    listPendingControls: ports.controls, subscribeJournal: () => ({ ok: true, value: () => undefined }),
  });
});
afterEach(async () => { await settle(); restoreTransport(); useAgentChatStore.setState(initial, true); useSettingsStore.setState(settings, true); });

describe('conversation navigation and history ownership', () => {
  for (const outcome of ['success', 'failure'] as const) it(`ignores an older same-project list ${outcome}`, async () => {
    useAgentChatStore.setState({ boundProjectId: projectId });
    const old = deferred<AgentConversationSummary[]>(); ports.listByProject.mockImplementationOnce(() => old.promise).mockResolvedValueOnce([row('new')]);
    useAgentChatStore.getState().refreshList(); useAgentChatStore.getState().refreshList(); await settle();
    expect(useAgentChatStore.getState().convList).toEqual([row('new')]);
    if (outcome === 'success') old.resolve([row('old')]); else old.reject(new Error('Synthetic stale read'));
    await settle(); expect(useAgentChatStore.getState().convList).toEqual([row('new')]);
  });

  it('clears the previous project list synchronously while the next list loads', async () => {
    useAgentChatStore.setState({ boundProjectId: otherProject, convList: [row('foreign')] });
    const pending = deferred<AgentConversationSummary[]>(); ports.listByProject.mockImplementationOnce(() => pending.promise);
    useAgentChatStore.getState().bindProject(projectId, { restoreLastConversation: false });
    try { expect(useAgentChatStore.getState().convList).toEqual([]); } finally { pending.resolve([]); await settle(); }
  });

  it('rejects the first binding after navigating A to B to A', async () => {
    const old = deferred<AgentConversationSummary[]>(); ports.listByProject.mockImplementationOnce(() => old.promise).mockResolvedValueOnce([row('B')]).mockResolvedValueOnce([row('fresh-A')]);
    const state = useAgentChatStore.getState(); state.bindProject(projectId); state.bindProject(otherProject); state.bindProject(projectId);
    await settle(); old.resolve([row('stale-A')]); await settle(); expect(useAgentChatStore.getState().convList).toEqual([row('fresh-A')]);
  });

  it('restores the saved existing conversation only once from the latest list', async () => {
    useSettingsStore.getState().setLastAgentConv(projectId, 'saved'); useAgentChatStore.setState({ runs: { saved: run() } });
    const old = deferred<AgentConversationSummary[]>(); ports.listByProject.mockImplementationOnce(() => old.promise).mockResolvedValueOnce([row('saved')]);
    const state = useAgentChatStore.getState(); state.bindProject(projectId); state.refreshList(); await settle();
    expect(useAgentChatStore.getState().activeConvId).toBe('saved');
    old.resolve([]); await settle(); expect(useAgentChatStore.getState().convList).toEqual([row('saved')]);
  });

  it('does not let automatic restore invalidate an explicit pending conversation load', async () => {
    useSettingsStore.getState().setLastAgentConv(projectId, 'saved'); useAgentChatStore.setState({ runs: { saved: run() } });
    const list = deferred<AgentConversationSummary[]>(); const target = deferred<AgentConversation | null>();
    ports.listByProject.mockImplementationOnce(() => list.promise); ports.get.mockImplementationOnce(() => target.promise);
    useAgentChatStore.getState().bindProject(projectId); const loading = useAgentChatStore.getState().loadConversation('target');
    list.resolve([row('saved'), row('target')]); await settle();
    target.resolve(conversation('target')); await loading;
    expect(useAgentChatStore.getState().activeConvId).toBe('target'); expect(ports.get).toHaveBeenCalledTimes(1);
  });

  it('does not restore an old conversation after the author starts drafting a new prompt', async () => {
    useSettingsStore.getState().setLastAgentConv(projectId, 'saved'); useAgentChatStore.setState({ runs: { saved: run() } });
    const list = deferred<AgentConversationSummary[]>(); ports.listByProject.mockImplementationOnce(() => list.promise);
    useAgentChatStore.getState().bindProject(projectId); useAgentChatStore.getState().setPrompt('Synthetic new intent');
    list.resolve([row('saved')]); await settle();
    expect(useAgentChatStore.getState()).toMatchObject({ activeConvId: null, prompt: 'Synthetic new intent' });
  });

  it('preserves restore opt-out across a same-project remount', async () => {
    useSettingsStore.getState().setLastAgentConv(projectId, 'saved'); useAgentChatStore.setState({ runs: { saved: run() } });
    ports.listByProject.mockResolvedValue([row('saved')]);
    useAgentChatStore.getState().bindProject(projectId, { restoreLastConversation: false }); useAgentChatStore.getState().bindProject(projectId);
    await settle(); expect(useAgentChatStore.getState().activeConvId).toBeNull();
  });

  it('keeps a newer project isolated from a late successful list', async () => {
    const old = deferred<AgentConversationSummary[]>(); ports.listByProject.mockImplementationOnce(() => old.promise).mockResolvedValueOnce([row('new-project')]);
    useAgentChatStore.getState().bindProject(projectId); useAgentChatStore.getState().bindProject(otherProject); await settle();
    old.resolve([row('old-project')]); await settle(); expect(useAgentChatStore.getState().convList).toEqual([row('new-project')]);
  });

  it('retains the existing empty-list fallback for the latest failed read', async () => {
    useAgentChatStore.setState({ boundProjectId: projectId, convList: [row('old')] }); ports.listByProject.mockRejectedValueOnce(new Error('Synthetic current failure'));
    useAgentChatStore.getState().refreshList(); await settle(); expect(useAgentChatStore.getState().convList).toEqual([]);
  });

  it('stops a superseded hydration after canonical route lookup', async () => {
    useAgentChatStore.setState({ boundProjectId: projectId }); ports.get.mockResolvedValueOnce(conversation('target'));
    const pending = deferred<string | null>(); ports.canonicalSession.mockImplementationOnce(() => pending.promise);
    const loading = useAgentChatStore.getState().loadConversation('target'); await settle(); useAgentChatStore.getState().newConversation();
    pending.resolve('synthetic-session'); await loading;
    expect(ports.projection).not.toHaveBeenCalled(); expect(ports.update).not.toHaveBeenCalled(); expect(useAgentChatStore.getState().runs.target).toBeUndefined();
  });

  it('restores canonical messages and keeps the display cache on projection failure', async () => {
    useAgentChatStore.setState({ boundProjectId: projectId });
    ports.get.mockResolvedValueOnce({ ...conversation('canonical'), runtimeSessionId: 'synthetic-session' });
    ports.projection.mockResolvedValueOnce({ messages: [{ kind: 'assistant', text: 'Canonical synthetic' }], eventIds: ['event'], lastTerminal: null, latestContextUsage: null });
    await useAgentChatStore.getState().loadConversation('canonical');
    expect(useAgentChatStore.getState().runs.canonical.transcript.toArray()).toEqual([{ kind: 'assistant', text: 'Canonical synthetic' }]);
    ports.get.mockResolvedValueOnce({ ...conversation('fallback'), runtimeSessionId: 'synthetic-failure' }); ports.projection.mockRejectedValueOnce(new Error('Synthetic recovery failure'));
    await useAgentChatStore.getState().loadConversation('fallback');
    expect(useAgentChatStore.getState().runs.fallback.transcript.toArray()).toEqual(conversation('fallback').messages);
  });
  it('abandons automatic hydration if a new draft starts before the transcript is visible', async () => {
    useSettingsStore.getState().setLastAgentConv(projectId, 'saved'); ports.listByProject.mockResolvedValueOnce([row('saved')]);
    const pending = deferred<AgentConversation | null>(); ports.get.mockImplementationOnce(() => pending.promise);
    useAgentChatStore.getState().bindProject(projectId); await settle();
    useAgentChatStore.getState().setPrompt('Synthetic new draft'); pending.resolve(conversation('saved')); await settle();
    expect(useAgentChatStore.getState()).toMatchObject({ activeConvId: null, prompt: 'Synthetic new draft' });
    expect(useAgentChatStore.getState().runs.saved).toBeUndefined(); expect(ports.canonicalSession).not.toHaveBeenCalled();
  });

  it('keeps recovering pending controls when the author types after the restored transcript is visible', async () => {
    useSettingsStore.getState().setLastAgentConv(projectId, 'saved'); ports.listByProject.mockResolvedValueOnce([row('saved')]);
    ports.get.mockResolvedValueOnce({ ...conversation('saved'), runtimeSessionId: 'synthetic-session' });
    const pending = deferred<Awaited<ReturnType<GeneralAgentTransport['listPendingControls']>>>(); ports.controls.mockImplementationOnce(() => pending.promise);
    useAgentChatStore.getState().bindProject(projectId); await settle(); expect(useAgentChatStore.getState().activeConvId).toBe('saved');
    useAgentChatStore.getState().setPrompt('Synthetic reply to visible chat');
    const control = { sessionId: 'synthetic-session', turnId: 'synthetic-turn', status: 'waiting_user' as const, requiresContinuation: true };
    pending.resolve({ ok: true, value: [control] }); await settle();
    expect(useAgentChatStore.getState().runs.saved.pendingControl).toEqual(control);
    expect(useSettingsStore.getState().lastAgentConvByProject[projectId]).toBe('saved');
  });

  it('does not load a manifest after navigation supersedes the pending plan read', async () => {
    useAgentChatStore.setState({ boundProjectId: projectId }); ports.get.mockResolvedValueOnce({ ...conversation('target'), runtimeSessionId: 'synthetic-session' });
    const pending = deferred<unknown>(); ports.plan.mockImplementationOnce(() => pending.promise);
    const loading = useAgentChatStore.getState().loadConversation('target'); await settle();
    useAgentChatStore.getState().newConversation(); pending.resolve({ task: { id: 'synthetic-task' } }); await loading;
    expect(ports.manifest).not.toHaveBeenCalled(); expect(useAgentChatStore.getState().runs.target).toBeUndefined();
  });

});
