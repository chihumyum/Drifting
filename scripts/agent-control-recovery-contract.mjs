import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

export const controlWrites = {
  permission: ['permission_resolved', 'cancellation_requested', 'tool_result', 'session-interrupted'],
  user: ['cancellation_requested', 'tool_result', 'session-interrupted'],
};
export const controlCuts = Object.fromEntries(Object.entries(controlWrites).map(([kind, writes]) => [kind, [...writes, 'before-commit', 'committed']]));
export const controlCaseIds = Object.entries(controlCuts).flatMap(([kind, cuts]) => cuts.flatMap(cut => [1, 2].map(seed => `${kind}/${cut}/${seed}`))).sort();
export const controlWorkerFiles = ['scripts/agent-control-crash-worker.mjs', 'src/renderer/performance/agent-control-crash-worker.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
export const controlWorkerHash = root => hash(controlWorkerFiles.map(file => readFileSync(path.join(root, file), 'utf8')).join('\0'));
export const controlRecoveryFingerprint = root => hash(rendererSourceFingerprint(root) + [
  ...controlWorkerFiles.filter(file => file.startsWith('scripts/')), 'scripts/agent-control-recovery-contract.mjs', 'scripts/run-agent-control-recovery.mjs',
].map(file => readFileSync(path.join(root, file), 'utf8')).join('\0'));
const checkHash = value => assert.match(value, /^[a-f0-9]{64}$/);
const initialEvents = ['turn_started', 'model_iteration_started', 'context_planned', 'tool_call_started', 'tool_args_delta', 'tool_call_ready', 'model_usage', 'model_iteration_completed'];
const eventsFor = kind => [...initialEvents, ...(kind === 'permission' ? ['permission_requested'] : ['tool_execution_started', 'user_input_requested'])];
export const controlAcceptance = { processRecovery: 'passed', runtimeAndStore: 'production', sqlite: 'file-backed-product-schema-WAL-FULL',
  provider: 'scripted', permissionWriteExecution: 'not-started', userTool: 'synthetic-read-wait', native: 'not-run', powerLoss: 'not-run', performance: 'not-measured' };

function validateCommon(item) {
  const { kind, cut, seed, initialKill, cancelKill, restarts } = item;
  assert(controlCuts[kind].includes(cut)); assert([1, 2].includes(seed));
  for (const [mode, kill] of [['seed', initialKill], ['cancel', cancelKill]]) {
    assert.equal(kill.mode, mode); assert.equal(kill.kind, kind); assert.equal(kill.cut, cut); assert.equal(kill.seed, seed);
    assert.equal(kill.ready, true); assert.deepEqual(kill.exit, { code: null, signal: 'SIGKILL' });
  }
  checkHash(initialKill.databaseHash); checkHash(initialKill.foreignHash);
  assert.equal(initialKill.modelCalls, 1); assert.equal(initialKill.toolCalls, kind === 'permission' ? 0 : 1);
  assert.equal(initialKill.pending.status, kind === 'permission' ? 'waiting_permission' : 'waiting_user');
  assert.equal(initialKill.pending.requiresContinuation, false);
  const request = kind === 'permission' ? initialKill.pending.permissionRequest : initialKill.pending.userInputRequest;
  assert.equal(typeof request.requestId, 'string'); assert.equal(typeof request.callId, 'string');
  assert.equal(request.sessionId, initialKill.pending.sessionId); assert.equal(request.turnId, initialKill.pending.turnId);
  if (kind === 'permission') { assert.equal(request.argumentsHash.startsWith('sha256:'), true); assert.deepEqual(request.allowedScopes, ['once']); }
  assert.equal(cancelKill.beforeHash, initialKill.databaseHash);
  assert.deepEqual(cancelKill.beforePending, { ...initialKill.pending, requiresContinuation: true });
  assert.equal(cancelKill.modelCalls, 0); assert.equal(cancelKill.toolCalls, 0);
  const count = controlWrites[kind].indexOf(cut) + 1 || controlWrites[kind].length;
  assert.deepEqual(cancelKill.observed.writes, controlWrites[kind].slice(0, count));
  assert.equal(cancelKill.observed.transactionIds.length, count);
  assert(cancelKill.observed.transactionIds.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(restarts.length, 2);
  for (const restart of restarts) {
    assert.equal(restart.mode, 'recover'); assert.equal(restart.kind, kind); assert.equal(restart.cut, cut); assert.equal(restart.seed, seed);
    assert.equal(restart.recovered, true); assert.deepEqual(restart.exit, { code: 0, signal: null });
    assert.equal(restart.modelCalls, 0); assert.equal(restart.toolCalls, 0);
    assert.deepEqual(restart.checks, ['read-only-hydration', 'no-provider-or-tool-replay', 'foreign-project-isolation', 'integrity', 'foreign-keys']);
    checkHash(restart.databaseHash); checkHash(restart.transcriptHash); assert.equal(restart.foreignHash, initialKill.foreignHash);
  }
  assert.deepEqual(restarts[0], restarts[1], 'Repeated process recovery must leave the database and display unchanged.');
}

export function validateControlRecovery(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'agent_recovered_control_cancellation'); assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); checkHash(report.source.fingerprint); checkHash(report.workerSha256);
  assert.deepEqual(report.acceptance, controlAcceptance);
  assert.deepEqual(report.cases.map(item => `${item.kind}/${item.cut}/${item.seed}`).sort(), controlCaseIds);
  for (const item of report.cases) {
    validateCommon(item);
    const committed = item.cut === 'committed'; const { observed } = item.cancelKill;
    assert.equal(new Set(observed.transactionIds).size, 1, 'All cancellation rows must share one root transaction.');
    assert.deepEqual(observed.committedTransactionIds, committed ? [observed.transactionIds[0]] : []);
    for (const restart of item.restarts) {
      assert.deepEqual(restart.events, [...eventsFor(item.kind), ...(committed ? controlWrites[item.kind].slice(0, -1) : [])]);
      assert.equal(restart.sessionStatus, committed ? 'interrupted' : 'running');
      assert.equal(restart.turnStatus, committed ? 'interrupted' : 'running');
      assert.equal(restart.toolStatus, committed ? 'interrupted' : item.kind === 'permission' ? 'requested' : 'running');
      assert.deepEqual(restart.pending, committed ? null : item.cancelKill.beforePending);
      if (committed) assert.notEqual(restart.databaseHash, item.cancelKill.beforeHash);
      else assert.equal(restart.databaseHash, item.cancelKill.beforeHash, 'A pre-commit SIGKILL must leave no cancellation prefix.');
    }
  }
  assert.match(report.baseline.commit, /^[a-f0-9]{40}$/); assert.equal(report.baseline.workerSha256, report.workerSha256);
  assert.deepEqual(report.baseline.cases.map(item => `${item.kind}/${item.cut}/${item.seed}`), ['permission/cancellation_requested/1', 'user/tool_result/1']);
  for (const item of report.baseline.cases) {
    validateCommon(item);
    assert.equal(new Set(item.cancelKill.observed.transactionIds).size, 2);
    assert.deepEqual(item.cancelKill.observed.committedTransactionIds, [item.cancelKill.observed.transactionIds[0]]);
    for (const restart of item.restarts) {
      assert.notEqual(restart.databaseHash, item.cancelKill.beforeHash);
      assert.deepEqual(restart.events, [...eventsFor(item.kind), controlWrites[item.kind][0]]);
      assert.equal(restart.sessionStatus, 'running'); assert.equal(restart.turnStatus, 'running');
      assert.equal(restart.toolStatus, item.kind === 'permission' ? 'requested' : 'running');
      assert.equal(restart.pending, null, 'Baseline has durably lost the waiting control before interruption settles.');
    }
  }
}
