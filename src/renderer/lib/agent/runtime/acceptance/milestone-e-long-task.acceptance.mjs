import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));

const TEST_GROUPS = {
  durablePlanAndManifest: [
    'src/renderer/lib/agent/runtime/long-task-runtime.integration.test.ts',
    'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
  ],
  continuationAndAuthorControl: [
    'src/renderer/lib/agent/runtime/long-task-auto-continuation.test.ts',
    'src/renderer/lib/agent/runtime/runtime.test.ts',
    'src/renderer/store/agent-chat-store.test.ts',
  ],
  restartAndInvisibleContinuation: [
    'src/renderer/lib/agent/runtime/recovered-transcript.test.ts',
    'src/renderer/lib/agent/runtime/local-transport-persistence.test.ts',
  ],
  productYjsContextAndTruth: [
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/lib/agent/runtime/runtime-context-planning.test.ts',
    'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/domain/agent-runtime-long-task.ts',
  'src/renderer/lib/agent/protocol.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts',
  'src/renderer/lib/agent/runtime/local-transport.ts',
  'src/renderer/lib/agent/runtime/long-task-auto-continuation.ts',
  'src/renderer/lib/agent/runtime/long-task-context.ts',
  'src/renderer/lib/agent/runtime/long-task-tool-contract.ts',
  'src/renderer/lib/agent/runtime/long-task-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/recovered-transcript.ts',
  'src/renderer/lib/agent/runtime/recovery.ts',
  'src/renderer/lib/agent/runtime/runtime.ts',
  'src/renderer/lib/agent/runtime/system-prompt.ts',
  'src/renderer/lib/agent/runtime/types.ts',
  'src/renderer/sqlite-repo/agent-runtime-long-task-repo.ts',
  'src/renderer/store/agent-chat-store.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/long-task-execution-protocol.md',
  'drizzle/0073_agent_runtime_task_step_retired.sql',
  'drizzle/meta/_journal.json',
  'src/renderer/lib/agent/runtime/acceptance/milestone-e-long-task.acceptance.mjs',
  ...LINT_FILES,
];

const REQUIRED_ASSERTIONS = {
  manifestCompletionGate:
    'revalidates exact frozen-manifest coverage before whole-book completion',
  manifestReconcileRestart:
    'reconciles added, removed, renamed, reordered, and restored chapters atomically across restart',
  productPlanPinned:
    'persists a whole-book plan, resolves named targets, and pins it into the next turn',
  mixedReviewProgress:
    'continues independent runnable work while another step awaits review and pauses for review-only work',
  metadataCannotDefeatWatchdog:
    'does not mistake a metadata-only revision bump for task progress',
  manifestAutoContinuation:
    'schedules explicit manifest reconciliation and treats retired audit steps as terminal',
  unlimitedDefaultWork:
    'fails closed on terminal failure and unavailable plans without imposing work quotas',
  safeStop:
    'stops scheduling later writes immediately after the current tool settles',
  exactSteering:
    'applies author steering exactly once at the next model boundary',
  manualResumeAfterTerminal:
    'offers manual continuation after any terminal turn with an authoritative same-session open plan',
  invisibleContinuation:
    'keeps runtime continuation prompts in model history but out of the visible transcript',
  productMigrationReopen:
    'follows the checked-in journal and reopens idempotently',
  executableCapabilityTruth:
    'keeps the long-task execution contract tied to executable runtime defaults',
};

function parseOptions(argv) {
  const options = { output: null };
  for (const argument of argv) {
    if (argument.startsWith('--output=')) {
      options.output = path.resolve(CORE_DIRECTORY, argument.slice('--output='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function normalizeTestPath(value) {
  return path.relative(CORE_DIRECTORY, path.resolve(value)).split(path.sep).join('/');
}

function assertions(report) {
  return report.testResults.flatMap((result) =>
    (result.assertionResults ?? []).map((assertion) => ({
      file: normalizeTestPath(result.name),
      name:
        assertion.fullName ??
        [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(' '),
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
  return result.code === 0 && result.signal === null ? result.stdout.trim() || null : null;
}

function processGate(execution) {
  return {
    exitCode: execution.code,
    signal: execution.signal,
    passed: execution.code === 0 && execution.signal === null,
  };
}

export async function runMilestoneEAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-milestone-e-'));
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
        `Milestone E Vitest did not produce a readable JSON report.\n${vitestExecution.stderr || vitestExecution.stdout}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const [typecheckExecution, lintExecution, capabilityExecution] = await Promise.all([
      runCommand('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']),
      runCommand('pnpm', ['exec', 'eslint', ...LINT_FILES]),
      runCommand('pnpm', ['agent:capabilities:check']),
    ]);
    const allAssertions = assertions(report);
    const assertionGates = Object.fromEntries(
      Object.entries(REQUIRED_ASSERTIONS).map(([gate, requiredName]) => {
        const matches = allAssertions.filter((assertion) => assertion.name.includes(requiredName));
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
      Object.entries(TEST_GROUPS).map(([name, files]) => [name, summarizeGroup(report, files)]),
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
      suite: 'milestone-e-durable-long-task-execution',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      execution: {
        defaultTaskBudgets: 'unlimited',
        safeStop: 'after-current-tool',
        steering: 'next-model-iteration-exactly-once',
        continuationAuthorization: 'renderer-lifetime-author-action',
        restart: 'durable-plan-manual-reauthorization',
        stagnantAutomaticSliceWatchdog: 2,
      },
      storageReplay: {
        sqlite:
          'real file-backed product SQLite with migration 0073, CAS command receipts, injected receipt rollback, manifest reconciliation, close and reopen',
        prose:
          'product composition exercises live Yjs prose coordination while long-task state stays pinned in the same runtime context planner',
        transcript:
          'canonical journal recovery preserves model continuation history without manufacturing author messages',
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
        process: { exitCode: vitestExecution.code, signal: vitestExecution.signal },
        passed: vitestPassed,
      },
      typecheck,
      lint,
      capabilities,
      boundaries: {
        literaryContextQuality:
          'long-task continuity is closed; literary compaction and retrieval quality remain milestone F',
        checkpointRewind:
          'durable task history is not yet a user-facing manuscript checkpoint/fork surface; that remains milestone G',
        nativeDevices:
          'renderer and file-process restart are covered headlessly; desktop/iOS/Android lifecycle remains milestone J',
        providerNetwork:
          'provider-independent scheduling semantics are covered; live provider conformance remains milestone I',
      },
      passed: vitestPassed && typecheck.passed && lint.passed && capabilities.passed,
    };
    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(options.output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    }
    if (!summary.passed) {
      const diagnostics = [
        vitestExecution.stderr || vitestExecution.stdout,
        typecheckExecution.stderr || typecheckExecution.stdout,
        lintExecution.stderr || lintExecution.stdout,
        capabilityExecution.stderr || capabilityExecution.stdout,
      ].filter(Boolean).join('\n');
      if (diagnostics) process.stderr.write(diagnostics);
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMilestoneEAcceptance(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
