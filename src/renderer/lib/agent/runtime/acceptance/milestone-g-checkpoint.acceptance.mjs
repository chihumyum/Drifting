import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));

const TEST_GROUPS = {
  fileBackedCheckpointAndRewind: [
    'src/renderer/lib/agent/runtime/acceptance/milestone-g-checkpoint.acceptance.test.ts',
  ],
  forkContextAndChatLifecycle: [
    'src/renderer/lib/agent/runtime/system-prompt.test.ts',
    'src/renderer/store/agent-chat-store.test.ts',
  ],
  yjsCommandAndCanonicalRecovery: [
    'src/renderer/lib/agent/runtime/yjs-prose-command.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  ],
  generatedCapabilityContract: [
    'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts',
  ],
};
const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/components/agent/AgentCheckpointMenu.tsx',
  'src/renderer/components/agent/CompanionPanel.tsx',
  'src/renderer/domain/agent-conversation.ts',
  'src/renderer/domain/agent-user-checkpoint.ts',
  'src/renderer/lib/agent/protocol.ts',
  'src/renderer/lib/agent/runtime/agent-user-checkpoint-contract.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-g-checkpoint.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts',
  'src/renderer/lib/agent/runtime/system-prompt.ts',
  'src/renderer/schema/drizzle.ts',
  'src/renderer/services/agent-user-checkpoint-workspace.ts',
  'src/renderer/services/agent-user-checkpoint.service.ts',
  'src/renderer/services/snapshot-restore.service.ts',
  'src/renderer/sqlite-repo/agent-conversation-repo.ts',
  'src/renderer/sqlite-repo/agent-user-checkpoint-repo.ts',
  'src/renderer/store/agent-chat-store.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/checkpoint-rewind-protocol.md',
  'drizzle/0074_agent_user_checkpoint.sql',
  'src/renderer/lib/agent/runtime/acceptance/milestone-g-checkpoint.acceptance.mjs',
  ...LINT_FILES,
];
const REQUIRED_ASSERTIONS = {
  completeCaptureAndFork:
    'captures complete SQLite/Yjs state and creates an idempotent non-destructive fork',
  authorEditProtection:
    'refuses missing confirmation and a stale preview before any manuscript write',
  wholeBookRestore:
    'restores a whole-book intent by semantic content and forks while preserving its source chat',
  multiEntityCompensation:
    'compensates all already-applied entities when a later entity fails',
  restartRecovery:
    'recovers an interrupted applying saga after a real SQLite reopen without overwriting later edits',
  forkContext:
    'injects complete durable fork context outside the 2k standing-memory clamp',
  capabilityContract:
    'publishes the provider-neutral user checkpoint, safe rewind, and fork contract',
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function normalizeTestPath(value) {
  return path.relative(CORE_DIRECTORY, path.resolve(value)).split(path.sep).join('/');
}

function assertionRows(report) {
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
  const results = report.testResults.filter((result) => wanted.has(normalizeTestPath(result.name)));
  const checks = results.flatMap((result) => result.assertionResults ?? []);
  const passed = checks.filter((check) => check.status === 'passed').length;
  const failed = checks.filter((check) => check.status === 'failed').length;
  const pending = checks.length - passed - failed;
  return {
    requiredFiles: files.length,
    discoveredFiles: results.length,
    tests: { total: checks.length, passed, failed, pending },
    passed: results.length === files.length && checks.length > 0 && failed === 0 && pending === 0,
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

export async function runMilestoneGAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-milestone-g-'));
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
        `Milestone G Vitest did not produce a readable JSON report.\n${vitestExecution.stderr || vitestExecution.stdout}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const [typecheckExecution, lintExecution, capabilityExecution] = await Promise.all([
      runCommand('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']),
      runCommand('pnpm', ['exec', 'eslint', ...LINT_FILES]),
      runCommand('pnpm', ['agent:capabilities:check']),
    ]);
    const assertions = assertionRows(report);
    const assertionGates = Object.fromEntries(
      Object.entries(REQUIRED_ASSERTIONS).map(([gate, requiredName]) => {
        const matches = assertions.filter((assertion) => assertion.name.includes(requiredName));
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
      suite: 'milestone-g-user-checkpoint-rewind-fork',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      evidence: {
        sqlite: 'real-file-wal-full-product-migrations',
        yjs: 'real-doc-state-vector-revision-cover-restore',
        restart: 'database-close-reopen-and-saga-compensation',
        concurrency: 'post-preview-and-mid-action-author-edit-fail-closed',
        networkRequired: false,
      },
      vitest: {
        files: {
          required: TEST_FILES.length,
          discovered: new Set(report.testResults.map((result) => normalizeTestPath(result.name))).size,
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
        manuscriptScope:
          'node/element/storyline/category prose and restorable metadata; deleted structural identities fail closed',
        nativeDevices:
          'Headless acceptance does not claim desktop/iOS/Android interaction or lifecycle acceptance; that remains milestone J.',
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
  runMilestoneGAcceptance(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
