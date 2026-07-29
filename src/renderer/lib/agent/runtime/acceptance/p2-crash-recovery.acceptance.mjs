import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  P2_CRASH_MARKERS,
  P2_CRASH_RECOVERY_SCHEMA_VERSION,
} from './p2-crash-recovery-contract.mjs';

const WORKER_PATH = fileURLToPath(
  new URL('./p2-crash-recovery-worker.mjs', import.meta.url),
);

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    seeds: 20,
    performanceSamples: 20,
    keepTemp: false,
    output: null,
  };
  for (const argument of argv) {
    if (argument === '--keep-temp') {
      options.keepTemp = true;
    } else if (argument.startsWith('--seeds=')) {
      options.seeds = parsePositiveInteger(argument.slice('--seeds='.length), 'seeds');
    } else if (argument.startsWith('--performance-samples=')) {
      options.performanceSamples = parsePositiveInteger(
        argument.slice('--performance-samples='.length),
        'performance-samples',
      );
    } else if (argument.startsWith('--output=')) {
      options.output = path.resolve(argument.slice('--output='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index];
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

function runWorker(arguments_, { waitForReady = false } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      ['--no-warnings', WORKER_PATH, ...arguments_],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!waitForReady || settled || !stdout.includes('\n')) return;
      const [line] = stdout.split('\n');
      let ready;
      try {
        ready = JSON.parse(line);
      } catch (error) {
        fail(new Error(`Writer emitted invalid readiness JSON: ${String(error)}`));
        return;
      }
      if (ready?.ready !== true) {
        fail(new Error(`Writer did not report readiness: ${line}`));
        return;
      }
      settled = true;
      resolve({
        child,
        ready,
        completion: new Promise((resolveCompletion, rejectCompletion) => {
          child.once('error', rejectCompletion);
          child.once('close', (code, signal) => {
            resolveCompletion({
              code,
              signal,
              stderr,
              durationMs: performance.now() - startedAt,
            });
          });
        }),
      });
    });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (waitForReady) {
        if (!settled) {
          fail(
            new Error(
              `Writer exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
            ),
          );
        }
        return;
      }
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `Worker failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
          ),
        );
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines.at(-1);
      if (!lastLine) {
        reject(new Error('Worker produced no JSON output.'));
        return;
      }
      try {
        resolve({
          value: JSON.parse(lastLine),
          durationMs: performance.now() - startedAt,
        });
      } catch (error) {
        reject(new Error(`Worker emitted invalid JSON: ${String(error)}\n${stdout}`));
      }
    });
  });
}

async function writeDatabase(databasePath, marker, seed, stopMode) {
  const writer = await runWorker(
    ['write', databasePath, marker, String(seed), stopMode],
    { waitForReady: true },
  );
  if (stopMode === 'kill') {
    const killed = writer.child.kill('SIGKILL');
    if (!killed) throw new Error(`Failed to deliver SIGKILL to writer ${writer.child.pid}.`);
    const completion = await writer.completion;
    if (completion.code !== null || completion.signal !== 'SIGKILL') {
      throw new Error(
        `Writer was not killed by SIGKILL (code=${String(completion.code)}, signal=${String(completion.signal)}).`,
      );
    }
    return { realSigkill: 1 };
  }
  const completion = await writer.completion;
  if (completion.code !== 0 || completion.signal !== null) {
    throw new Error(
      `Reference writer did not close cleanly (code=${String(completion.code)}, signal=${String(completion.signal)}).`,
    );
  }
  return { realSigkill: 0 };
}

async function recoverDatabase(databasePath, marker) {
  return runWorker(['recover', databasePath, marker]);
}

function addViolations(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += Number(source[key] ?? 0);
  }
}

async function runCrashMatrix(directory, seedCount) {
  const violations = {
    promptLoss: 0,
    duplicateTool: 0,
    orphanTool: 0,
    doubleTerminal: 0,
    seqGap: 0,
    corruptSession: 0,
    partialAssistantInCompleteHistory: 0,
    foreignKeyViolations: 0,
    integrityFailures: 0,
  };
  const failures = [];
  let realSigkillCount = 0;
  let canonicalHashMismatch = 0;
  let cases = 0;

  for (let markerIndex = 0; markerIndex < P2_CRASH_MARKERS.length; markerIndex += 1) {
    const marker = P2_CRASH_MARKERS[markerIndex];
    for (let seed = 1; seed <= seedCount; seed += 1) {
      cases += 1;
      const caseName = `${String(markerIndex + 1).padStart(2, '0')}-${String(seed).padStart(3, '0')}`;
      const crashPath = path.join(directory, `${caseName}-crash.sqlite`);
      const referencePath = path.join(directory, `${caseName}-reference.sqlite`);
      try {
        const kill = await writeDatabase(crashPath, marker, seed, 'kill');
        realSigkillCount += kill.realSigkill;
        await writeDatabase(referencePath, marker, seed, 'graceful');
        const [crashRecovery, referenceRecovery] = await Promise.all([
          recoverDatabase(crashPath, marker),
          recoverDatabase(referencePath, marker),
        ]);
        addViolations(violations, crashRecovery.value.violations);
        if (crashRecovery.value.canonicalHash !== referenceRecovery.value.canonicalHash) {
          canonicalHashMismatch += 1;
          failures.push({
            case: caseName,
            marker,
            seed,
            reason: 'canonical_hash_mismatch',
            crashHash: crashRecovery.value.canonicalHash,
            referenceHash: referenceRecovery.value.canonicalHash,
          });
        }
        const referenceViolationTotal = Object.values(
          referenceRecovery.value.violations,
        ).reduce((sum, value) => sum + Number(value), 0);
        if (referenceViolationTotal !== 0) {
          failures.push({
            case: caseName,
            marker,
            seed,
            reason: 'reference_recovery_violation',
            violations: referenceRecovery.value.violations,
          });
        }
      } catch (error) {
        failures.push({
          case: caseName,
          marker,
          seed,
          reason: 'process_failure',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    cases,
    realSigkillCount,
    canonicalHashMismatch,
    violations,
    failures,
  };
}

async function runTenThousandRecovery(directory, sampleCount) {
  const databasePath = path.join(directory, 'recovery-10k.sqlite');
  const seeded = await runWorker(['seed-10k', databasePath]);
  if (seeded.value.eventCount !== 10_000) {
    throw new Error(`10k fixture contains ${String(seeded.value.eventCount)} events.`);
  }
  const workerDurations = [];
  const endToEndDurations = [];
  const hashes = new Set();
  let violations = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const recovery = await recoverDatabase(databasePath, 'bulk_10k');
    workerDurations.push(recovery.value.recoveryDurationMs);
    endToEndDurations.push(recovery.durationMs);
    hashes.add(recovery.value.canonicalHash);
    violations += Object.values(recovery.value.violations).reduce(
      (sum, value) => sum + Number(value),
      0,
    );
  }
  return {
    eventCount: 10_000,
    samples: sampleCount,
    stableCanonicalHash: hashes.size === 1,
    violations,
    workerMs: {
      median: roundMilliseconds(percentile(workerDurations, 0.5)),
      p95: roundMilliseconds(percentile(workerDurations, 0.95)),
      max: roundMilliseconds(Math.max(...workerDurations)),
    },
    endToEndMs: {
      median: roundMilliseconds(percentile(endToEndDurations, 0.5)),
      p95: roundMilliseconds(percentile(endToEndDurations, 0.95)),
      max: roundMilliseconds(Math.max(...endToEndDurations)),
    },
  };
}

export async function runP2CrashRecoveryAcceptance(options = parseOptions([])) {
  if (process.platform === 'win32') {
    throw new Error('The P2 crash suite requires POSIX SIGKILL semantics.');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-p2-crash-'));
  try {
    const crashMatrix = await runCrashMatrix(directory, options.seeds);
    const tenThousandRecovery = await runTenThousandRecovery(
      directory,
      options.performanceSamples,
    );
    const violationTotal = Object.values(crashMatrix.violations).reduce(
      (sum, value) => sum + value,
      0,
    );
    const expectedCases = P2_CRASH_MARKERS.length * options.seeds;
    const passed =
      crashMatrix.cases === expectedCases &&
      crashMatrix.realSigkillCount === expectedCases &&
      crashMatrix.canonicalHashMismatch === 0 &&
      crashMatrix.failures.length === 0 &&
      violationTotal === 0 &&
      tenThousandRecovery.stableCanonicalHash &&
      tenThousandRecovery.violations === 0 &&
      tenThousandRecovery.workerMs.p95 < 2_000 &&
      tenThousandRecovery.endToEndMs.p95 < 2_000;
    const summary = {
      suite: 'p2-crash-recovery',
      schemaVersion: P2_CRASH_RECOVERY_SCHEMA_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      sqliteAdapter: 'node:sqlite DatabaseSync',
      matrix: {
        markers: P2_CRASH_MARKERS,
        seedsPerMarker: options.seeds,
        expectedCases,
        cases: crashMatrix.cases,
        realSigkillCount: crashMatrix.realSigkillCount,
      },
      canonicalHashMismatch: crashMatrix.canonicalHashMismatch,
      hardViolations: crashMatrix.violations,
      processFailures: crashMatrix.failures,
      tenThousandRecovery,
      passed,
      tempDirectory: options.keepTemp ? directory : null,
    };
    if (options.output) {
      await writeFile(options.output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    }
    return summary;
  } finally {
    if (!options.keepTemp) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  runP2CrashRecoveryAcceptance(options)
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
