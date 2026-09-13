import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentChatRecoveryFingerprint, chatCrashCuts, validateAgentChatRecovery } from './agent-chat-recovery-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const worker = fileURLToPath(new URL('./agent-chat-crash-worker.mjs', import.meta.url));
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f4-chat-crash-recovery.json';
const smoke = process.argv.includes('--smoke');
const children = new Set(); let interrupted = false;
const interrupt = () => { interrupted = true; for (const child of children) child.kill('SIGKILL'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
process.chdir(root);

function start(args, crash) {
  assert.equal(interrupted, false, 'Chat recovery run interrupted.');
  const child = fork(worker, args, { cwd: root, execArgv: ['--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  let stderr = ''; let message; let timeoutExpired = false; let duplicateMessage = false;
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timeoutExpired = true; child.kill('SIGKILL'); }, 30_000);
    child.once('error', error => { children.delete(child); clearTimeout(timer); reject(error); });
    child.on('message', value => {
      if (message) { duplicateMessage = true; child.kill('SIGKILL'); return; }
      message = value; if (crash) child.kill('SIGKILL');
    });
    child.once('close', (code, signal) => {
      children.delete(child); clearTimeout(timer);
      try {
        assert.equal(interrupted, false, 'Chat recovery run interrupted.');
        assert.equal(timeoutExpired, false, `Worker timeout ${args[0]}/${args[2]}: ${stderr}`);
        assert.equal(duplicateMessage, false, 'Worker emitted duplicate evidence.');
        assert(message, `Worker exited without evidence (${code}/${signal}): ${stderr}`);
        assert.equal(message.boundary, args[2]); assert.equal(message.seed, Number(args[3]));
        assert.equal(message.through, chatCrashCuts[args[2]]);
        if (crash) { assert.equal(message.ready, true); assert.equal(code, null); assert.equal(signal, 'SIGKILL'); }
        else { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(message.recovered, true); }
        resolve({ ...message, exit: { code, signal } });
      } catch (error) { reject(error); }
    });
  });
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(await readFile(output, 'utf8')); validateAgentChatRecovery(report);
  assert.equal(report.source.fingerprint, agentChatRecoveryFingerprint(root), 'Chat recovery evidence is stale; regenerate it.');
  console.log('Agent chat recovery: 24 real SIGKILL cases and 48 independent restarts match source.');
} else {
  assert.notEqual(process.platform, 'win32', 'This acceptance requires POSIX SIGKILL.');
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-chat-recovery-'));
  const fingerprint = agentChatRecoveryFingerprint(root);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const cases = [];
  try {
    for (const boundary of Object.keys(chatCrashCuts)) for (let seed = 1; seed <= (smoke ? 1 : 2); seed++) {
      const database = path.join(directory, `${boundary}-${seed}.db`); const args = [database, boundary, String(seed)];
      const kill = await start(['write', ...args], true);
      const first = await start(['recover', ...args], false); const second = await start(['recover', ...args], false);
      cases.push({ boundary, seed, kill, restarts: [first, second] });
      console.log(`Recovered ${cases.length}/${smoke ? 12 : 24}: ${boundary} / ${seed}`);
    }
    assert.equal(fingerprint, agentChatRecoveryFingerprint(root), 'Source changed during recovery acceptance.');
    if (smoke) console.log('Smoke checks passed; no complete acceptance report was written.');
    else {
      const report = { schemaVersion: 1, kind: 'agent_chat_process_recovery', status: 'passed', generatedAt: new Date().toISOString(),
        source: { commit: sourceCommit, fingerprint, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) },
        environment: { platform: process.platform, node: process.version, sqlite: process.versions.sqlite },
        fixture: { provenance: 'synthetic content only', database: 'file-backed WAL/FULL, complete product migrations, renderer gateway adapter over Node SQLite',
          trace: 'one prior committed turn and one two-iteration mixed turn: consolidated thinking, text, streamed tool arguments, one success and one failure, usage and terminal',
          composition: 'real journal consumer, persistence adapter, repositories and strict recovery; synchronous state/activity ports; no model, tool execution, React or native process' },
        cases, acceptance: { processRecovery: 'passed', nativeGateway: 'not-run', powerLoss: 'not-run', performance: 'not-measured' },
        limitations: ['SIGKILL terminates an owned Node process. It does not simulate OS crash, disk failure or power loss.',
          'This covers real SQLite and consumer/recovery composition, not the full Zustand store, transport relay, React display, native Rust gateway or device input.',
          'Recovery here is read-only. Resuming interrupted tools, write receipts, permissions, user controls, checkpoint compaction and large-history latency remain separate acceptance.'] };
      validateAgentChatRecovery(report); await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ output, cases: cases.length, source: report.source }));
    }
  } finally { for (const child of children) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
}
