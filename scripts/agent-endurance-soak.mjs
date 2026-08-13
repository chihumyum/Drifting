import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/long-task-auto-continuation.test.ts',
  'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  'src/renderer/lib/agent/runtime/mcp-http.integration.test.ts',
  'src/renderer/sqlite-repo/agent-extension-repo.integration.test.ts',
];

const options = parse(process.argv.slice(2));
const profile = options.profile === '12h' ? { hours: 12, epochs: 48 } : { hours: 4, epochs: 16 };
const targetEpochs = options.epochs ?? profile.epochs;
const output = path.resolve(
  core,
  options.output ?? `docs/agent-runtime/acceptance/milestone-j-${options.profile}-soak.json`,
);
const checkpoint = `${output}.checkpoint`;
const sourceHash = await hashFiles([...tests, 'scripts/agent-endurance-soak.mjs']);
let state = await loadCheckpoint(checkpoint, sourceHash, options.profile);

for (let epoch = state.completedEpochs; epoch < targetEpochs; epoch += 1) {
  const started = Date.now();
  const execution = await run('/usr/bin/time', [
    '-l',
    'pnpm',
    'exec',
    'vitest',
    'run',
    ...tests,
    '--pool=forks',
    '--maxWorkers=1',
    '--reporter=dot',
  ]);
  const residentBytes = parseMaximumResidentBytes(execution.stderr);
  const row = {
    epoch: epoch + 1,
    logicalMinute: (epoch + 1) * 15,
    durationMs: Date.now() - started,
    maximumResidentBytes: residentBytes,
    exitCode: execution.code,
    passed: execution.code === 0 && execution.signal === null,
  };
  state.epochs.push(row);
  state.completedEpochs = epoch + 1;
  state.updatedAt = new Date().toISOString();
  await atomicJson(checkpoint, state);
  process.stdout.write(
    `epoch ${row.epoch}/${targetEpochs} logical=${row.logicalMinute}m rss=${residentBytes ?? 'unknown'} passed=${row.passed}\n`,
  );
  if (!row.passed) {
    process.stderr.write(redact(execution.stderr || execution.stdout));
    process.exitCode = 1;
    break;
  }
  if (options.wallClock && epoch + 1 < targetEpochs) {
    const remaining = Math.max(0, 15 * 60_000 - row.durationMs);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

const completed = state.completedEpochs === targetEpochs && state.epochs.every((row) => row.passed);
const summary = {
  suite: 'milestone-j-synthetic-workload-endurance',
  schemaVersion: 1,
  profile: options.profile,
  mode: options.wallClock
    ? 'wall-clock-15-minute-cadence'
    : 'accelerated-15-minute-workload-equivalent',
  sourceSetSha256: sourceHash,
  targetLogicalHours: profile.hours,
  targetEpochs,
  completedEpochs: state.completedEpochs,
  logicalMinutesCompleted: state.completedEpochs * 15,
  wallClockMs: state.epochs.reduce((sum, row) => sum + row.durationMs, 0),
  maximumResidentBytes: Math.max(0, ...state.epochs.map((row) => row.maximumResidentBytes ?? 0)),
  testsPerEpoch: tests,
  faultCoverage: [
    'renderer-process-restart-and-checkpoint-recovery',
    'lost-commit-acknowledgement-and-corrupt-checkpoint',
    'automatic-continuation-stop-steer-stagnation',
    'mcp-http-session-timeout-and-cancellation',
    'durable-grant-reopen-config-drift-and-concurrency',
    'synthetic-long-manuscript-voice-and-citation-oracle',
  ],
  privateProsePersisted: false,
  networkRequired: false,
  passed: completed,
  epochs: state.epochs,
};
await atomicJson(output, summary);
if (completed) await atomicJson(checkpoint, { ...state, completed: true });
process.stdout.write(
  `${JSON.stringify({ output: path.relative(core, output), passed: completed, completedEpochs: state.completedEpochs })}\n`,
);
if (!completed) process.exitCode = 1;

function parse(argv) {
  const result = { profile: '4h', epochs: null, output: null, wallClock: false };
  for (const arg of argv) {
    if (arg === '--wall-clock') result.wallClock = true;
    else if (arg.startsWith('--profile=')) result.profile = arg.slice(10);
    else if (arg.startsWith('--epochs=')) result.epochs = Number.parseInt(arg.slice(9), 10);
    else if (arg.startsWith('--output=')) result.output = arg.slice(9);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['4h', '12h'].includes(result.profile)) throw new Error('profile must be 4h or 12h');
  if (result.epochs != null && (!Number.isSafeInteger(result.epochs) || result.epochs < 1)) {
    throw new Error('epochs must be a positive integer');
  }
  return result;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: core,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function hashFiles(files) {
  const hash = createHash('sha256');
  for (const file of files.sort())
    hash
      .update(file)
      .update('\0')
      .update(await readFile(path.join(core, file)))
      .update('\0');
  return `sha256:${hash.digest('hex')}`;
}

async function loadCheckpoint(file, hash, profileName) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.sourceSetSha256 === hash && value.profile === profileName) return value;
  } catch {
    // Start a new resumable run.
  }
  return {
    profile: profileName,
    sourceSetSha256: hash,
    completedEpochs: 0,
    epochs: [],
    updatedAt: new Date().toISOString(),
  };
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function parseMaximumResidentBytes(stderr) {
  const match = stderr.match(/(\d+)\s+maximum resident set size/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

function redact(value) {
  return value.replace(/\bsk-[A-Za-z0-9_-]+/gu, '[REDACTED]').slice(-20_000);
}
