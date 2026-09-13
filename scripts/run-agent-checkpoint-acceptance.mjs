import assert from 'node:assert/strict';
import { execFileSync, fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointAcceptance, checkpointBoundaries, checkpointFingerprint, checkpointSuites, checkpointTestFile, checkpointWorkerFiles, checkpointWorkerHash, validateCheckpointAcceptance } from './agent-checkpoint-contract.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/renderer-performance/acceptance/f4-checkpoint-retention.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const children = new Set(); let interrupted = false;
const interrupt = () => { interrupted = true; for (const child of children) child.kill('SIGKILL'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
async function command(cmd, args, cwd, env = process.env) {
  assert.equal(interrupted, false); const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout = (stdout + value).slice(-60000); }); child.stderr.on('data', value => { stderr = (stderr + value).slice(-12000); });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { children.delete(child); if (interrupted || signal) reject(new Error('Acceptance command interrupted')); else resolve({ code, stdout, stderr }); });
  });
}
function worker(directory, args, crash) {
  assert.equal(interrupted, false);
  const child = fork(path.join(directory, checkpointWorkerFiles[0]), args, { cwd: directory, execArgv: ['--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(child); child.stdout.resume();
  let stderr = ''; let message; let timedOut = false; let duplicate = false; child.stderr.on('data', value => { stderr = (stderr + value).slice(-12000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.on('message', value => { if (message) { duplicate = true; child.kill('SIGKILL'); return; } message = value; if (crash) child.kill('SIGKILL'); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); children.delete(child);
      try {
        assert.equal(interrupted, false); assert.equal(timedOut, false, stderr); assert.equal(duplicate, false); assert(message, `${args[0]}/${args[2]} exited without evidence: ${stderr}`);
        assert.equal(message.mode, args[0]); assert.equal(message.seed, Number(args[3]));
        if (crash) { assert.equal(message.ready, true); assert.equal(code, null); assert.equal(signal, 'SIGKILL'); }
        else { assert.equal(code, 0, stderr); assert.equal(signal, null); }
        resolve({ ...message, exit: { code, signal } });
      } catch (error) { reject(error); }
    });
  });
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(await readFile(output, 'utf8')); validateCheckpointAcceptance(report);
  assert.equal(report.source.fingerprint, checkpointFingerprint(root), 'Checkpoint evidence is stale.'); assert.equal(report.workerSha256, checkpointWorkerHash(root));
  assert.equal(report.testSha256, createHash('sha256').update(await readFile(path.join(root, checkpointTestFile))).digest('hex'));
  console.log('Checkpoint retention evidence matches renderer, native gateway and migration source.');
} else {
  assert.notEqual(process.platform, 'win32');
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-checkpoint-acceptance-')); const baselineRoot = path.join(directory, 'baseline'); let added = false;
  const fingerprint = checkpointFingerprint(root); const commit = git('rev-parse', 'HEAD'); const workerSha256 = checkpointWorkerHash(root);
  const baselineRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11) ?? (existsSync(output) ? JSON.parse(await readFile(output, 'utf8')).baseline.commit : commit);
  const baselineCommit = git('rev-parse', baselineRef);
  async function tests(checkout, suites, name, status) {
    const resultFile = path.join(directory, `${name}-tests.json`);
    const result = await command('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${resultFile}`], checkout);
    assert.equal(result.code, status, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(resultFile, 'utf8')); assert.equal(report.numPendingTests, 0);
    const cases = report.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration ?? 0 })));
    console.log(`${name}: ${cases.length} checks, ${cases.filter(test => test.status === 'failed').length} failures`); return cases;
  }
  async function measure(checkout, label) {
    const output = [];
    for (const count of [100, 1000, 5000]) {
      const result = await worker(checkout, ['measure', path.join(directory, `${label}-${count}.db`), String(count), '1'], false);
      output.push(result); console.log(`${label}: ${count} checkpoints, list rows ${result.lists[0].rows}, commit rows ${result.commitReads.map(row => row.rows).join('+')}`);
    }
    return output;
  }
  try {
    git('worktree', 'add', '--detach', baselineRoot, baselineCommit); added = true;
    for (const file of [...checkpointWorkerFiles, checkpointTestFile]) await cp(path.join(root, file), path.join(baselineRoot, file));
    await symlink(path.join(root, 'node_modules'), path.join(baselineRoot, 'node_modules'), 'dir'); assert.equal(checkpointWorkerHash(baselineRoot), workerSha256);
    const baselineTests = await tests(baselineRoot, [checkpointTestFile], 'baseline', 1);
    const baselineMeasurements = await measure(baselineRoot, 'baseline');
    const currentTests = await tests(root, checkpointSuites, 'current', 0);
    const measurements = await measure(root, 'current');
    const crashes = [];
    for (const boundary of checkpointBoundaries) for (const seed of [1, 2]) {
      const args = [path.join(directory, `${boundary}-${seed}.db`), boundary, String(seed)];
      const kill = await worker(root, ['write', ...args], true); const first = await worker(root, ['recover', ...args], false); const second = await worker(root, ['recover', ...args], false);
      crashes.push({ boundary, seed, kill, restarts: [first, second] }); console.log(`Recovered checkpoint ${boundary}/${seed}`);
    }
    const common = path.resolve(root, git('rev-parse', '--git-common-dir'));
    const nativeResult = await command('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'database::tests::', '--', '--test-threads=1'], root,
      { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(path.dirname(common), 'src-tauri/target') });
    assert.equal(nativeResult.code, 0, nativeResult.stdout + nativeResult.stderr);
    const nativeTests = [...nativeResult.stdout.matchAll(/^test (database::tests::\S+) \.\.\. ok$/gm)].map(match => match[1]);
    assert.match(nativeResult.stdout, /18 passed; 0 failed; 0 ignored/); console.log('Native database: 18 checks passed');
    assert.equal(checkpointFingerprint(root), fingerprint, 'Source changed during checkpoint acceptance.');
    const testSha256 = createHash('sha256').update(await readFile(path.join(root, checkpointTestFile))).digest('hex');
    const report = { schemaVersion: 1, kind: 'agent_checkpoint_retention', status: 'passed', generatedAt: new Date().toISOString(), source: { commit, fingerprint }, workerSha256, testSha256,
      environment: { platform: process.platform, node: process.version, sqlite: process.versions.sqlite }, suites: checkpointSuites, tests: currentTests,
      measurements, crashes, native: { tests: nativeTests, exitCode: nativeResult.code, failed: 0 },
      baseline: { commit: baselineCommit, workerSha256, testSha256, tests: baselineTests, measurements: baselineMeasurements }, acceptance: checkpointAcceptance,
      limitations: ['Measurement covers checkpoint rows crossing the renderer gateway and actual query plans. Complete journal/message recovery still loads full history; no overall latency or memory budget is claimed.',
        'Canonical seed rows and mixed tool journals are synthetic. No real provider or tool implementation runs.',
        'Checkpoint SIGKILL ends owned Node processes. Rust tests cover published-prefix safety snapshots and migration crash recovery, not native checkpoint commit termination or device/UI interaction.'] };
    validateCheckpointAcceptance(report); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Checkpoint acceptance passed: bounded anchor reads, exact retry, 12 kills / 24 restarts, native migration preservation.');
  } finally { for (const child of children) child.kill('SIGKILL'); if (added) git('worktree', 'remove', '--force', baselineRoot); await rm(directory, { recursive: true, force: true }); }
}
