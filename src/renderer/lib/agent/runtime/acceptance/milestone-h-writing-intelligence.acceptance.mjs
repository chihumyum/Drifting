import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));

const TEST_GROUPS = {
  authorPolicy: [
    'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.test.ts',
    'src/renderer/lib/agent/runtime/system-prompt.test.ts',
    'src/renderer/lib/agent/product-project-context.test.ts',
  ],
  guidanceLifecycle: ['src/renderer/usecase/useAgentMemory.test.ts'],
  unrestrictedWorkspace: [
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
  ],
  generatedCapabilityContract: [
    'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts',
  ],
};
const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/components/agent/CompanionPanel.tsx',
  'src/renderer/lib/agent/product-project-context.ts',
  'src/renderer/lib/agent/protocol.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts',
  'src/renderer/lib/agent/runtime/drifting-product-composition.ts',
  'src/renderer/lib/agent/runtime/local-transport.ts',
  'src/renderer/lib/agent/runtime/runtime.ts',
  'src/renderer/lib/agent/runtime/system-prompt.ts',
  'src/renderer/lib/agent/runtime/types.ts',
  'src/renderer/lib/agent/runtime/long-task-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/drifting-element-patch-write-strategy.ts',
  'src/renderer/store/agent-chat-store.ts',
  'src/renderer/usecase/useAgentMemory.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/author-owned-writing-policy.md',
  'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.mjs',
  ...LINT_FILES,
];
const REQUIRED_ASSERTIONS = {
  noProductWritingHarness: 'removes product-derived editor focus and default literary rules',
  authorOwnedPromptRules: 'injects only author-owned project facts and approved standing guidance',
  editableProjectRules: 'keeps project rules as ordinary author-editable project data',
  capabilityContract: 'publishes no hidden writing defaults or content mutation guards',
  arbitraryEntityWrite: 'lets workspace writes target any project entity without a content-scope gate',
  staleFocusRegression: 'appends to the requested drift without inheriting a stale chapter focus',
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

export async function runMilestoneHAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-milestone-h-author-control-'));
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
        `Milestone H replacement did not produce a readable Vitest report.\n${vitestExecution.stderr || vitestExecution.stdout}\n${error instanceof Error ? error.message : String(error)}`,
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
      suite: 'milestone-h-author-owned-writing-policy',
      schemaVersion: 2,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      evidence: {
        productWritingDefaults: 'none',
        editorContextInjected: false,
        contentMutationScopeGuard: false,
        canonPatchGate: false,
        authorRuleSources: ['projectFacts', 'activeAuthorMemory', 'currentAuthorRequest'],
        dataIntegrityGuardsRetained: ['projectIsolation', 'Yjs', 'CAS', 'review', 'destructiveApproval'],
        networkRequired: false,
      },
      vitest: {
        files: {
          required: TEST_FILES.length,
          discovered: new Set(report.testResults.map((result) => normalizeTestPath(result.name)))
            .size,
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
        writingPolicy:
          'Drifting supplies workspace mechanics only; the current request and author-owned project rules control writing behavior.',
        retainedSafety:
          'Project isolation, concurrency checks, durable review, and destructive-operation approval protect data rather than prescribe prose.',
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
      throw new Error('Milestone H author-control acceptance failed.');
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  runMilestoneHAcceptance(options)
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
