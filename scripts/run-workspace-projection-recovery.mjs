import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceEvidenceFingerprint } from './workspace-projection-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const worker = fileURLToPath(new URL('./workspace-projection-crash-worker.mjs', import.meta.url));
const boundaries = ['authored-before-commit', 'authored-after-commit', 'queue-waiting', 'capture-before-publish', 'published'];
const libraryOnly = process.argv.includes('--library');
const scenarios = libraryOnly ? ['library-change'] : ['node-metadata', 'collection-change'];
const checks = ['fixture-oracle', 'uncached-full-capture', 'persistent-state-unchanged', 'project-isolation', 'integrity', 'foreign-keys'];
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? (libraryOnly ? 'docs/renderer-performance/acceptance/f6-library-recovery.json' : 'docs/renderer-performance/acceptance/f6-workspace-recovery.json');
const seeds = 2;
const smoke = process.argv.includes('--smoke');
const boundariesFor = () => boundaries;
const expectedCases = scenarios.flatMap((scenario) => boundariesFor(scenario).flatMap((boundary) => Array.from({ length: seeds }, (_, i) => `${scenario}/${boundary}/${i + 1}`))).sort();
process.chdir(root);
const children = new Set();
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  for (const child of children) child.kill('SIGKILL');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

function start(args, crash) {
  assert.equal(interrupted, false, 'Workspace recovery run interrupted.');
  const child = fork(worker, args, { cwd: root, execArgv: ['--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  let stderr = '';
  let message;
  let timeoutExpired = false;
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12_000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timeoutExpired = true; child.kill('SIGKILL'); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('message', (value) => {
      if (message) { child.kill('SIGKILL'); return; }
      message = value;
      if (crash) child.kill('SIGKILL');
    });
    child.once('close', (code, signal) => {
      children.delete(child);
      clearTimeout(timer);
      try {
        assert.equal(interrupted, false, 'Workspace recovery run interrupted.');
        assert.equal(timeoutExpired, false, `Worker timeout: ${args[0]} ${args[2]} ${stderr}`);
        assert(message, `Worker exited without evidence (${code}/${signal}): ${stderr}`);
        assert.equal(message.boundary, args[2]);
        assert.equal(message.scenario, args[3]);
        assert.equal(message.seed, Number(args[4]));
        if (crash) {
          assert.equal(message.ready, true);
          assert.equal(code, null);
          assert.equal(signal, 'SIGKILL');
        } else {
          assert.equal(code, 0, stderr);
          assert.equal(signal, null);
          assert.equal(message.recovered, true);
          assert.deepEqual(message.checks, checks);
        }
        resolve({ ...message, exit: { code, signal } });
      } catch (error) { reject(error); }
    });
  });
}

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'workspace_projection_process_recovery');
  assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(report.acceptance.processRecovery, 'passed');
  assert.equal(report.acceptance.nativeGateway, 'not-run');
  assert.equal(report.acceptance.powerLoss, 'not-run');
  assert.equal(report.cases.length, expectedCases.length);
  assert.deepEqual(report.cases.map((entry) => `${entry.scenario}/${entry.boundary}/${entry.seed}`).sort(), expectedCases);
  for (const entry of report.cases) {
    assert.equal(entry.kill.exit.code, null);
    assert.equal(entry.kill.exit.signal, 'SIGKILL');
    assert.equal(entry.kill.ready, true);
    if (['capture-before-publish', 'published'].includes(entry.boundary)) {
      assert.equal(entry.kill.captureMode, 'changes');
      assert.equal(entry.kill.nodeRead, entry.scenario === 'node-metadata' ? 'changed' : 'reuse');
      assert.equal(entry.kill.elementRead, entry.scenario === 'collection-change' ? 'changed' : 'reuse');
      if (libraryOnly) assert.equal(entry.kill.libraryRead, 'changed');
    }
    assert.equal(entry.restarts.length, 2);
    for (const restart of entry.restarts) {
      assert.equal(restart.recovered, true);
      assert.equal(restart.captureMode, 'full');
      assert.deepEqual(restart.exit, { code: 0, signal: null });
      assert.deepEqual(restart.checks, checks);
      assert.equal(restart.databaseHash, entry.boundary === 'authored-before-commit' ? entry.kill.baselineHash : entry.kill.databaseHash);
    }
    assert.equal(entry.restarts[0].projectionHash, entry.restarts[1].projectionHash);
  }
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(await readFile(output, 'utf8'));
  validate(report);
  if (!process.argv.includes('--historical')) assert.equal(report.source.fingerprint, workspaceEvidenceFingerprint(root), 'Workspace recovery evidence is stale; regenerate it.');
  console.log(`Workspace recovery contract: ${expectedCases.length} SIGKILL cases and ${expectedCases.length * 2} restarts. ${process.argv.includes('--historical') ? 'Historical evidence; current source was not asserted.' : 'Source fingerprint matches.'} Native renderer recovery and power-loss acceptance remain pending.`);
} else {
  assert.notEqual(process.platform, 'win32', 'This acceptance requires POSIX SIGKILL.');
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-workspace-recovery-'));
  const fingerprint = workspaceEvidenceFingerprint(root);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const cases = [];
  try {
    for (const scenario of smoke ? scenarios.slice(0, 1) : scenarios) for (const boundary of boundariesFor(scenario)) for (let seed = 1; seed <= (smoke ? 1 : seeds); seed += 1) {
      const database = path.join(directory, `${scenario}-${boundary}-${seed}.db`);
      const args = [database, boundary, scenario, String(seed)];
      const kill = await start(['write', ...args], true);
      const first = await start(['recover', ...args, '1'], false);
      const second = await start(['recover', ...args, '2'], false);
      cases.push({ scenario, boundary, seed, kill, restarts: [first, second] });
      console.log(`Recovered ${cases.length}/${smoke ? 5 : expectedCases.length}: ${scenario} / ${boundary} / ${seed}`);
    }
    assert.equal(fingerprint, workspaceEvidenceFingerprint(root), 'Source changed during recovery acceptance.');
    if (smoke) {
      console.log('Workspace smoke checks passed; no complete acceptance report was written.');
      process.exitCode = 0;
    } else {
      const report = {
        schemaVersion: 1, kind: 'workspace_projection_process_recovery', status: 'passed', generatedAt: new Date().toISOString(),
        source: { commit: sourceCommit, fingerprint, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) },
        environment: { platform: process.platform, node: process.version, sqlite: process.versions.sqlite },
        fixture: { provenance: 'synthetic content only', sources: libraryOnly ? 'library metadata and prose-bearing library row; isolated second project' : 'node metadata and prose-bearing element collection; isolated second project', database: 'file-backed WAL/FULL, complete product migrations, renderer gateway adapter over Node SQLite', identity: 'synthetic installation identity and clock injected into the actual authored transaction runner; production journal and reducer validation unchanged' },
        cases,
        acceptance: { processRecovery: 'passed', nativeGateway: 'not-run', powerLoss: 'not-run', performance: 'not-measured' },
        limitations: [
          'The warm actual refresh queue is interrupted after an authored transaction, while waiting, after a covered capture and after publication. Every cold restart captures the complete workspace and does not reuse an in-memory cursor.',
          'Node SQLite uses the product renderer gateway adapter. Native migration recovery is tested separately; this does not exercise a Tauri renderer restart or physical device.',
          'SIGKILL does not simulate OS crash, disk failure or power loss. No latency or device acceptance is claimed.',
          'All persistent rows, including author journal, projection cursors and the other project, must remain byte-for-byte unchanged by recovery. The projection is compared with an independent full capture and a fixture field oracle.',
        ],
      };
      validate(report);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ output, cases: cases.length, source: report.source }));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
