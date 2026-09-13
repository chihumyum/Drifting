import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installHeadlessDatabaseClient } from '../lib/db';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createAgentRuntimePersistenceRepository } from '../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentRuntimeWriteEffectRepository } from '../sqlite-repo/agent-runtime-write-effect-repo';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import { createRepositoryAgentTransportPersistence } from '../lib/agent/runtime/repository-transport-persistence';
import { LocalGeneralAgentTransport } from '../lib/agent/runtime/local-transport';
import { ScriptedFakeDriver } from '../lib/agent/runtime/testing';
import { installGeneralAgentTransport } from '../lib/agent/transport';
import { useAgentChatStore } from '../store/agent-chat-store';
import { ProjectTable } from '../schema/drizzle';

const PROJECT = 'synthetic-control-project'; const CONVERSATION = 'synthetic-control-conversation';
const SESSION = 'synthetic-control-session'; const TURN = 'synthetic-control-turn'; const TOOL = 'synthetic_control_tool';
const AT = '2026-09-13T00:00:00.000Z';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function hold(value: unknown): never {
  assert(process.send); process.send(value); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Crash boundary unexpectedly resumed.');
}
async function emit(value: unknown) { assert(process.send); await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve())); }
export async function runAgentControlCrashWorker(args: string[]) {
  const [mode, databasePath, kind, cut, seedText] = args; const seed = Number(seedText);
  assert(databasePath && ['seed', 'cancel', 'recover'].includes(mode)); assert(['permission', 'user'].includes(kind)); assert(Number.isSafeInteger(seed));
  const gateway = new ProductFileBackedSqliteGateway(databasePath); const db = gateway.client();
  const uninstall = installHeadlessDatabaseClient(db, 'synthetic-control.db');
  const repository = createAgentRuntimePersistenceRepository(); const conversations = createAgentConversationRepository();
  const access = kind === 'permission' ? 'write' : 'read'; let modelCalls = 0; let toolCalls = 0;
  const driver = new ScriptedFakeDriver({ rounds: [{ steps: [
    { op: 'emit', event: { type: 'text_delta', text: `Synthetic request ${seed}.` } },
    { op: 'emit', event: { type: 'tool_call_start', callId: 'synthetic-call', name: TOOL } },
    { op: 'emit', event: { type: 'tool_args_delta', callId: 'synthetic-call', delta: '{}' } },
    { op: 'emit', event: { type: 'tool_call_end', callId: 'synthetic-call' } },
    { op: 'emit', event: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } } },
    { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
  ] }] });
  const persistence = createRepositoryAgentTransportPersistence({ repository, writeEffects: createAgentRuntimeWriteEffectRepository(), resolveToolAccess: name => name === TOOL ? access : undefined });
  const transport = new LocalGeneralAgentTransport({ persistence, createId: () => SESSION,
    driver: { id: 'synthetic-controls', async *stream(input) { modelCalls++; assert.equal(mode, 'seed', 'Recovery must not execute a provider'); yield* driver.stream(input); } },
    permissionPolicy: { decide: () => kind === 'permission' ? { decision: 'ask' as const, allowedScopes: ['once' as const] } : { decision: 'allow' as const } },
    tools: { listDefinitions: () => [{ name: TOOL, access, description: 'Synthetic control fixture', inputSchema: { type: 'object' }, validateInput: value => ({ ok: true as const, value }) }],
      async execute(request) { toolCalls++; assert.equal(kind, 'user', 'Unapproved write must not execute'); assert.equal(mode, 'seed'); await request.control!.requestUserInput({ prompt: `Synthetic choice ${seed}` }); throw new Error('Synthetic input must remain unanswered'); } },
  });
  const restoreTransport = installGeneralAgentTransport(transport);
  const wholeHash = () => digest(gateway.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name,
    gateway.database.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
  const foreignHash = () => digest(gateway.database.prepare("SELECT * FROM project WHERE id='synthetic-control-foreign'").all());
  const initialForeignHash = foreignHash();
  const state = () => useAgentChatStore.getState().runs[CONVERSATION];
  const pending = () => state()?.pendingControl;
  const observed = { writes: [] as string[], transactionIds: [] as string[], committedTransactionIds: [] as string[] };
  const identity = { mode, kind, cut, seed };
  try {
    if (mode === 'seed') {
      await db.insert(ProjectTable).values([{ id: PROJECT, userId: 'synthetic', name: 'Synthetic controls', createdAt: AT, updatedAt: AT },
        { id: 'synthetic-control-foreign', userId: 'synthetic', name: 'Synthetic sentinel', createdAt: AT, updatedAt: AT }]);
      await conversations.create({ id: CONVERSATION, projectId: PROJECT, title: 'Synthetic control', mode: 'byok', messages: [], createdAt: AT, updatedAt: AT });
    }
    const beforeLoad = wholeHash();
    useAgentChatStore.getState().bindProject(PROJECT, { restoreLastConversation: false }); await useAgentChatStore.getState().loadConversation(CONVERSATION);
    if (mode === 'seed') {
      const started = await transport.start({ prompt: `Synthetic task ${seed}`, turnId: TURN, route: { kind: 'chat', projectId: PROJECT, conversationId: CONVERSATION } }); assert.equal(started.ok, true);
      for (let i = 0; i < 1000 && !pending(); i++) await new Promise(resolve => setTimeout(resolve, 1));
      assert(pending(), JSON.stringify({run: state(), events: (await repository.listEvents(SESSION)).map(row => row.payload)})); assert.equal(pending()!.requiresContinuation, false);
      assert.equal(pending()!.status, kind === 'permission' ? 'waiting_permission' : 'waiting_user');
      assert.equal(modelCalls, 1); assert.equal(toolCalls, kind === 'user' ? 1 : 0);
      hold({ ...identity, ready: true, pending: pending(), databaseHash: wholeHash(), foreignHash: foreignHash(), modelCalls, toolCalls });
    }
    assert.equal(wholeHash(), beforeLoad, 'Hydration must be read-only');
    const beforeHash = wholeHash(); const beforePending = pending() ?? null;
    if (mode === 'cancel') {
      assert.equal(pending()?.requiresContinuation, true);
      const execute = gateway.execute.bind(gateway); const commit = gateway.commit.bind(gateway);
      const ready = () => ({ ...identity, ready: true, beforeHash, beforePending, observed, modelCalls, toolCalls });
      gateway.execute = async (sql, parameters = [], transactionId) => {
        const result = await execute(sql, parameters, transactionId);
        let step: string | null = null;
        if (/^insert into "agent_runtime_event"/i.test(sql)) {
          for (const event of ['permission_resolved', 'cancellation_requested', 'tool_result']) if (parameters.includes(event)) step = event;
        } else if (/^update "agent_runtime_session"/i.test(sql) && parameters.includes('interrupted')) step = 'session-interrupted';
        if (step) { observed.writes.push(step); assert(transactionId, 'Cancellation write escaped a transaction'); observed.transactionIds.push(transactionId); if (step === cut) hold(ready()); }
        return result;
      };
      gateway.commit = async id => {
        const cancellation = observed.transactionIds.includes(id);
        if (cancellation && cut === 'before-commit') hold(ready());
        await commit(id);
        if (cancellation) {
          observed.committedTransactionIds.push(id);
          if (cut === 'committed') hold(ready());
        }
      };
      await useAgentChatStore.getState().cancelRecoveredControl();
      throw new Error(`Requested cancellation boundary ${cut} was not reached; pending=${JSON.stringify(pending())}`);
    }
    const durable = (await repository.loadRecoverySnapshot(SESSION))!; assert(durable);
    assert.equal(modelCalls, 0); assert.equal(toolCalls, 0); assert.equal(wholeHash(), beforeHash); assert.equal(foreignHash(), initialForeignHash);
    assert.equal(gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(gateway.database.prepare('PRAGMA foreign_key_check').all(), []);
    const events = durable.events.map(event => event.eventType);
    await emit({ ...identity, recovered: true, databaseHash: beforeHash, pending: beforePending,
      transcriptHash: digest(state().transcript.toArray()), foreignHash: foreignHash(), events, sessionStatus: durable.session.status, turnStatus: durable.turns[0].status, toolStatus: durable.toolCalls[0]?.status,
      modelCalls, toolCalls, checks: ['read-only-hydration', 'no-provider-or-tool-replay', 'foreign-project-isolation', 'integrity', 'foreign-keys'] });
  } finally { restoreTransport(); uninstall(); await gateway.close(); }
}
