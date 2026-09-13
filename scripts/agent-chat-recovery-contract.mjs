import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const chatCrashCuts = { 'tool-arguments': 6, 'tool-executing': 14, 'tool-result-journal': 15,
  'tool-results': 17, 'assistant-tail': 21, 'terminal-journal': 25, 'commit-after-message': 25,
  'commit-after-checkpoint': 25, 'commit-before-commit': 25, 'commit-after-commit': 25,
  'consumer-before-cache': 25, 'cache-after-write': 25 };
const committedBoundaries = ['commit-after-commit', 'consumer-before-cache', 'cache-after-write'];
const checks = ['literal-display', 'committed-provider-history', 'checkpoint-atomicity', 'journal-and-tool-rows', 'cache-boundary',
  'foreign-project-isolation', 'replay-deduplication', 'disposed-consumer', 'read-only-recovery', 'integrity', 'foreign-keys'];
export const chatCrashCaseIds = Object.keys(chatCrashCuts).flatMap(boundary => [1, 2].map(seed => `${boundary}/${seed}`)).sort();

export function agentChatRecoveryFingerprint(root) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = [];
  const visit = (directory, pattern) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, pattern);
      else if (pattern.test(file)) files.push(path.relative(root, file));
    }
  };
  visit(path.join(root, 'src/renderer'), /\.(ts|tsx|css)$/);
  visit(path.join(root, 'drizzle'), /\.(sql|json)$/);
  for (const file of readdirSync(path.join(root, 'scripts'))) if (/^(run-)?agent-chat-(crash|recovery)/.test(file)) files.push(`scripts/${file}`);
  files.push('package.json', 'pnpm-lock.yaml');
  return hash(files.sort().map(file => `${file}\0${hash(readFileSync(path.join(root, file)))}`).join('\n'));
}

export function validateAgentChatRecovery(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'agent_chat_process_recovery'); assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/); assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.acceptance, { processRecovery: 'passed', nativeGateway: 'not-run', powerLoss: 'not-run', performance: 'not-measured' });
  assert.deepEqual(report.cases.map(item => `${item.boundary}/${item.seed}`).sort(), chatCrashCaseIds);
  for (const item of report.cases) {
    const through = chatCrashCuts[item.boundary]; const committed = committedBoundaries.includes(item.boundary);
    assert.equal(item.kill.ready, true);
    assert.equal(item.kill.boundary, item.boundary); assert.equal(item.kill.seed, item.seed); assert.equal(item.kill.through, through);
    assert.deepEqual(item.kill.exit, { code: null, signal: 'SIGKILL' });
    const afterMessage = item.boundary === 'commit-after-message';
    const afterCheckpoint = item.boundary === 'commit-after-checkpoint';
    const beforeCommit = item.boundary === 'commit-before-commit';
    assert.deepEqual(item.kill.observed, {
      completionRows: afterMessage ? 1 : afterCheckpoint || beforeCommit || committed ? 3 : 0,
      checkpointWritten: afterCheckpoint || beforeCommit || committed,
      terminalWritten: beforeCommit || committed,
      transactionCommitted: committed,
    }, 'Crash marker must witness the actual completion transaction, not a read transaction.');
    assert.equal(item.restarts.length, 2);
    for (const restart of item.restarts) {
      assert.equal(restart.recovered, true); assert.equal(restart.boundary, item.boundary); assert.equal(restart.seed, item.seed);
      assert.equal(restart.through, through); assert.equal(restart.committed, committed);
      assert.deepEqual(restart.exit, { code: 0, signal: null }); assert.deepEqual(restart.checks, checks);
      assert.equal(restart.messageCount, through === 6 ? 8 : through < 21 ? 9 : through < 25 ? 11 : committed ? 11 : 12);
      for (const field of ['databaseHash', 'displayHash', 'providerHash']) assert.match(restart[field], /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(item.restarts[0], item.restarts[1], 'Independent restarts must preserve the same database and projection.');
  }
}
