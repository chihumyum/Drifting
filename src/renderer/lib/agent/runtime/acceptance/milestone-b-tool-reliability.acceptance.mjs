import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);

const TEST_GROUPS = {
  providerStreamAndScheduling: [
    'src/renderer/lib/agent/runtime/runtime.test.ts',
  ],
  searchRepairAliasAndLease: [
    'src/renderer/lib/agent/runtime/runtime-tool-search.test.ts',
    'src/renderer/lib/agent/runtime/dynamic-tool-runtime.test.ts',
  ],
  idempotencyAndRecovery: [
    'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/recovery.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence.test.ts',
  ],
  compactionContinuity: [
    'src/renderer/lib/agent/runtime/runtime-context-planning.test.ts',
    'src/renderer/lib/agent/runtime/context-planner.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const HASHED_SOURCE_FILES = [
  'src/renderer/lib/agent/runtime/acceptance/milestone-b-tool-reliability.acceptance.mjs',
  'src/renderer/lib/agent/runtime/runtime.ts',
  'src/renderer/lib/agent/runtime/types.ts',
  'src/renderer/lib/agent/runtime/dynamic-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/scheduler.ts',
  ...TEST_FILES,
];

const REQUIRED_ASSERTIONS = {
  fragmentedArguments:
    'assembles fragmented arguments, journals normalized input, and continues after a tool',
  interleavedParallelArguments:
    'assembles character-streamed arguments for interleaved parallel tool calls',
  adjacentReadConcurrency:
    'runs adjacent reads concurrently while preserving write barriers and result order',
  crossRuntimeWriteSerialization:
    'serializes writes across concurrent runtime instances',
  omittedToolRepairLease:
    'leases an omitted installed tool into the next iteration for one repair attempt',
  invalidArgumentsRepairLease:
    'leases a schema-invalid tool until corrected arguments execute successfully',
  trueUnknownFailClosed:
    'does not lease a truly unknown hallucinated tool',
  executableAliasNormalization:
    'normalizes an executable legacy dispatcher alias before validation and execution',
  builtInDefinitionLease:
    'binds built-in execution to the exact definition leased for the turn',
  durableDuplicateReplay:
    'persists one authorized effect and replays duplicates without mutation or post-write review',
  recoveryIdempotency:
    'materializes recovery transitions idempotently',
  postCompactionToolContinuity:
    'keeps the selected tool executable on the iteration after verified compaction',
  danglingTopologyFailClosed:
    'fails closed on dangling canonical tool topology before any compactor runs',
};

function parseOptions(argv) {
  const options = { output: null };
  for (const argument of argv) {
    if (argument.startsWith('--output=')) {
      options.output = path.resolve(
        CORE_DIRECTORY,
        argument.slice('--output='.length),
      );
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CORE_DIRECTORY,
      env: { ...process.env, DRIFTING_AGENT_ACCEPTANCE_VERBOSE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function normalizeTestPath(value) {
  return path
    .relative(CORE_DIRECTORY, path.resolve(value))
    .split(path.sep)
    .join('/');
}

function assertions(report) {
  return report.testResults.flatMap((result) =>
    (result.assertionResults ?? []).map((assertion) => ({
      file: normalizeTestPath(result.name),
      name:
        assertion.fullName ??
        [...(assertion.ancestorTitles ?? []), assertion.title]
          .filter(Boolean)
          .join(' '),
      status: assertion.status,
    })),
  );
}

function summarizeGroup(report, files) {
  const wanted = new Set(files);
  const results = report.testResults.filter((result) =>
    wanted.has(normalizeTestPath(result.name)),
  );
  const checks = results.flatMap((result) => result.assertionResults ?? []);
  const passed = checks.filter((check) => check.status === 'passed').length;
  const failed = checks.filter((check) => check.status === 'failed').length;
  const pending = checks.length - passed - failed;
  return {
    requiredFiles: files.length,
    discoveredFiles: results.length,
    tests: { total: checks.length, passed, failed, pending },
    passed:
      results.length === files.length &&
      checks.length > 0 &&
      failed === 0 &&
      pending === 0,
  };
}

async function hashSourceSet(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(path.join(CORE_DIRECTORY, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function gitHead() {
  const result = await runCommand('git', ['rev-parse', 'HEAD']);
  return result.code === 0 && result.signal === null
    ? result.stdout.trim() || null
    : null;
}

export async function runMilestoneBAcceptance(
  options = parseOptions([]),
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-agent-milestone-b-'),
  );
  try {
    const reportPath = path.join(directory, 'vitest.json');
    const vitestExecution = await runCommand('pnpm', [
      'exec',
      'vitest',
      'run',
      ...TEST_FILES,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ]);
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (error) {
      throw new Error(
        [
          'Milestone B Vitest did not produce a readable JSON report.',
          vitestExecution.stderr || vitestExecution.stdout,
          error instanceof Error ? error.message : String(error),
        ].join('\n'),
      );
    }
    const typecheckExecution = await runCommand('pnpm', [
      'exec',
      'tsc',
      '--noEmit',
      '--pretty',
      'false',
    ]);
    const allAssertions = assertions(report);
    const assertionGates = Object.fromEntries(
      Object.entries(REQUIRED_ASSERTIONS).map(([gate, requiredName]) => {
        const matches = allAssertions.filter((assertion) =>
          assertion.name.includes(requiredName),
        );
        return [
          gate,
          {
            requiredName,
            matches: matches.length,
            passed:
              matches.length === 1 && matches[0]?.status === 'passed',
          },
        ];
      }),
    );
    const groups = Object.fromEntries(
      Object.entries(TEST_GROUPS).map(([name, files]) => [
        name,
        summarizeGroup(report, files),
      ]),
    );
    const vitestPassed =
      vitestExecution.code === 0 &&
      vitestExecution.signal === null &&
      report.success === true &&
      Object.values(groups).every((group) => group.passed) &&
      Object.values(assertionGates).every((gate) => gate.passed);
    const typecheckPassed =
      typecheckExecution.code === 0 && typecheckExecution.signal === null;
    const summary = {
      suite: 'milestone-b-agent-tool-reliability',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      providerReplay: {
        kind: 'deterministic-captured-wire-shape',
        networkRequired: false,
        characterChunking: true,
        interleavedToolCalls: true,
      },
      vitest: {
        files: {
          required: TEST_FILES.length,
          discovered: new Set(
            report.testResults.map((result) => normalizeTestPath(result.name)),
          ).size,
        },
        tests: {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          pending: report.numPendingTests,
          todo: report.numTodoTests,
        },
        groups,
        requiredAssertions: assertionGates,
        process: {
          exitCode: vitestExecution.code,
          signal: vitestExecution.signal,
        },
        passed: vitestPassed,
      },
      typecheck: {
        exitCode: typecheckExecution.code,
        signal: typecheckExecution.signal,
        passed: typecheckPassed,
      },
      boundaries: {
        liveProviderNetworkCall: 'not required; provider conformance belongs to milestone I',
        nativeUiSmoke: 'not required; native acceptance belongs to milestone J',
        retries:
          'one-iteration schema repair lease; repeated identical all-failed rounds still force honest synthesis',
        taskBudgets:
          'no tool-round or task-token ceiling was added by this milestone',
      },
      passed: vitestPassed && typecheckPassed,
    };
    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(
        options.output,
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    }
    if (!summary.passed) {
      const diagnostics = [
        vitestExecution.stderr || vitestExecution.stdout,
        typecheckExecution.stderr || typecheckExecution.stdout,
      ]
        .filter(Boolean)
        .join('\n');
      if (diagnostics) process.stderr.write(diagnostics);
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMilestoneBAcceptance(parseOptions(process.argv.slice(2)))
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
