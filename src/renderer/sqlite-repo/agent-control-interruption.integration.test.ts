import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT, WORKSPACE_TEST_NOW as AT } from '../services/workspace-projection.test-support';
import { createAgentConversationRepository } from './agent-conversation-repo';
import { createAgentRuntimePersistenceRepository } from './agent-runtime-persistence-repo';
import type { PersistedAgentRuntimeEvent } from '../domain/agent-runtime-persistence';

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>>;
const repository = createAgentRuntimePersistenceRepository();
const SESSION = 'synthetic-session'; const TURN = 'synthetic-turn'; const LATER = '2026-09-13T00:00:00.000Z';
const entries: PersistedAgentRuntimeEvent[] = ['cancellation_requested', 'tool_result'].map((eventType, index) => ({
  eventId: `synthetic-event-${index}`, sessionId: SESSION, turnId: TURN, seq: index + 1, schemaVersion: 1,
  eventType, payload: { event: { type: eventType } }, wallTimeMs: index + 1, createdAt: LATER,
}));
const rows = () => JSON.stringify(fixture.gateway.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name,
  fixture.gateway.database.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
beforeEach(async () => {
  fixture = await createWorkspaceProjectionFixture();
  await createAgentConversationRepository().create({ id: 'synthetic-conversation', projectId: WORKSPACE_TEST_INPUT.projectId, title: 'Synthetic', mode: 'byok', messages: [], createdAt: AT, updatedAt: AT });
  await repository.acceptTurn({
    session: { id: SESSION, projectId: WORKSPACE_TEST_INPUT.projectId, conversationId: 'synthetic-conversation', routeKind: 'chat', goalRunId: null,
      chapterId: null, provider: 'synthetic', model: 'scripted', providerEpoch: 0, status: 'pending', createdAt: AT, updatedAt: AT, endedAt: null },
    turn: { id: TURN, sessionId: SESSION, ordinal: 0, status: 'accepted', promptMessageId: 'synthetic-prompt', acceptedAt: AT, startedAt: null,
      endedAt: null, errorCode: null, errorMessage: null, updatedAt: AT },
    promptMessage: { id: 'synthetic-prompt', sessionId: SESSION, turnId: TURN, ordinal: 0, role: 'user', status: 'complete', content: 'Synthetic request', createdAt: AT, completedAt: AT },
  });
  await repository.markTurnRunning(SESSION, TURN, AT);
  for (const [id, access, status] of [['waiting', 'write', 'requested'], ['reading', 'read', 'running'], ['writing', 'write', 'running']] as const) {
    await repository.createToolCall({ id, sessionId: SESSION, turnId: TURN, callId: id, name: `synthetic_${id}`, access, status,
      idempotencyKey: `synthetic:${id}`, arguments: {}, result: null, errorCode: null, createdAt: AT, startedAt: status === 'running' ? AT : null, completedAt: null });
  }
});
afterEach(async () => {
  expect(fixture.gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]); await fixture.close();
});

describe('atomic recovered-control interruption on product SQLite', () => {
  it('settles journal and lifecycle together while preserving uncertain writes and unrelated prose', async () => {
    const prose = fixture.gateway.database.prepare('SELECT * FROM node_content').all();
    const foreign = fixture.gateway.database.prepare("SELECT * FROM project WHERE id='other-project'").get();
    await repository.interruptSessionWithEvents(SESSION, LATER, entries);
    const snapshot = (await repository.loadRecoverySnapshot(SESSION))!;
    expect(snapshot.events).toEqual(entries); expect(snapshot.session.status).toBe('interrupted'); expect(snapshot.turns[0].status).toBe('interrupted');
    expect(Object.fromEntries(snapshot.toolCalls.map(tool => [tool.id, tool.status]))).toEqual({ waiting: 'interrupted', reading: 'interrupted', writing: 'uncertain' });
    expect(snapshot.messages[0].status).toBe('complete');
    expect(fixture.gateway.database.prepare('SELECT * FROM node_content').all()).toEqual(prose);
    expect(fixture.gateway.database.prepare("SELECT * FROM project WHERE id='other-project'").get()).toEqual(foreign);
  });
  for (const point of ['second-event', 'session-interruption', 'root-commit'] as const) it(`rolls back every row on ${point} failure and allows retry`, async () => {
    const before = rows();
    if (point === 'root-commit') {
      const commit = fixture.gateway.commit.bind(fixture.gateway); let first = true;
      fixture.gateway.commit = async id => { if (first) { first = false; throw new Error('synthetic commit failure'); } await commit(id); };
    } else fixture.gateway.failNextExecute((sql, parameters) => point === 'second-event'
      ? /^insert into "agent_runtime_event"/i.test(sql) && parameters.includes('tool_result')
      : /^update "agent_runtime_session"/i.test(sql) && parameters.includes('interrupted'));
    await expect(repository.interruptSessionWithEvents(SESSION, LATER, entries)).rejects.toThrow();
    expect(rows()).toBe(before);
    await repository.interruptSessionWithEvents(SESSION, LATER, entries);
    expect((await repository.getSession(SESSION))?.status).toBe('interrupted'); expect(await repository.listEvents(SESSION)).toEqual(entries);
  });
  for (const invalid of ['sequence-gap', 'foreign-session'] as const) it(`rejects a ${invalid} after the first event without a partial prefix`, async () => {
    const before = rows(); const input = structuredClone(entries);
    if (invalid === 'sequence-gap') input[1].seq = 4; else input[1].sessionId = 'foreign-session';
    await expect(repository.interruptSessionWithEvents(SESSION, LATER, input)).rejects.toMatchObject({ code: invalid === 'sequence-gap' ? 'EVENT_SEQ_GAP' : 'EVENT_SESSION_MISMATCH' });
    expect(rows()).toBe(before);
  });
  it('preserves exact replay idempotency after the batch has committed', async () => {
    await repository.interruptSessionWithEvents(SESSION, LATER, entries); const before = rows();
    await repository.interruptSessionWithEvents(SESSION, LATER, entries); expect(rows()).toBe(before);
  });
  it('participates in a caller transaction and rolls back when its owner fails', async () => {
    const before = rows();
    await expect(fixture.db.transaction(async tx => {
      await createAgentRuntimePersistenceRepository(tx).interruptSessionWithEvents(SESSION, LATER, entries);
      expect((await createAgentRuntimePersistenceRepository(tx).getSession(SESSION))?.status).toBe('interrupted');
      throw new Error('synthetic owner rollback');
    }, { behavior: 'immediate' })).rejects.toThrow('synthetic owner rollback');
    expect(rows()).toBe(before);
  });
});
