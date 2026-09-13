import assert from 'node:assert/strict';
import { openCheckpointFixture, observeCheckpointQueries, checkpointDatabaseHash, checkpointDigest } from './agent-checkpoint-fixture';
import { recoverAgentRuntimeSnapshot } from '../lib/agent/runtime/recovery';
import { loadCanonicalAgentChatProjection } from '../lib/agent/runtime/recovered-transcript';
import type { AgentModelMessage } from '../lib/agent/runtime/types';
function hold(value: unknown): never {
  assert(process.send); process.send(value); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Checkpoint boundary unexpectedly resumed.');
}
async function emit(value: unknown) { assert(process.send); await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve())); }
export async function runAgentCheckpointWorker(args: string[]) {
  const [mode, databasePath, argument, seedText] = args; assert(databasePath && ['measure', 'write', 'recover'].includes(mode));
  const seed = Number(seedText); const boundary = argument; const count = Number(argument);
  const fixture = await openCheckpointFixture(databasePath, mode === 'recover' ? undefined : mode === 'write' ? 6 : count, mode === 'write');
  const { repository, gateway, session } = fixture;
  const foreignHash = () => checkpointDigest(gateway.database.prepare("SELECT * FROM project WHERE id='synthetic-checkpoint-foreign'").all());
  try {
    if (mode === 'measure') {
      const before = checkpointDatabaseHash(gateway); const history = (await recoverAgentRuntimeSnapshot((await repository.loadRecoverySnapshot(session.id))!)).providerHistory;
      const observed = observeCheckpointQueries(fixture); const listMs = [];
      for (let repetition = 0; repetition < 3; repetition++) {
        const start = performance.now(); const rows = await fixture.fullOrdinals(); listMs.push(performance.now() - start);
        assert.deepEqual(rows, [count - 2, count - 1]);
      }
      const lists = observed.reads.splice(0); observed.restore(); assert.equal(checkpointDatabaseHash(gateway), before);
      const next = await fixture.prepareMixed(seed); const commits = observeCheckpointQueries(fixture);
      const start = performance.now(); await next.commit(); const commitMs = performance.now() - start; commits.restore();
      const snapshot = (await repository.loadRecoverySnapshot(session.id))!;
      const recovered = await recoverAgentRuntimeSnapshot(snapshot); assert.deepEqual(recovered.providerHistory, [...history, ...next.mixed.history]);
      assert.deepEqual(await fixture.fullOrdinals(), [count - 1, count]);
      await emit({ mode, count, seed, lists, commitReads: commits.reads, listMs, commitMs, providerHash: checkpointDigest(recovered.providerHistory),
        checks: ['read-only-list', 'full-provider-history', 'two-anchors', 'actual-query-plan'] });
      return;
    }
    if (mode === 'write') {
      const prior = (await repository.loadRecoverySnapshot(session.id))!;
      const beforeHistory = prior.messages.filter(row => prior.turns.some(turn => turn.id === row.turnId && turn.status === 'completed')).map(row => ({ role: row.role, content: row.content }) as AgentModelMessage);
      const next = await fixture.prepareMixed(seed); const beforeHash = checkpointDatabaseHash(gateway);
      const observed = { messages: 0, checkpoint: false, compacted: [] as number[], terminal: false, committed: false, transactionIds: [] as string[] };
      let completionTransaction: string | undefined;
      const ready = () => ({ mode, boundary, seed, ready: true, beforeHash, foreignHash: foreignHash(), beforeProviderHash: checkpointDigest(beforeHistory),
        afterProviderHash: checkpointDigest([...beforeHistory, ...next.mixed.history]), observed });
      const execute = gateway.execute.bind(gateway); const commit = gateway.commit.bind(gateway);
      gateway.execute = async (sql, parameters = [], transactionId) => {
        const result = await execute(sql, parameters, transactionId); let point: string | undefined;
        if (/^insert into "agent_runtime_message"/i.test(sql)) { observed.messages++; completionTransaction = transactionId; point = 'message'; }
        if (/^insert into "agent_runtime_checkpoint"/i.test(sql)) { observed.checkpoint = true; point = 'checkpoint'; }
        if (/^update "agent_runtime_checkpoint"/i.test(sql)) {
          const id = parameters.find(value => typeof value === 'string' && value.startsWith(`agent-checkpoint:${session.id}:`)); assert.equal(typeof id, 'string');
          observed.compacted.push(Number(String(id).split(':').slice(-1)[0])); point = 'compaction';
        }
        if (/^update "agent_runtime_session"/i.test(sql) && parameters.includes('idle')) { observed.terminal = true; point = 'lifecycle'; }
        if (point) {
          assert(transactionId); assert.equal(transactionId, completionTransaction); observed.transactionIds.push(transactionId);
          if (boundary === point) hold(ready());
        }
        return result;
      };
      gateway.commit = async id => {
        if (id === completionTransaction && boundary === 'before-commit') hold(ready());
        await commit(id);
        if (id === completionTransaction) { observed.committed = true; if (boundary === 'committed') hold(ready()); }
      };
      await next.commit(); throw new Error(`Missing checkpoint crash boundary ${boundary}`);
    }
    const beforeHash = checkpointDatabaseHash(gateway);
    const snapshot = (await repository.loadRecoverySnapshot(session.id))!;
    const recovered = await recoverAgentRuntimeSnapshot(snapshot);
    const projection = await loadCanonicalAgentChatProjection(session.id, repository);
    const first = snapshot.turns[0];
    await fixture.persistence.commitTurn({ sessionId: session.id, turnId: first.id,
      turnMessages: snapshot.messages.filter(row => row.turnId === first.id).map(row => ({ role: row.role, content: row.content }) as AgentModelMessage),
      outcome: 'completed', errorCode: null, errorMessage: null, endedAt: first.endedAt! });
    assert.equal(checkpointDatabaseHash(gateway), beforeHash, 'Recovery and old-commit acknowledgement must not write');
    assert.equal(gateway.database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(gateway.database.prepare('PRAGMA foreign_key_check').all(), []);
    await emit({ mode, boundary, seed, recovered: true, databaseHash: beforeHash, foreignHash: foreignHash(),
      providerHash: checkpointDigest(recovered.providerHistory), displayHash: checkpointDigest(projection?.messages),
      fullOrdinals: snapshot.checkpoints.map(row => row.throughTurnOrdinal), lastTurnStatus: snapshot.turns[snapshot.turns.length - 1].status,
      checkpoints: Number(gateway.database.prepare('SELECT count(*) AS n FROM agent_runtime_checkpoint').get()!.n),
      checks: ['read-only-recovery-and-old-commit-retry', 'integrity', 'foreign-keys'] });
  } finally { await fixture.close(); }
}
