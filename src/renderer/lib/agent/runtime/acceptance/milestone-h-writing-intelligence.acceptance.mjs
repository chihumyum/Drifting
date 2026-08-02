import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));

const TEST_GROUPS = {
  literaryOracleAndMutations: [
    'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.test.ts',
  ],
  editorFocusAndScope: [
    'src/renderer/lib/editor-selection-memory.test.ts',
    'src/renderer/lib/agent/product-authoring-focus.test.ts',
    'src/renderer/lib/agent/runtime/writing-intelligence.test.ts',
    'src/renderer/lib/agent/runtime/writing-scope-guard.test.ts',
  ],
  providerAndProductContext: [
    'src/renderer/lib/agent/runtime/system-prompt.test.ts',
    'src/renderer/lib/agent/runtime/local-transport.test.ts',
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/store/agent-chat-store.test.ts',
  ],
  durableReadOnlyReview: ['src/renderer/lib/agent/runtime/long-task-runtime.integration.test.ts'],
  generatedCapabilityContract: [
    'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts',
  ],
};
const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/components/agent/CompanionPanel.tsx',
  'src/renderer/domain/agent-runtime-long-task.ts',
  'src/renderer/lib/agent/product-authoring-focus.ts',
  'src/renderer/lib/agent/protocol.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts',
  'src/renderer/lib/agent/runtime/local-transport.ts',
  'src/renderer/lib/agent/runtime/long-task-tool-contract.ts',
  'src/renderer/lib/agent/runtime/long-task-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/runtime.ts',
  'src/renderer/lib/agent/runtime/system-prompt.ts',
  'src/renderer/lib/agent/runtime/types.ts',
  'src/renderer/lib/agent/runtime/writing-intelligence.ts',
  'src/renderer/lib/agent/runtime/writing-quality.ts',
  'src/renderer/lib/agent/runtime/writing-scope-guard.ts',
  'src/renderer/lib/editor-selection-memory.ts',
  'src/renderer/sqlite-repo/agent-runtime-long-task-repo.ts',
  'src/renderer/store/agent-chat-store.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/editor-native-writing-protocol.md',
  'drizzle/0075_agent_runtime_review_task.sql',
  'src/renderer/lib/agent/runtime/acceptance/milestone-h-writing-intelligence.acceptance.mjs',
  ...LINT_FILES,
];
const REQUIRED_ASSERTIONS = {
  intentOracle: 'classifies author intent and scope against a deterministic ambiguity oracle',
  providerContext:
    'injects exact focus, author voice, canon impact, and work-kind policy into provider context',
  voiceMutation:
    'detects voice-flattening mutations on synthetic and local manuscript samples without leaking prose',
  citationMutation: 'accepts exact semantic citations and rejects every forged citation mutation',
  editorSelection: 'captures an exact span, stable block identity, and nearby voice context',
  namedTargetResolution: 'resolves current names and aliases into canonical explicit prose targets',
  crossEntityGuard: 'rejects edits to another entity and text outside the selection',
  namedTargetGuard:
    'allows explicitly named entities without editor focus and rejects a substituted target',
  canonGuard: 'fails closed when an explicit canon evolution tries to write prose directly',
  durableReview:
    'completes review work from exact cited reads, rejects forged quotes, and survives restart',
  capabilityContract: 'publishes editor-native writing scope, canon, voice, and review evidence',
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

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CORE_DIRECTORY,
      env: {
        ...process.env,
        DRIFTING_AGENT_ACCEPTANCE_VERBOSE: '1',
        ...extraEnv,
      },
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

function metricGate(metrics) {
  const privateCorpusAvailable = metrics.fixture?.privateCorpusAvailable === true;
  const thresholds = {
    intentAccuracy: metrics.intent?.accuracy === 1,
    identicalVoiceBaseline: metrics.voice?.identicalMedian === 1,
    voiceMutationDetection: metrics.voice?.mutationDetectionRate >= 0.95,
    privateCorpusCoverage:
      !privateCorpusAvailable ||
      (metrics.voice?.privateSamples >= 12 && metrics.fixture?.privateCorpusFiles >= 12),
    exactCitationAcceptance: metrics.citations?.exactAccepted === metrics.citations?.exactCases,
    forgedCitationRejection: metrics.citations?.forgedRejectionRate === 1,
  };
  return {
    thresholds,
    passed: Object.values(thresholds).every(Boolean),
  };
}

export async function runMilestoneHAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-milestone-h-'));
  try {
    const reportPath = path.join(directory, 'vitest.json');
    const metricsPath = path.join(directory, 'writing-metrics.json');
    const vitestExecution = await runCommand(
      'pnpm',
      ['exec', 'vitest', 'run', ...TEST_FILES, '--reporter=json', `--outputFile=${reportPath}`],
      { DRIFTING_AGENT_MILESTONE_H_METRICS_PATH: metricsPath },
    );
    let report;
    let metrics;
    try {
      [report, metrics] = await Promise.all([
        readFile(reportPath, 'utf8').then(JSON.parse),
        readFile(metricsPath, 'utf8').then(JSON.parse),
      ]);
    } catch (error) {
      throw new Error(
        `Milestone H did not produce readable Vitest and metric reports.\n${vitestExecution.stderr || vitestExecution.stdout}\n${error instanceof Error ? error.message : String(error)}`,
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
    const metricsGate = metricGate(metrics);
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
      suite: 'milestone-h-editor-native-writing-intelligence',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      evidence: {
        intentOracle: '25-curated-chinese-and-english-author-requests',
        literaryFixture: metrics.fixture?.privateCorpusAvailable
          ? 'synthetic-plus-local-private-read-only-corpus'
          : 'synthetic-corpus-private-fixture-unavailable',
        privateProsePersisted: false,
        durableReview: 'real-file-sqlite-exact-read-receipt-forgery-restart',
        networkRequired: false,
      },
      metrics: { ...metrics, gate: metricsGate },
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
        voiceScore:
          'Diagnostic mutation detector, not an autonomous literary-quality verdict or permission to overwrite prose.',
        liveProvider:
          'Deterministic provider-wire/runtime acceptance is required; paid live-provider canary is optional and separately reported.',
        nativeDevices:
          'Headless acceptance does not claim desktop/iOS/Android interaction or endurance acceptance; that remains milestone J.',
      },
      passed:
        vitestPassed &&
        metricsGate.passed &&
        typecheck.passed &&
        lint.passed &&
        capabilities.passed,
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
  runMilestoneHAcceptance(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
