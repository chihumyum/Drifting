import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { runP3CrashConsistencyAcceptance } from './p3-crash-consistency.acceptance.mjs';

const CORE_DIRECTORY = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const WRITE_TEST =
  'src/renderer/lib/agent/runtime/acceptance/p3-write-path.acceptance.test.ts';

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    crashSeeds: 20,
    output: null,
  };
  for (const argument of argv) {
    if (argument.startsWith('--crash-seeds=')) {
      options.crashSeeds = positiveInteger(
        argument.slice('--crash-seeds='.length),
        'crash-seeds',
      );
    } else if (argument.startsWith('--output=')) {
      options.output = path.resolve(argument.slice('--output='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function runVitest(outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        WRITE_TEST,
        '--reporter=json',
        `--outputFile=${outputPath}`,
      ],
      {
        cwd: CORE_DIRECTORY,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `P3 write-path Vitest failed (code=${String(code)}, signal=${String(signal)}):\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function runP3Acceptance(options = parseOptions([])) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-p3-acceptance-'),
  );
  try {
    const vitestOutput = path.join(directory, 'write-path-vitest.json');
    await runVitest(vitestOutput);
    const vitest = JSON.parse(await readFile(vitestOutput, 'utf8'));
    const crash = await runP3CrashConsistencyAcceptance({
      seeds: options.crashSeeds,
      output: null,
      keepTemp: false,
    });
    const writePassed =
      vitest.success === true &&
      vitest.numFailedTests === 0 &&
      vitest.numPassedTests === vitest.numTotalTests;
    const summary = {
      suite: 'p3-agent-write-runtime',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      writePath: {
        adapter: 'product repositories over file-backed node:sqlite WAL/FULL',
        scheduler: 'ReaderWriterAgentRuntimeScheduler',
        runtime: 'DriftingWriteToolRuntime',
        dispatch: 'runAgentTool',
        mutationBoundary: 'renderer usecase callback with transactional projection/outbox',
        yjs: 'real Y.Doc with revision/vector/hash CAS',
        tests: {
          total: vitest.numTotalTests,
          passed: vitest.numPassedTests,
          failed: vitest.numFailedTests,
        },
        concurrency: {
          seeds: 100,
          operationsPerSeed: 50,
          totalOperations: 5_000,
          uniqueWrites: 1_000,
          duplicateWriteDeliveries: 1_000,
          reads: 3_000,
        },
        injectedBoundaries: [
          'pre_mutation_prepare_failure',
          'after_yjs_before_projection',
          'after_projection_before_outbox',
          'after_outbox_before_result',
          'after_inverse_before_review_receipt',
        ],
        passed: writePassed,
      },
      crash,
      passed: writePassed && crash.passed,
    };
    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(
        options.output,
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runP3Acceptance(parseOptions(process.argv.slice(2)))
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
