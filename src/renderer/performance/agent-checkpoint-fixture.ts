import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { installHeadlessDatabaseClient } from '../lib/db';
import { createAgentRecoveryFixture } from './agent-recovery-fixture';
import { createAgentChatCrashFixture } from './agent-chat-crash-fixture';
import { canonicalAgentRuntimeJson as canonical, createAgentRuntimePersistenceRepository } from '../sqlite-repo/agent-runtime-persistence-repo';
import { createRepositoryAgentTransportPersistence } from '../lib/agent/runtime/repository-transport-persistence';
import { createAgentRuntimeCheckpointContextV4, recoverAgentRuntimeSnapshot } from '../lib/agent/runtime/recovery';
import type { AgentModelMessage } from '../lib/agent/runtime/types';
import type { AgentTransportCommitTurnInput } from '../lib/agent/runtime/transport-persistence';
import * as schema from '../schema/drizzle';

export const CHECKPOINT_RETAINED_FORMAT = 'drifting.agent-runtime-checkpoint-digest';
const V4 = 'drifting.agent-runtime-checkpoint-digest-with-summaries';
export const checkpointDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function checkpointDatabaseHash(gateway: ProductFileBackedSqliteGateway) {
  return checkpointDigest(gateway.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name,
    gateway.database.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
}

/** Synthetic canonical rows only; seeding is outside all measured operations. */
export async function openCheckpointFixture(databasePath: string, priorTurns?: number, gaps = false) {
  const gateway = new ProductFileBackedSqliteGateway(databasePath); const db = gateway.client();
  const uninstall = installHeadlessDatabaseClient(db, 'synthetic-checkpoints.db');
  const repository = createAgentRuntimePersistenceRepository();
  const persistence = createRepositoryAgentTransportPersistence({ repository, resolveToolAccess: () => 'read' });
  const spec = createAgentRecoveryFixture(priorTurns ?? 0); const { session } = spec.snapshot;
  const { projectId, conversationId } = session; assert(conversationId);
  try {
    if (priorTurns !== undefined) {
      assert(priorTurns >= 3);
      const { snapshot } = spec; const now = session.createdAt;
      const completed = snapshot.turns.filter(turn => !gaps || turn.ordinal % 2 === 0);
      const fullOrdinals = new Set(completed.slice(-2).map(turn => turn.ordinal));
      const history: AgentModelMessage[] = []; const runningHash = createHash('sha256').update('[');
      const checkpoints: (typeof schema.AgentRuntimeCheckpointTable.$inferInsert)[] = [];
      for (const turn of snapshot.turns) {
        const messages = snapshot.messages.filter(row => row.turnId === turn.id);
        messages.forEach((row, index) => { row.id = `agent-message:${turn.id}:${index}`; }); turn.promptMessageId = messages[0].id;
        if (gaps && turn.ordinal % 2 === 1) {
          turn.status = 'failed'; turn.errorCode = 'MODEL_ERROR';
          for (const row of snapshot.events.filter(event => event.turnId === turn.id)) {
            const payload = row.payload as { event: { type: string; outcome?: string; failureCode?: string } };
            if (payload.event.type === 'commit_started' || payload.event.type === 'turn_finished') payload.event.outcome = 'failed';
            if (payload.event.type === 'turn_finished') payload.event.failureCode = 'MODEL_ERROR';
          }
          continue;
        }
        for (const row of messages) {
          const message = { role: row.role, content: row.content } as AgentModelMessage;
          if (history.length) runningHash.update(','); runningHash.update(canonical(message)); history.push(message);
        }
        const context = { schemaVersion: 4 as const, format: V4, canonicalMessageCount: history.length,
          canonicalHistoryHash: `sha256:${runningHash.copy().update(']').digest('hex')}`, durableSummaries: [] };
        if (fullOrdinals.has(turn.ordinal)) assert.equal(canonical(await createAgentRuntimeCheckpointContextV4({ canonicalHistory: history, durableSummaries: [] })), canonical(context));
        const contextHash = `sha256:${checkpointDigest(context)}`;
        checkpoints.push({ id: `agent-checkpoint:${session.id}:${turn.ordinal}`, sessionId: session.id, throughTurnOrdinal: turn.ordinal,
          messageCount: history.length, contextJson: canonical(fullOrdinals.has(turn.ordinal) ? context : { schemaVersion: 1, format: CHECKPOINT_RETAINED_FORMAT, contextHash }), contextHash, createdAt: now });
      }
      await db.transaction(async tx => {
        await tx.insert(schema.ProjectTable).values([{ id: projectId, userId: 'synthetic', name: 'Synthetic checkpoints', createdAt: now, updatedAt: now },
          { id: 'synthetic-checkpoint-foreign', userId: 'synthetic', name: 'Foreign sentinel', createdAt: now, updatedAt: now }]);
        await tx.insert(schema.AgentConversationTable).values({ id: conversationId, projectId, title: 'Synthetic checkpoints', runtimeSessionId: session.id, messagesJson: '[]', createdAt: now, updatedAt: now });
        await tx.insert(schema.AgentRuntimeSessionTable).values(session);
        for (let index = 0; index < snapshot.turns.length; index += 64) await tx.insert(schema.AgentRuntimeTurnTable).values(snapshot.turns.slice(index, index + 64));
        const messages = snapshot.messages.map(({ content, ...row }) => ({ ...row, contentJson: canonical(content) }));
        for (let index = 0; index < messages.length; index += 64) await tx.insert(schema.AgentRuntimeMessageTable).values(messages.slice(index, index + 64));
        const events = snapshot.events.map(({ payload, ...row }) => ({ ...row, payloadJson: canonical(payload) }));
        for (let index = 0; index < events.length; index += 64) await tx.insert(schema.AgentRuntimeEventTable).values(events.slice(index, index + 64));
        for (let index = 0; index < checkpoints.length; index += 64) await tx.insert(schema.AgentRuntimeCheckpointTable).values(checkpoints.slice(index, index + 64));
      }, { behavior: 'immediate' });
      assert.deepEqual((await recoverAgentRuntimeSnapshot((await repository.loadRecoverySnapshot(session.id))!)).providerHistory, history);
    }
    const prepareMixed = async (seed = 1) => {
      const mixed = createAgentChatCrashFixture(seed, true);
      await persistence.prepareTurn({ candidateSessionId: session.id, resumeSessionId: session.id, newConversation: false,
        route: { kind: 'chat', projectId, conversationId }, provider: 'synthetic-provider', model: 'synthetic-model',
        turnId: mixed.turnId, prompt: mixed.prompt, acceptedAt: mixed.acceptedAt });
      for (const entry of mixed.entries) await persistence.appendJournal({ ...entry, sessionId: session.id, route: { kind: 'chat', projectId, conversationId } });
      const input: AgentTransportCommitTurnInput = { sessionId: session.id, turnId: mixed.turnId, turnMessages: mixed.history,
        outcome: 'completed', errorCode: null, errorMessage: null, endedAt: new Date(mixed.entries[mixed.entries.length - 1].wallTimeMs).toISOString() };
      return { mixed, input, commit: () => persistence.commitTurn(input) };
    };
    const firstInput: AgentTransportCommitTurnInput | undefined = priorTurns === undefined ? undefined : {
      sessionId: session.id, turnId: spec.snapshot.turns[0].id, turnMessages: spec.snapshot.messages.filter(row => row.turnId === spec.snapshot.turns[0].id).map(row => ({ role: row.role, content: row.content }) as AgentModelMessage),
      outcome: 'completed', errorCode: null, errorMessage: null, endedAt: session.createdAt,
    };
    const fullOrdinals = async () => (await repository.listCheckpoints(session.id)).map(row => row.throughTurnOrdinal);
    const close = async () => { uninstall(); await gateway.close(); };
    return { gateway, db, repository, persistence, session, prepareMixed, firstInput, fullOrdinals, close };
  } catch (error) { uninstall(); await gateway.close(); throw error; }
}

/** Count actual rows crossing the gateway, with the actual SQLite query plan. */
export function observeCheckpointQueries(fixture: Awaited<ReturnType<typeof openCheckpointFixture>>) {
  const reads: { rows: number; bytes: number; plan: string[] }[] = [];
  const query = fixture.gateway.query.bind(fixture.gateway);
  fixture.gateway.query = async (sql, parameters, transactionId) => {
    const result = await query(sql, parameters, transactionId);
    if (/^select /i.test(sql) && sql.includes('from "agent_runtime_checkpoint"')) {
      const statement = fixture.gateway.database.prepare(`EXPLAIN QUERY PLAN ${sql}`);
      const plan = statement.all(...(parameters ?? []) as import('node:sqlite').SQLInputValue[]).map(row => String(row.detail));
      reads.push({ rows: result.rows.length, bytes: Buffer.byteLength(JSON.stringify(result)), plan });
    }
    return result;
  };
  return { reads, restore: () => { fixture.gateway.query = query; } };
}
