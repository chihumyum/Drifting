import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installHeadlessDatabaseClient } from '../lib/db';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createAgentRuntimePersistenceRepository } from '../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import { createRepositoryAgentTransportPersistence } from '../lib/agent/runtime/repository-transport-persistence';
import { createAgentChatJournalConsumer } from '../lib/agent/runtime/chat-journal-consumer';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { loadCanonicalAgentChatProjection } from '../lib/agent/runtime/recovered-transcript';
import { recoverAgentRuntimeSnapshot } from '../lib/agent/runtime/recovery';
import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { ProjectTable } from '../schema/drizzle';
import type { AgentChatRunState } from '../lib/agent/runtime/chat-run-projection';
import type { AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import { createAgentChatCrashFixture, CHAT_CRASH_PROJECT as PROJECT, CHAT_CRASH_CONVERSATION as CONVERSATION,
  CHAT_CRASH_SESSION as SESSION, CHAT_CRASH_TIME as NOW } from './agent-chat-crash-fixture';

function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function hold(value: unknown): never {
  assert(process.send, 'Crash worker requires IPC.');
  process.send(value);
  // Freeze the owned process immediately: no pending cache write, timer or
  // SQLite close/checkpoint is allowed to race the parent's real SIGKILL.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Crash boundary unexpectedly resumed.');
}
async function emit(value: unknown) {
  assert(process.send);
  await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
}

export async function runAgentChatCrashWorker(args: string[]) {
  const [mode, databasePath, boundary, seedText] = args;
  assert(databasePath && boundary && ['write', 'recover'].includes(mode));
  const seed = Number(seedText); assert(Number.isSafeInteger(seed) && seed > 0);
  const cuts: Record<string, number> = { 'tool-arguments': 6, 'tool-executing': 14, 'tool-result-journal': 15,
    'tool-results': 17, 'assistant-tail': 21, 'terminal-journal': 25, 'commit-after-message': 25,
    'commit-after-checkpoint': 25, 'commit-before-commit': 25, 'commit-after-commit': 25,
    'consumer-before-cache': 25, 'cache-after-write': 25 };
  const through = cuts[boundary]; assert(through);
  const committed = ['commit-after-commit', 'consumer-before-cache', 'cache-after-write'].includes(boundary);
  const gateway = new ProductFileBackedSqliteGateway(databasePath);
  const db = gateway.client(); const uninstall = installHeadlessDatabaseClient(db, 'synthetic-chat-crash.db');
  const repository = createAgentRuntimePersistenceRepository();
  const conversations = createAgentConversationRepository();
  const persistence = createRepositoryAgentTransportPersistence({ repository, resolveToolAccess: name => name === 'read_synthetic_fixture' ? 'read' : undefined });
  const prior = createAgentChatCrashFixture(seed, false); const mixed = createAgentChatCrashFixture(seed, true);
  const priorDisplay = prior.expected(prior.entries.length, true);
  const staleCache = [...priorDisplay, mixed.user, { kind: 'assistant' as const, text: 'STALE CACHE MUST NOT BECOME TRUTH', streaming: true }];
  const completeDisplay = [...priorDisplay, ...mixed.expected(25, true)];
  const expectedDisplay = [...priorDisplay, ...mixed.expected(through, committed)];
  const commit = (fixture: typeof mixed) => persistence.commitTurn({ sessionId: SESSION, turnId: fixture.turnId,
    turnMessages: fixture.history, outcome: 'completed', errorCode: null, errorMessage: null,
    endedAt: new Date(fixture.entries[fixture.entries.length - 1].wallTimeMs).toISOString() });
  const prepare = (fixture: typeof mixed, newConversation: boolean) => persistence.prepareTurn({ candidateSessionId: SESSION,
    resumeSessionId: newConversation ? undefined : SESSION, newConversation, route: { kind: 'chat', projectId: PROJECT, conversationId: CONVERSATION },
    provider: 'synthetic-provider', model: 'synthetic-model', turnId: fixture.turnId, prompt: fixture.prompt, acceptedAt: fixture.acceptedAt });
  const wholeDatabaseHash = () => digest(gateway.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name,
    gateway.database.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
  let listener: ((entry: AgentRuntimeJournalEntry) => void) | undefined;
  let cleanupCount = 0; let effectCount = 0;
  let run: AgentChatRunState;
  let runningTurns: Record<string, string> = { [CONVERSATION]: mixed.turnId };
  const writes: Promise<void>[] = [];
  const observed = { completionRows: 0, checkpointWritten: false, terminalWritten: false, transactionCommitted: false };
  const ready = () => ({ ready: true, boundary, seed, through, observed });
  const consumer = createAgentChatJournalConsumer({
    read: () => ({ boundProjectId: PROJECT, runs: { [CONVERSATION]: run }, runningTurns }),
    updateRun: (_id, project) => { run = project(run); },
    subscribeJournal: callback => { listener = callback; return { ok: true, value: () => { cleanupCount++; } }; },
    subscribeChanges: () => () => { cleanupCount++; }, conversationsChanged: () => { effectCount++; },
    refreshPlan: () => { effectCount++; }, finishTurn: (_id, turn) => { effectCount++; if (runningTurns[CONVERSATION] === turn) runningTurns = {}; },
    activity: () => ({ onToolUse: () => { effectCount++; }, onToolResult: () => { effectCount++; }, onTurnEnd: () => { effectCount++; } }),
    persistConversation: () => {
      effectCount++;
      assert.deepEqual(run.transcript.toArray(), completeDisplay, 'Terminal cache must receive the final mixed transcript.');
      if (mode === 'write' && boundary === 'consumer-before-cache') hold(ready());
      writes.push(conversations.update(CONVERSATION, { messages: run.transcript.toArray(), updatedAt: NOW }));
    },
  });
  const installRun = (messages: typeof priorDisplay, eventIds: string[]) => {
    run = { projectId: PROJECT, runtimeSessionId: SESSION, transcript: AgentChatTranscript.from(messages),
      journalScope: createAgentChatJournalScope(eventIds), controlStatus: 'running', pendingControl: null,
      lastTerminal: null, longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() };
    assert(consumer.ensureConnected()); consumer.registerTurn(mixed.turnId, CONVERSATION);
  };
  try {
    if (mode === 'write') {
      for (const id of [PROJECT, 'synthetic-foreign-project']) await db.insert(ProjectTable).values({ id, name: 'Synthetic', userId: 'synthetic-user', createdAt: NOW, updatedAt: NOW });
      await conversations.create({ id: 'synthetic-foreign-conversation', projectId: 'synthetic-foreign-project', title: 'Synthetic foreign sentinel', mode: 'byok', messages: [{ kind: 'user', text: 'Foreign sentinel' }], createdAt: NOW, updatedAt: NOW });
      await conversations.create({ id: CONVERSATION, projectId: PROJECT, title: 'Synthetic mixed crash', mode: 'byok', messages: [prior.user], runtimeSessionId: SESSION, createdAt: NOW, updatedAt: NOW });
      await prepare(prior, true);
      for (const entry of prior.entries) await persistence.appendJournal(entry);
      await commit(prior);
      await conversations.update(CONVERSATION, { messages: staleCache });
      await prepare(mixed, false);
      installRun([...priorDisplay, mixed.user], prior.entries.map(entry => entry.eventId));
      if (boundary === 'tool-result-journal') {
        const append = repository.appendEvent.bind(repository);
        repository.appendEvent = async event => {
          const result = await append(event);
          if (event.turnId === mixed.turnId && event.seq === 15) hold(ready());
          return result;
        };
      }
      for (const entry of mixed.entries) {
        await persistence.appendJournal(entry);
        if (['tool-arguments', 'tool-executing', 'tool-results', 'assistant-tail', 'terminal-journal'].includes(boundary) && entry.seq === through) hold(ready());
        if (entry.event.type !== 'turn_finished') listener!(entry);
      }
      const execute = gateway.execute.bind(gateway);
      let completionTransaction: string | undefined;
      gateway.execute = async (sql, parameters, transactionId) => {
        const result = await execute(sql, parameters, transactionId);
        if (sql.startsWith('insert into "agent_runtime_message"')) {
          assert(transactionId); completionTransaction = transactionId; observed.completionRows++;
          if (boundary === 'commit-after-message') hold(ready());
        }
        if (sql.startsWith('insert into "agent_runtime_checkpoint"')) {
          assert.equal(transactionId, completionTransaction); observed.checkpointWritten = true;
          if (boundary === 'commit-after-checkpoint') hold(ready());
        }
        if (sql.startsWith('update "agent_runtime_turn"') && parameters?.includes('completed')) {
          assert.equal(transactionId, completionTransaction); observed.terminalWritten = true;
        }
        return result;
      };
      const commitTransaction = gateway.commit.bind(gateway);
      gateway.commit = async transactionId => {
        const completesTurn = transactionId === completionTransaction;
        if (completesTurn) {
          assert.equal(observed.completionRows, 3); assert(observed.checkpointWritten && observed.terminalWritten);
          if (boundary === 'commit-before-commit') hold(ready());
        }
        await commitTransaction(transactionId);
        if (completesTurn) {
          observed.transactionCommitted = true;
          if (boundary === 'commit-after-commit') hold(ready());
        }
      };
      await commit(mixed);
      listener!(mixed.entries[mixed.entries.length - 1]);
      const terminalRun = run!; const terminalEffects = effectCount;
      listener!(mixed.entries[mixed.entries.length - 1]);
      assert.equal(run!, terminalRun); assert.equal(effectCount, terminalEffects);
      assert.deepEqual(runningTurns, {});
      await Promise.all(writes);
      assert.equal(boundary, 'cache-after-write');
      hold(ready());
    }
    const databaseBefore = wholeDatabaseHash();
    const stored = await conversations.get(CONVERSATION); assert(stored);
    assert.deepEqual(stored.messages, boundary === 'cache-after-write' ? completeDisplay : staleCache, 'Cache interruption boundary.');
    const snapshot = await repository.loadRecoverySnapshot(SESSION); assert(snapshot);
    const recovered = await recoverAgentRuntimeSnapshot(snapshot);
    const projection = await loadCanonicalAgentChatProjection(SESSION, repository, stored.messages); assert(projection);
    assert.deepEqual(projection.messages, expectedDisplay, 'Independent literal display oracle.');
    assert.deepEqual(recovered.providerHistory, committed ? [...prior.history, ...mixed.history] : prior.history, 'Only complete committed turns enter provider history.');
    assert.equal(snapshot.messages.length, committed ? 6 : 3);
    assert.equal(snapshot.checkpoints.length, committed ? 2 : 1);
    assert.equal(recovered.checkpointId, `agent-checkpoint:${SESSION}:${committed ? 1 : 0}`);
    assert.equal(recovered.turns[recovered.turns.length - 1]?.recoveredStatus, committed ? 'completed' : 'interrupted');
    assert.equal(projection.lastTerminal?.outcome, committed ? 'completed' : 'failed');
    assert.equal(snapshot.events.length, prior.entries.length + through);
    assert.deepEqual(projection.eventIds, [...prior.entries, ...mixed.entries.slice(0, through)].map(entry => entry.eventId));
    assert.deepEqual(snapshot.toolCalls.map(tool => tool.status), through === 6 ? [] : through === 14 || through === 15 ? ['running', 'requested'] : ['completed', 'failed']);
    const foreign = await conversations.get('synthetic-foreign-conversation');
    assert.equal(foreign?.projectId, 'synthetic-foreign-project');
    assert.deepEqual(foreign?.messages, [{ kind: 'user', text: 'Foreign sentinel' }]);
    installRun(projection.messages, projection.eventIds);
    const recoveredRun = run!;
    for (let repeat = 0; repeat < 2; repeat++) for (const entry of [...prior.entries, ...mixed.entries.slice(0, through)]) listener!(entry);
    assert.equal(run!, recoveredRun); assert.equal(effectCount, 0); assert.equal(writes.length, 0);
    consumer.dispose(); consumer.dispose();
    listener!({ ...mixed.entries[mixed.entries.length - 1], eventId: 'synthetic-late-after-disposal' });
    assert.equal(run!, recoveredRun); assert.equal(effectCount, 0); assert.equal(cleanupCount, 2);
    assert.equal(wholeDatabaseHash(), databaseBefore, 'Display recovery and duplicate replay must be read-only.');
    assert.equal(gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(gateway.database.prepare('PRAGMA foreign_key_check').all(), []);
    await emit({ recovered: true, boundary, seed, through, committed, messageCount: projection.messages.length,
      checks: ['literal-display', 'committed-provider-history', 'checkpoint-atomicity', 'journal-and-tool-rows', 'cache-boundary',
        'foreign-project-isolation', 'replay-deduplication', 'disposed-consumer', 'read-only-recovery', 'integrity', 'foreign-keys'],
      databaseHash: databaseBefore, displayHash: digest(projection.messages), providerHash: digest(recovered.providerHistory) });
  } finally { consumer.dispose(); uninstall(); await gateway.close(); }
}
