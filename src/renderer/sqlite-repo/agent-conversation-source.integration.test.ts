import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAgentConversationRepository } from './agent-conversation-repo';
import { createAgentRuntimePersistenceRepository } from './agent-runtime-persistence-repo';
import { AgentConversationTable, AgentChatQueueTable } from '../schema/drizzle';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from '../services/workspace-projection.test-support';
import { AgentConversationSyncRepository } from '../sync/agent-chat/repository';
import { seedAgentChatSession } from '../sync/agent-chat/seed';
import { createRepositoryAgentTransportPersistence } from '../lib/agent/runtime/repository-transport-persistence';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport, type GeneralAgentTransport } from '../lib/agent/transport';
import { useAgentChatStore } from '../store/agent-chat-store';
import { useSettingsStore } from '../store/settings-store';

const MCP_ID = 'mcp:synthetic:conversation';
const initial = useAgentChatStore.getState();
const settings = useSettingsStore.getState();
const repo = createAgentConversationRepository();
let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>>;
let restoreTransport: () => void;
const start = vi.fn<GeneralAgentTransport['start']>();
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

beforeEach(async () => {
  fixture = await createWorkspaceProjectionFixture();
  start.mockReset();
  restoreTransport = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport, start,
    subscribeJournal: () => ({ ok: true, value: () => undefined }),
  });
  useAgentChatStore.setState(initial, true);
  useSettingsStore.setState({ lastAgentConvByProject: {} });
  await repo.create({ id: 'internal', projectId: INPUT.projectId, title: 'MCP · Synthetic', mode: 'byok',
    messages: [{ kind: 'assistant', text: 'Synthetic internal chat' }], createdAt: NOW, updatedAt: NOW });
  await fixture.db.insert(AgentConversationTable).values({ id: MCP_ID, projectId: INPUT.projectId,
    title: 'Renamed external session', source: 'external_mcp', createdAt: NOW, updatedAt: NOW });
});
afterEach(async () => {
  await settle();
  restoreTransport();
  useAgentChatStore.setState(initial, true);
  useSettingsStore.setState(settings, true);
  expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  await fixture.close();
});

describe('internal chat and external MCP conversation ownership', () => {
  it('filters history, direct hydration and usage by source rather than title or credentials', async () => {
    expect((await repo.listByProject(INPUT.projectId)).map(row => row.id)).toEqual(['internal']);
    expect(await repo.get(MCP_ID)).toBeNull();
    expect((await repo.usageByProject(INPUT.projectId)).map(row => row.id)).toEqual(['internal']);
    expect(await repo.get('internal')).toMatchObject({ title: 'MCP · Synthetic', mode: 'byok' });
  });

  it('does not rename or delete external audit records through chat management', async () => {
    await repo.update(MCP_ID, { title: 'Should not change', messages: [] });
    expect(await repo.softDelete(MCP_ID, NOW)).toEqual([]);
    expect((await repo.softDeleteAllByProject(INPUT.projectId, NOW)).map(row => row.id)).toEqual(['internal']);
    const [external] = await fixture.db.select().from(AgentConversationTable).where(eq(AgentConversationTable.id, MCP_ID));
    expect(external).toMatchObject({ title: 'Renamed external session', source: 'external_mcp', deletedAt: null });
  });

  it('ignores a saved MCP selection and rejects direct open and continuation', async () => {
    useSettingsStore.getState().setLastAgentConv(INPUT.projectId, MCP_ID);
    useAgentChatStore.getState().bindProject(INPUT.projectId);
    await settle();
    expect(useAgentChatStore.getState().activeConvId).toBeNull();
    await useAgentChatStore.getState().loadConversation(MCP_ID);
    expect(useAgentChatStore.getState().activeConvId).toBeNull();
    expect(useAgentChatStore.getState().runs[MCP_ID]).toBeUndefined();
    // Even a stale view selected by an older build must not start a model turn.
    useAgentChatStore.setState({ activeConvId: MCP_ID, prompt: 'Synthetic continuation' });
    await useAgentChatStore.getState().send();
    expect(start).not.toHaveBeenCalled();
    expect((await fixture.db.select().from(AgentConversationTable).where(eq(AgentConversationTable.id, MCP_ID)))[0].messagesJson).toBe('[]');
  });

  it('excludes MCP inserts, updates and completed tool turns from chat sync while retaining audit rows', async () => {
    const runtime = createAgentRuntimePersistenceRepository(fixture.db);
    await runtime.createSession({ id: 'mcp:synthetic', projectId: INPUT.projectId, routeKind: 'chat',
      conversationId: MCP_ID, goalRunId: null, chapterId: null, provider: 'mcp', model: null,
      providerEpoch: 0, status: 'idle', createdAt: NOW, updatedAt: NOW, endedAt: null });
    await runtime.createTurn({ id: 'external-turn', sessionId: 'mcp:synthetic', ordinal: 1, status: 'running',
      promptMessageId: null, acceptedAt: NOW, startedAt: NOW, endedAt: null, errorCode: null, errorMessage: null, updatedAt: NOW });
    await runtime.createToolCall({ id: 'external-call', sessionId: 'mcp:synthetic', turnId: 'external-turn', callId: '1',
      name: 'get_project_overview', access: 'read', status: 'completed', idempotencyKey: 'synthetic-call',
      arguments: {}, result: { ok: true, data: {} }, errorCode: null, createdAt: NOW, startedAt: NOW, completedAt: NOW });
    await runtime.updateTurn('external-turn', { status: 'completed', endedAt: NOW, updatedAt: NOW });
    await fixture.db.update(AgentConversationTable).set({ updatedAt: NOW }).where(eq(AgentConversationTable.id, MCP_ID));
    expect((await fixture.db.select().from(AgentChatQueueTable)).map(row => row.conversationId)).toEqual(['internal']);
    const sync = new AgentConversationSyncRepository(fixture.db);
    await sync.flush(INPUT.projectId);
    expect(fixture.gateway.database.prepare('SELECT id FROM agent_chat_branch').all()).toEqual([{ id: 'internal' }]);
    expect(await sync.flush(INPUT.projectId)).toBe(0);
    await repo.softDeleteAllByProject(INPUT.projectId, NOW);
    const snapshot = await runtime.loadRecoverySnapshot('mcp:synthetic');
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.toolCalls).toHaveLength(1);
    await expect(sync.forkForContinuation(MCP_ID)).rejects.toThrow('External MCP');
    await expect(seedAgentChatSession(fixture.db, MCP_ID, INPUT.projectId, 'test', null)).rejects.toThrow('External MCP');
    const persistence = createRepositoryAgentTransportPersistence({ repository: runtime, resolveToolAccess: () => 'read' });
    for (const newConversation of [true, false]) {
      await expect(persistence.prepareTurn({ candidateSessionId: 'must-not-create', newConversation,
        resumeSessionId: 'mcp:synthetic', route: { kind: 'chat', projectId: INPUT.projectId, conversationId: MCP_ID },
        provider: 'test', model: null, turnId: 'must-not-run', prompt: 'Synthetic', acceptedAt: NOW,
      })).rejects.toThrow('External MCP');
    }
    const rawPersistence = createRepositoryAgentTransportPersistence({
      repository: { ...runtime, preparePortableHistory: undefined }, resolveToolAccess: () => 'read',
    });
    await expect(rawPersistence.prepareTurn({ candidateSessionId: 'must-not-create', newConversation: false,
      resumeSessionId: 'mcp:synthetic', route: { kind: 'chat', projectId: INPUT.projectId, conversationId: MCP_ID },
      provider: 'test', model: null, turnId: 'must-not-run', prompt: 'Synthetic', acceptedAt: NOW,
    })).rejects.toMatchObject({ code: 'AGENT_SESSION_ROUTE_MISMATCH' });
    expect(await runtime.getSession('mcp:synthetic')).toMatchObject({ provider: 'mcp', status: 'idle' });
  });

  it('does not project MCP branches received from older clients into chat history', async () => {
    const sync = new AgentConversationSyncRepository(fixture.db);
    for (const id of ['mcp:remote:conversation', 'remote-child']) {
      await sync.put({ kind: 'branch', id: `metadata-${id}`, projectId: INPUT.projectId,
        branchId: id, rootId: 'mcp:remote:conversation', parentBranchId: null, forkTurnId: null,
        title: 'Legacy external placeholder', clock: '0000000000000001:00000000-0000-0000-0000-000000000001', deletedAt: null, createdAt: NOW, updatedAt: NOW });
    }
    await sync.reconcile(INPUT.projectId);
    expect((await repo.listByProject(INPUT.projectId)).map(row => row.id)).toEqual(['internal']);
    expect(fixture.gateway.database.prepare("SELECT count(*) AS count FROM agent_conversation WHERE id IN ('mcp:remote:conversation', 'remote-child')").get()).toEqual({ count: 0 });
  });
});

it('migrates old MCP identities and provider records without deleting history or audit data', () => {
  const directory = new URL('../../../drizzle/', import.meta.url);
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', directory), 'utf8')) as { entries: { tag: string }[] };
  const database = new DatabaseSync(':memory:');
  try {
    for (const { tag } of journal.entries.filter(entry => entry.tag < '0005_agent_conversation_source'))
      database.exec(readFileSync(new URL(`${tag}.sql`, directory), 'utf8').replaceAll('--> statement-breakpoint', ''));
    database.exec(`INSERT INTO project(id, name, user_id, created_at, updated_at) VALUES ('p', 'Synthetic', 'local', '${NOW}', '${NOW}');`);
    const insert = database.prepare('INSERT INTO agent_conversation(id, project_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const id of ['internal', 'mcp:old:conversation', 'provider-only', 'mcp:remote:conversation', 'continued-child'])
      insert.run(id, 'p', 'MCP · same title', '[]', NOW, NOW);
    database.prepare("INSERT INTO agent_runtime_session(id, project_id, route_kind, conversation_id, provider, created_at, updated_at) VALUES ('old-session', 'p', 'chat', 'provider-only', 'mcp', ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO agent_chat_branch(id, project_id, root_id, title, title_clock, created_at, updated_at) VALUES ('continued-child', 'p', 'mcp:remote:conversation', 'Synthetic', 'clock', ?, ?)").run(NOW, NOW);
    database.exec(readFileSync(new URL('0005_agent_conversation_source.sql', directory), 'utf8').replaceAll('--> statement-breakpoint', ''));
    expect(database.prepare("SELECT id FROM agent_conversation WHERE source = 'chat'").all()).toEqual([{ id: 'internal' }]);
    expect(database.prepare("SELECT count(*) AS count FROM agent_conversation WHERE source = 'external_mcp' AND deleted_at IS NULL").get()).toEqual({ count: 4 });
    expect(database.prepare('SELECT conversation_id FROM agent_chat_queue').all()).toEqual([{ conversation_id: 'internal' }]);
    expect(database.prepare('SELECT provider FROM agent_runtime_session').get()).toEqual({ provider: 'mcp' });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { database.close(); }
});
