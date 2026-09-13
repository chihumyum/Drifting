import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport, type GeneralAgentTransport } from '../lib/agent/transport';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from '../services/workspace-projection.test-support';
import { useAgentChatStore } from './agent-chat-store';
import { useSettingsStore } from './settings-store';

vi.mock('../usecase/useAgentMemory', () => ({ loadActiveMemoryHints: async () => [] }));
vi.mock('../usecase/useAgentWorkingMemory', () => ({ prepareAgentWorkingMemoryForTurn: async () => null }));
const initial = useAgentChatStore.getState(); const settings = useSettingsStore.getState();
const repo = createAgentConversationRepository();
let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>>; let restoreTransport: () => void;
const start = vi.fn<GeneralAgentTransport['start']>(async () => ({ ok: false, code: 'SYNTHETIC', error: 'Synthetic provider stopped' }));
const abort = vi.fn(async () => ({ ok: true as const, value: undefined }));
const run = (projectId = INPUT.projectId) => ({ projectId, transcript: AgentChatTranscript.from([{ kind: 'assistant', text: 'Synthetic retained transcript' }]), runtimeSessionId: null,
  journalScope: createAgentChatJournalScope(), controlStatus: null, pendingControl: null, lastTerminal: null,
  longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() });
const create = (id: string, projectId = INPUT.projectId) => repo.create({ id, projectId, title: id, mode: 'byok', messages: [{ kind: 'assistant', text: 'Synthetic retained transcript' }], createdAt: NOW, updatedAt: NOW });
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

// Intercept both gateway paths so the identical probe also executes on the old
// UPDATE-without-RETURNING baseline. The actual SQLite statement still runs.
function pauseRemoval(afterWrite = true) {
  const entered = deferred(); const release = deferred(); const { gateway } = fixture;
  const query = gateway.query.bind(gateway); const execute = gateway.execute.bind(gateway); let paused = false;
  const match = (sql: string) => !paused && /^update "agent_conversation" set "deleted_at"/i.test(sql);
  gateway.query = async (...args) => { if (!match(args[0])) return query(...args); paused = true; if (!afterWrite) { entered.resolve(); await release.promise; } const value = await query(...args); if (afterWrite) { entered.resolve(); await release.promise; } return value; };
  gateway.execute = async (...args) => { if (!match(args[0])) return execute(...args); paused = true; if (!afterWrite) { entered.resolve(); await release.promise; } const value = await execute(...args); if (afterWrite) { entered.resolve(); await release.promise; } return value; };
  return { entered: entered.promise, release: release.resolve };
}

beforeEach(async () => {
  fixture = await createWorkspaceProjectionFixture(); start.mockClear(); abort.mockClear();
  await create('old'); await create('sibling'); await create('foreign', 'other-project');
  restoreTransport = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport, start, abort,
    listPendingControls: async () => ({ ok: true, value: [] }), subscribeJournal: () => ({ ok: true, value: () => undefined }),
  });
  useAgentChatStore.setState({ ...initial, boundProjectId: INPUT.projectId, activeConvId: 'old', runs: { old: run(), sibling: run(), foreign: run('other-project') }, refreshList: () => undefined }, true);
  useSettingsStore.setState({ lastAgentConvByProject: { [INPUT.projectId]: 'old', 'other-project': 'foreign' } });
});
afterEach(async () => { await settle(); expect(fixture.gateway.database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]); useAgentChatStore.getState().abort(); restoreTransport(); useAgentChatStore.setState(initial, true); useSettingsStore.setState(settings, true); await fixture.close(); });

describe('committed conversation removal and concurrent navigation', () => {
  it('preserves the active conversation and saved pointer of a newly bound project', async () => {
    const gate = pauseRemoval(); const clearing = useAgentChatStore.getState().clearConversations(); await gate.entered;
    useAgentChatStore.getState().bindProject('other-project', { restoreLastConversation: false }); await useAgentChatStore.getState().loadConversation('foreign');
    gate.release(); await clearing;
    expect(useAgentChatStore.getState().activeConvId).toBe('foreign'); expect(useAgentChatStore.getState().runs.foreign).toBeDefined();
    expect(useSettingsStore.getState().lastAgentConvByProject['other-project']).toBe('foreign');
    expect(await repo.listByProject(INPUT.projectId)).toEqual([]); expect(await repo.get('foreign')).not.toBeNull();
  });

  for (const afterWrite of [false, true]) it(`queues a new send until clear completes ${afterWrite ? 'after' : 'before'} the SQLite update`, async () => {
    const gate = pauseRemoval(afterWrite); const clearing = useAgentChatStore.getState().clearConversations(); await gate.entered;
    useAgentChatStore.getState().newConversation(); useAgentChatStore.getState().setPrompt('Synthetic new prompt');
    const sending = useAgentChatStore.getState().send(); await settle();
    try { expect(start).not.toHaveBeenCalled(); expect(useAgentChatStore.getState().prompt).toBe('Synthetic new prompt'); }
    finally { gate.release(); await Promise.all([clearing, sending]); }
    expect(start).toHaveBeenCalledTimes(1);
    const id = useAgentChatStore.getState().activeConvId!; expect(id).toBeTruthy(); expect(id).not.toBe('old');
    expect((await repo.get(id))?.messages.some(message => message.kind === 'user' && message.text === 'Synthetic new prompt')).toBe(true);
    expect(useSettingsStore.getState().lastAgentConvByProject[INPUT.projectId]).toBe(id);
  });

  it('cleans only the returned IDs and retains a conversation created after the committed clear', async () => {
    const gate = pauseRemoval(); const clearing = useAgentChatStore.getState().clearConversations(); await gate.entered;
    await create('new'); useAgentChatStore.setState(state => ({ runs: { ...state.runs, new: run() }, activeConvId: 'new' }));
    useSettingsStore.getState().setLastAgentConv(INPUT.projectId, 'new'); gate.release(); await clearing;
    expect(useAgentChatStore.getState().activeConvId).toBe('new'); expect(useAgentChatStore.getState().runs.new).toBeDefined();
    expect(useSettingsStore.getState().lastAgentConvByProject[INPUT.projectId]).toBe('new');
    expect((await repo.listByProject(INPUT.projectId)).map(row => row.id)).toEqual(['new']);
  });

  for (const operation of ['delete', 'clear'] as const) it(`retains the transcript and pointer after a failed ${operation} write`, async () => {
    fixture.gateway.database.exec("CREATE TRIGGER synthetic_refuse_delete BEFORE UPDATE OF deleted_at ON agent_conversation BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END");
    const state = useAgentChatStore.getState(); const before = state.runs.old.transcript;
    await (operation === 'delete' ? state.deleteConversation('old') : state.clearConversations());
    expect(useAgentChatStore.getState().activeConvId).toBe('old'); expect(useAgentChatStore.getState().runs.old.transcript).toBe(before);
    expect(useSettingsStore.getState().lastAgentConvByProject[INPUT.projectId]).toBe('old'); expect(await repo.get('old')).not.toBeNull();
  });

  it('honors an explicit project when settings clear an unbound project', async () => {
    useAgentChatStore.setState({ boundProjectId: 'other-project', activeConvId: 'foreign' });
    await useAgentChatStore.getState().clearConversations(INPUT.projectId);
    expect(await repo.listByProject(INPUT.projectId)).toEqual([]); expect(await repo.get('foreign')).not.toBeNull();
    expect(useAgentChatStore.getState().activeConvId).toBe('foreign');
  });

  it('does not hydrate deleted rows while usage still includes their historical spend', async () => {
    await repo.update('old', { messages: [{ kind: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, turns: 1 }] });
    await useAgentChatStore.getState().deleteConversation('old');
    expect(await repo.get('old')).toBeNull();
    useAgentChatStore.setState({ activeConvId: 'old' }); useSettingsStore.getState().setLastAgentConv(INPUT.projectId, 'old');
    await useAgentChatStore.getState().loadConversation('old');
    expect(useAgentChatStore.getState().activeConvId).toBeNull(); expect(useSettingsStore.getState().lastAgentConvByProject[INPUT.projectId]).toBeUndefined();
    expect(useAgentChatStore.getState().runs.old).toBeUndefined();
    const usage = await repo.usageByProject(INPUT.projectId); expect(usage.find(row => row.id === 'old')).toMatchObject({ inputTokens: 10, outputTokens: 2, costUsd: 0.1 });
    expect(usage.find(row => row.id === 'old')?.deletedAt).toBeTruthy();
  });
  for (const target of ['old', 'sibling']) it(`invalidates only a hydration affected by deleting old while loading ${target}`, async () => {
    useAgentChatStore.setState({ activeConvId: null, runs: { foreign: run('other-project') } });
    const entered = deferred(); const release = deferred(); const query = fixture.gateway.query.bind(fixture.gateway); let held = false;
    fixture.gateway.query = async (...args) => {
      const result = await query(...args);
      if (!held && /^select /i.test(args[0]) && args[0].includes('from "agent_conversation"') && args[1]?.includes(target)) {
        held = true; entered.resolve(); await release.promise;
      }
      return result;
    };
    const loading = useAgentChatStore.getState().loadConversation(target); await entered.promise;
    try { await useAgentChatStore.getState().deleteConversation('old'); }
    finally { release.resolve(); await loading; }
    expect(useAgentChatStore.getState().activeConvId).toBe(target === 'old' ? null : 'sibling');
    expect(Boolean(useAgentChatStore.getState().runs[target])).toBe(target !== 'old');
  });

  it('finishes durable deletion and releases waiters when the cancellation transport throws', async () => {
    useAgentChatStore.setState({ runningTurns: { old: 'synthetic-turn' }, runningConvId: 'old', runningTurnId: 'synthetic-turn' });
    abort.mockImplementationOnce(() => { throw new Error('Synthetic cancellation transport unavailable'); });
    await useAgentChatStore.getState().deleteConversation('old');
    expect(await repo.get('old')).toBeNull(); expect(useAgentChatStore.getState().runningTurns).toEqual({});
    await useAgentChatStore.getState().loadConversation('sibling'); expect(useAgentChatStore.getState().activeConvId).toBe('sibling');
  });

});
