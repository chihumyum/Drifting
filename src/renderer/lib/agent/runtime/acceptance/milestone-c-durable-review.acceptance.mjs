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
  turnCommitAndContextAdoption: [
    'src/renderer/lib/agent/runtime/local-transport.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  ],
  writeAndReviewLedger: [
    'src/renderer/sqlite-repo/agent-runtime-write-effect-repo.integration.test.ts',
    'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/drifting-write-recovery.integration.test.ts',
  ],
  fileSqliteAndYjsProduct: [
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/lib/agent/chapter-prose-review.test.ts',
  ],
  editorProjectionAndAnimation: [
    'src/renderer/store/agent-edit-store.test.ts',
    'src/renderer/components/editor/agent-edit-animation.test.ts',
    'src/renderer/lib/agent/useDriftingAgentRuntime.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'src/renderer/components/editor/AgentEditAnimator.tsx',
  'src/renderer/components/editor/agent-edit-animation.ts',
  'src/renderer/lib/agent/chapter-prose.ts',
  'src/renderer/lib/agent/runtime/local-transport.ts',
  'src/renderer/lib/agent/runtime/repository-transport-persistence.ts',
  'src/renderer/lib/agent/runtime/drifting-write-strategies.ts',
  'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.ts',
  'src/renderer/sqlite-repo/agent-runtime-write-effect-repo.ts',
  'src/renderer/store/agent-edit-store.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'drizzle/0000_local_first_baseline.sql',
  'drizzle/meta/_journal.json',
  'docs/agent-runtime/durable-commit-review-protocol.md',
  'src/renderer/domain/agent-runtime-write-effect.ts',
  'src/renderer/schema/drizzle.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-c-durable-review.acceptance.mjs',
  ...LINT_FILES,
];

const REQUIRED_ASSERTIONS = {
  transientTurnCommitRetry:
    'retries an idempotent durable commit before publishing the completed terminal',
  permanentTurnCommitFailClosed:
    'fails the live canonical terminal closed when the completed turn cannot commit',
  lostSqliteCommitAcknowledgement:
    'adopts one exact history when SQLite committed but the first commit acknowledgement was lost',
  orderedBlockLedger:
    'persists ordered block decisions and atomically settles mixed/all-reverted reviews',
  runtimeBlockRecovery:
    'settles prose review blocks durably and retries an entered block inverse during project hydration',
  localProjectionLoss:
    'rebuilds a lost inline review from file SQLite and settles mixed blocks against Yjs',
  postYjsSettlementFault:
    'recovers when Yjs reverted but the durable block-settlement acknowledgement failed',
  unrelatedAuthorEdit:
    'preserves unrelated author edits while reverting only the certified Agent block',
  sameBlockAuthorConflict:
    'refuses to overwrite author text changed after the Agent edit',
  yjsPersistenceRetry:
    'retries idempotently when Yjs changed but the first persistence acknowledgement failed',
  rejectedAnimationDirection:
    'turns every bulk rejection into the visible inverse animation',
  nativeScrollRevealCoordinates:
    'keeps reveal coordinates stable inside the native scrolling content tree',
  sqliteProjectionWins:
    'replaces stale local decisions with the exact SQLite-backed projection',
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
  for (const file of [...new Set(files)].sort()) {
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

function processGate(execution) {
  return {
    exitCode: execution.code,
    signal: execution.signal,
    passed: execution.code === 0 && execution.signal === null,
  };
}

export async function runMilestoneCAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-agent-milestone-c-'),
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
          'Milestone C Vitest did not produce a readable JSON report.',
          vitestExecution.stderr || vitestExecution.stdout,
          error instanceof Error ? error.message : String(error),
        ].join('\n'),
      );
    }
    const [typecheckExecution, lintExecution, capabilityExecution] =
      await Promise.all([
        runCommand('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']),
        runCommand('pnpm', ['exec', 'eslint', ...LINT_FILES]),
        runCommand('pnpm', ['agent:capabilities:check']),
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
            passed: matches.length === 1 && matches[0]?.status === 'passed',
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
    const typecheck = processGate(typecheckExecution);
    const lint = processGate(lintExecution);
    const capabilities = processGate(capabilityExecution);
    const summary = {
      suite: 'milestone-c-durable-commit-and-inline-review',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      storageReplay: {
        sqlite:
          'real file-backed SQLite from the current local-first baseline with injected transaction faults',
        prose: 'real Yjs snapshots/updates and guarded block inverses',
        localProjection: 'Zustand/localStorage state deliberately cleared and rebuilt',
        networkRequired: false,
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
      typecheck,
      lint,
      capabilities,
      boundaries: {
        nativeAnimationAppearance:
          'direction and selection are deterministic; visual smoothness remains user/native acceptance',
        deviceRestart:
          'file/process restart is headless; platform lifecycle acceptance remains milestone J',
        providerNetwork:
          'not required for storage semantics; multi-provider conformance remains milestone I',
      },
      passed:
        vitestPassed &&
        typecheck.passed &&
        lint.passed &&
        capabilities.passed,
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
        lintExecution.stderr || lintExecution.stdout,
        capabilityExecution.stderr || capabilityExecution.stdout,
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
  runMilestoneCAcceptance(parseOptions(process.argv.slice(2)))
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
