import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));

const TEST_GROUPS = {
  realBookAndLongContext: [
    'src/renderer/lib/agent/runtime/acceptance/milestone-f-literary-context.acceptance.test.ts',
    'src/renderer/lib/agent/runtime/acceptance/milestone-f-context-engineering.acceptance.test.ts',
  ],
  providerBudgetAndPlanning: [
    'src/renderer/lib/agent/runtime/drifting-agent-product-contract.test.ts',
    'src/renderer/lib/agent/runtime/context-planner.test.ts',
    'src/renderer/lib/agent/runtime/runtime-context-planning.test.ts',
  ],
  literaryCompactionAndRetrieval: [
    'src/renderer/lib/agent/runtime/drifting-context-compactor.test.ts',
    'src/renderer/lib/agent/runtime/context-evidence-retrieval.test.ts',
    'src/renderer/lib/agent/runtime/context-constraint-conflicts.test.ts',
  ],
  durablePagingAndRestart: [
    'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.integration.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  ],
  longTaskNoDuplicateWrites: [
    'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/long-task-runtime.integration.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/lib/agent/tool-handlers.ts',
  'src/renderer/lib/agent/tool-registry.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-context-engineering.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-literary-context.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-literary-fixture.ts',
  'src/renderer/lib/agent/runtime/context-constraint-conflicts.ts',
  'src/renderer/lib/agent/runtime/context-evidence-retrieval.ts',
  'src/renderer/lib/agent/runtime/context-message-adapter.ts',
  'src/renderer/lib/agent/runtime/context-planner.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-product-contract.ts',
  'src/renderer/lib/agent/runtime/drifting-context-compactor.ts',
  'src/renderer/lib/agent/runtime/drifting-product-composition.ts',
  'src/renderer/lib/agent/runtime/drifting-read-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/literary-context-summary.ts',
  'src/renderer/lib/agent/runtime/runtime-context-planning.ts',
  'src/renderer/lib/agent/runtime/runtime.ts',
  'src/renderer/lib/agent/runtime/types.ts',
  'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/context-engineering-protocol.md',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-context-engineering.acceptance.mjs',
  ...LINT_FILES,
];

const REQUIRED_ASSERTIONS = {
  longBookContext:
    'preserves literary evidence and author constraints across 200k multi-slice compaction, restart, and compactor faults',
  realBookRetrieval:
    'recalls canon, voice, aliases, writing rules, and chapter evidence from the real-book fixture',
  providerTarget: 'installs the current default driver at the 200k product target',
  providerCannotBeEnlarged: 'never enlarges a smaller provider declaration',
  undeclaredProviderFallback: 'uses a conservative window for an undeclared custom driver',
  exactCompactorEvidence: 'rejects summaries that omit or forge exact evidence from a tool result',
  mixedChunkGain:
    'keeps a no-gain short chunk exact while applying profitable full-compactor chunks',
  constraintConfirmation:
    'blocks writes on contradictory author facts until ask_user durably confirms the exact conflict',
  artifactRestart: 'pages exact Unicode content after closing and reopening the repository',
  checkpointRestart:
    'commits the final assistant atomically, restarts, verifies nested integrity, and resumes canonical history',
  duplicateWriteReplay:
    'persists one authorized effect and replays duplicates without mutation or post-write review',
  longTaskIdempotency: 'uses one crash-safe command transaction with exact replay and CAS',
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

function parseMetrics(stdout) {
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith('MILESTONE_F_METRICS='));
  if (!line) throw new Error('Milestone F metrics marker was not emitted by the long-book test.');
  return JSON.parse(line.slice('MILESTONE_F_METRICS='.length));
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

export async function runMilestoneFAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-milestone-f-'));
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
        `Milestone F Vitest did not produce a readable JSON report.\n${vitestExecution.stderr || vitestExecution.stdout}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const metrics = parseMetrics(vitestExecution.stdout);
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
    const metricGates = {
      providerContextWindow: metrics.providerContext.contextWindowTokens === 200_000,
      realPrivateBook:
        metrics.fixture.privateCorpusFiles >= 16 && metrics.fixture.privateCorpusBytes >= 250_000,
      retrieval: Object.values(metrics.retrieval).every((value) => value.recallAt5 === 1),
      compaction:
        metrics.providerContext.compactedSlices >= 1 &&
        metrics.providerContext.medianTokenReduction >= 0.5 &&
        metrics.providerContext.maxContextWindowRatio <= 0.9,
      fidelity:
        metrics.compactionFidelity.evidenceRecall === 1 &&
        metrics.compactionFidelity.characterVoiceRecall === 1 &&
        metrics.compactionFidelity.constraintRecall === 1 &&
        metrics.compactionFidelity.retentionWitness === 'exact' &&
        metrics.compactionFidelity.sourceCoverage === 1,
      restart:
        metrics.restart.reusedVerifiedSummaries === true && metrics.restart.evidenceRecall === 1,
      faultCircuit:
        metrics.faultInjection.compactorCallsBeforeCircuitOpened === 1 &&
        metrics.faultInjection.retriesAfterCircuitOpened === 0,
      providerIndependentCompletion:
        metrics.completionQuality.providerIndependentContextScore === 1 &&
        metrics.completionQuality.generatedProseJudgment === 'deferred_to_milestone_h',
    };
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
      suite: 'milestone-f-literary-context-engineering',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      corpusPolicy: {
        committedTruth: 'distilled fog-harbor golden fixture',
        privateProse:
          'read at test runtime only; machine report stores counts and bytes, never prose',
        providerNetworkRequired: false,
      },
      metrics,
      metricGates,
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
        generatedProseQuality:
          'This gate proves context availability and fidelity, not that every provider writes excellent prose; semantic writing judgment is milestone H.',
        providerNetwork:
          'Provider contracts are bounded and deterministic here; live multi-provider conformance is milestone I.',
        nativeDevices:
          'SQLite process restart is covered headlessly; desktop/iOS/Android lifecycle and endurance are milestone J.',
      },
      passed:
        vitestPassed &&
        Object.values(metricGates).every(Boolean) &&
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
  runMilestoneFAcceptance(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
