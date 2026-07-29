import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  P3_CRASH_MARKERS,
  P3_CRASH_SCHEMA_VERSION,
} from './p3-crash-consistency-contract.mjs';

const WORKER_PATH = fileURLToPath(
  new URL('./p3-crash-consistency-worker.mjs', import.meta.url),
);

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    seeds: 20,
    output: null,
    keepTemp: false,
  };
  for (const argument of argv) {
    if (argument.startsWith('--seeds=')) {
      options.seeds = positiveInteger(
        argument.slice('--seeds='.length),
        'seeds',
      );
    } else if (argument.startsWith('--output=')) {
      options.output = path.resolve(argument.slice('--output='.length));
    } else if (argument === '--keep-temp') {
      options.keepTemp = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function startWorker(arguments_, waitForReady) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      ['--no-warnings', WORKER_PATH, ...arguments_],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!waitForReady || settled || !stdout.includes('\n')) return;
      const line = stdout.slice(0, stdout.indexOf('\n'));
      try {
        const ready = JSON.parse(line);
        if (ready?.ready !== true) {
          fail(new Error(`P3 writer did not report readiness: ${line}`));
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
      } catch (error) {
        fail(new Error(`P3 writer emitted invalid JSON: ${String(error)}`));
      }
    });

    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (waitForReady) {
        if (!settled) {
          fail(
            new Error(
              `P3 writer exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
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
            `P3 worker failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
          ),
        );
        return;
      }
      const lastLine = stdout.trim().split('\n').filter(Boolean).at(-1);
      if (!lastLine) {
        reject(new Error('P3 recovery worker produced no JSON output.'));
        return;
      }
      try {
        resolve({
          value: JSON.parse(lastLine),
          durationMs: performance.now() - startedAt,
        });
      } catch (error) {
        reject(
          new Error(`P3 recovery emitted invalid JSON: ${String(error)}`),
        );
      }
    });
  });
}

async function crashWriter(databasePath, marker, seed) {
  const writer = await startWorker(
    ['write', databasePath, marker, String(seed)],
    true,
  );
  if (!writer.child.kill('SIGKILL')) {
    throw new Error(`Failed to SIGKILL P3 writer ${writer.child.pid}.`);
  }
  const completion = await writer.completion;
  if (completion.code !== null || completion.signal !== 'SIGKILL') {
    throw new Error(
      `P3 writer did not stop by SIGKILL (code=${String(completion.code)}, signal=${String(completion.signal)}).`,
    );
  }
}

function recover(databasePath, marker, seed) {
  return startWorker(
    ['recover', databasePath, marker, String(seed)],
    false,
  );
}

function emptyViolations() {
  return {
    wrongRecoveryPhase: 0,
    blindRetry: 0,
    yjsDurabilityMismatch: 0,
    projectionMismatch: 0,
    outboxMismatch: 0,
    partialYjsUpdate: 0,
    foreignKeyViolations: 0,
    integrityFailures: 0,
    nonIdempotentRecovery: 0,
  };
}

function addViolations(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += Number(source[key] ?? 0);
  }
}

export async function runP3CrashConsistencyAcceptance(
  options = parseOptions([]),
) {
  if (process.platform === 'win32') {
    throw new Error('The P3 crash suite requires POSIX SIGKILL semantics.');
  }
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-p3-crash-'),
  );
  const failures = [];
  const violations = emptyViolations();
  const durations = [];
  let cases = 0;
  let realSigkillCount = 0;

  try {
    for (
      let markerIndex = 0;
      markerIndex < P3_CRASH_MARKERS.length;
      markerIndex += 1
    ) {
      const marker = P3_CRASH_MARKERS[markerIndex];
      for (let seed = 1; seed <= options.seeds; seed += 1) {
        cases += 1;
        const name = `${String(markerIndex + 1).padStart(2, '0')}-${String(seed).padStart(3, '0')}`;
        const databasePath = path.join(directory, `${name}.sqlite`);
        try {
          await crashWriter(databasePath, marker, seed);
          realSigkillCount += 1;
          const first = await recover(databasePath, marker, seed);
          const second = await recover(databasePath, marker, seed);
          durations.push(first.durationMs, second.durationMs);
          addViolations(violations, first.value.violations);
          addViolations(violations, second.value.violations);
          if (first.value.snapshotHash !== second.value.snapshotHash) {
            violations.nonIdempotentRecovery += 1;
            failures.push({
              marker,
              seed,
              reason: 'non_idempotent_recovery',
              firstHash: first.value.snapshotHash,
              secondHash: second.value.snapshotHash,
            });
          }
        } catch (error) {
          failures.push({
            marker,
            seed,
            reason: 'process_failure',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const expectedCases = P3_CRASH_MARKERS.length * options.seeds;
    const hardViolationTotal = Object.values(violations).reduce(
      (sum, value) => sum + Number(value),
      0,
    );
    const sortedDurations = [...durations].sort(
      (left, right) => left - right,
    );
    const p95Index = Math.max(
      0,
      Math.ceil(sortedDurations.length * 0.95) - 1,
    );
    const summary = {
      suite: 'p3-crash-consistency',
      schemaVersion: P3_CRASH_SCHEMA_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      sqliteAdapter: 'node:sqlite DatabaseSync, file-backed WAL/FULL',
      yjsAdapter: 'yjs',
      matrix: {
        markers: P3_CRASH_MARKERS,
        seedsPerMarker: options.seeds,
        expectedCases,
        cases,
        realSigkillCount,
        recoveries: durations.length,
      },
      recoveryEndToEndMs: {
        p95:
          sortedDurations.length === 0
            ? 0
            : Math.round(sortedDurations[p95Index] * 100) / 100,
        max:
          sortedDurations.length === 0
            ? 0
            : Math.round(Math.max(...sortedDurations) * 100) / 100,
      },
      hardViolations: violations,
      processFailures: failures,
      passed:
        cases === expectedCases &&
        realSigkillCount === expectedCases &&
        failures.length === 0 &&
        hardViolationTotal === 0,
      tempDirectory: options.keepTemp ? directory : null,
    };
    if (options.output) {
      await writeFile(
        options.output,
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    }
    return summary;
  } finally {
    if (!options.keepTemp) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runP3CrashConsistencyAcceptance(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
