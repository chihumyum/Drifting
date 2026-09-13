import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlAcceptance, controlCuts, controlRecoveryFingerprint, controlWorkerFiles, controlWorkerHash, validateControlRecovery } from './agent-control-recovery-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(root, process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f4-control-recovery.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const children = new Set(); let interrupted = false;
const interrupt = () => { interrupted = true; for (const child of children) child.kill('SIGKILL'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
function start(directory, args, crash) {
  assert.equal(interrupted, false, 'Control recovery run interrupted.');
  const child = fork(path.join(directory, controlWorkerFiles[0]), args, { cwd: directory, execArgv: ['--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child); child.stdout.resume();
  let stderr = ''; let message; let timedOut = false; let duplicate = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
    child.once('error', error => { children.delete(child); clearTimeout(timer); reject(error); });
    child.on('message', value => { if (message) { duplicate = true; child.kill('SIGKILL'); return; } message = value; if (crash) child.kill('SIGKILL'); });
    child.once('close', (code, signal) => {
      children.delete(child); clearTimeout(timer);
      try {
        assert.equal(interrupted, false); assert.equal(timedOut, false, stderr); assert.equal(duplicate, false);
        assert(message, `No worker evidence ${args[0]}/${args[2]}/${args[3]} (${code}/${signal}): ${stderr}`);
        assert.equal(message.mode, args[0]); assert.equal(message.kind, args[2]); assert.equal(message.cut, args[3]); assert.equal(message.seed, Number(args[4]));
        if (crash) { assert.equal(message.ready, true); assert.equal(code, null); assert.equal(signal, 'SIGKILL'); }
        else { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(message.recovered, true); }
        resolve({ ...message, exit: { code, signal } });
      } catch (error) { reject(error); }
    });
  });
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(await readFile(output, 'utf8')); validateControlRecovery(report);
  assert.equal(report.source.fingerprint, controlRecoveryFingerprint(root), 'Control recovery evidence is stale.');
  assert.equal(report.workerSha256, controlWorkerHash(root));
  console.log('Recovered controls: 22 current cases, 44 SIGKILL boundaries, 44 independent restarts match source.');
} else {
  assert.notEqual(process.platform, 'win32', 'This acceptance requires POSIX SIGKILL.');
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-control-recovery-')); const baselineRoot = path.join(directory, 'baseline'); let added = false;
  const fingerprint = controlRecoveryFingerprint(root); const commit = git('rev-parse', 'HEAD'); const workerSha256 = controlWorkerHash(root);
  const baselineRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11)
    ?? (existsSync(output) ? JSON.parse(await readFile(output, 'utf8')).baseline.commit : commit);
  const baselineCommit = git('rev-parse', baselineRef);
  async function runCase(checkout, group, kind, cut, seed) {
    const database = path.join(directory, `${group}-${kind}-${cut}-${seed}.db`); const args = [database, kind, cut, String(seed)];
    const initialKill = await start(checkout, ['seed', ...args], true);
    const cancelKill = await start(checkout, ['cancel', ...args], true);
    const first = await start(checkout, ['recover', ...args], false); const second = await start(checkout, ['recover', ...args], false);
    console.log(`${group}: ${kind}/${cut}/${seed}`);
    return { kind, cut, seed, initialKill, cancelKill, restarts: [first, second] };
  }
  try {
    git('worktree', 'add', '--detach', baselineRoot, baselineCommit); added = true;
    for (const file of controlWorkerFiles) await cp(path.join(root, file), path.join(baselineRoot, file));
    await symlink(path.join(root, 'node_modules'), path.join(baselineRoot, 'node_modules'), 'dir');
    assert.equal(controlWorkerHash(baselineRoot), workerSha256);
    const baselineCases = [];
    for (const [kind, cut] of [['permission', 'cancellation_requested'], ['user', 'tool_result']]) baselineCases.push(await runCase(baselineRoot, 'baseline', kind, cut, 1));
    const cases = [];
    for (const [kind, cuts] of Object.entries(controlCuts)) for (const cut of cuts) for (const seed of [1, 2]) cases.push(await runCase(root, 'current', kind, cut, seed));
    assert.equal(controlRecoveryFingerprint(root), fingerprint, 'Source changed during control recovery acceptance.');
    const report = { schemaVersion: 1, kind: 'agent_recovered_control_cancellation', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint }, workerSha256, environment: { platform: process.platform, node: process.version, sqlite: process.versions.sqlite },
      fixture: { provenance: 'synthetic-only', composition: 'real LocalGeneralAgentTransport, runtime, journal relay, Zustand chat store, SQLite repositories and strict recovery',
        waits: 'scripted model requests an unapproved write or a synthetic read tool waiting for user input; neither produces side effects' },
      cases, baseline: { commit: baselineCommit, workerSha256, cases: baselineCases }, acceptance: controlAcceptance,
      limitations: ['SIGKILL ends an owned Node process; native Rust gateway, OS crash, disk failure and power loss are not tested.',
        'Existing write-effect interruption precedes the atomic control settlement. No new tool execution is approved or resumed, and previously started real writes remain a separate recovery scope.',
        'React/native controls, provider network traffic, checkpoint compaction, long mixed traces and device performance budgets are not evaluated.'] };
    validateControlRecovery(report); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Passed: 22 current cases / 44 kills / 44 restarts; identical baseline probes reproduce 2 partial cancellations. ${output}`);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (added) git('worktree', 'remove', '--force', baselineRoot);
    await rm(directory, { recursive: true, force: true });
  }
}
