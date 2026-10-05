import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));

const TEST_GROUPS = {
  modelDirectedToolDiscovery: [
    'src/renderer/lib/agent/runtime/tool-discovery.test.ts',
    'src/renderer/lib/agent/runtime/tool-discovery-provider.integration.test.ts',
  ],
  syntheticBookAndLongContext: [
    'src/renderer/lib/agent/runtime/acceptance/milestone-f-literary-context.acceptance.test.ts',
    'src/renderer/lib/agent/runtime/acceptance/milestone-f-context-engineering.acceptance.test.ts',
  ],
  providerBudgetAndPlanning: [
    'src/renderer/store/settings-store-agent.test.ts',
    'src/renderer/lib/agent/runtime/drifting-agent-product-contract.test.ts',
    'src/renderer/lib/agent/runtime/context-planner.test.ts',
    'src/renderer/lib/agent/runtime/runtime-context-planning.test.ts',
    'src/renderer/lib/agent/runtime/steering-context.integration.test.ts',
  ],
  literaryCompactionAndRetrieval: [
    'src/renderer/lib/agent/runtime/drifting-context-compactor.test.ts',
    'src/renderer/lib/agent/runtime/context-evidence-retrieval.test.ts',
  ],
  durablePagingAndRestart: [
    'src/renderer/lib/agent/runtime/recovery.test.ts',
    'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.integration.test.ts',
    'src/renderer/sqlite-repo/agent-runtime-persistence-repo.integration.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  ],
  longTaskNoDuplicateWrites: [
    'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/workspace-domain-language.test.ts',
    'src/renderer/lib/agent/runtime/write-review-feedback.test.ts',
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/lib/agent/runtime/long-task-runtime.integration.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'src/renderer/lib/agent/runtime/tool-discovery.ts',
  'src/renderer/lib/agent/runtime/system-prompt.ts',
  'src/renderer/lib/agent/runtime/drifting-product-tool-selection.ts',
  'src/renderer/lib/agent/runtime/drivers/openai-responses-driver.ts',
  'src/renderer/lib/agent/runtime/drivers/anthropic-messages-driver.ts',
  'src/renderer/lib/agent/runtime/drivers/openai-compatible-completion-driver.ts',
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/features/agent/AgentComposerConfig.tsx',
  'src/renderer/store/settings-store.ts',
  'src/renderer/lib/agent/runtime/agent-provider-contract.ts',
  'src/renderer/lib/agent/tool-handlers.ts',
  'src/renderer/lib/agent/tool-registry.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-context-engineering.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-literary-context.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-literary-fixture.ts',
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
  'src/renderer/lib/agent/runtime/local-transport.ts',
  'src/renderer/lib/agent/runtime/transport-persistence.ts',
  'src/renderer/lib/agent/runtime/recovery.ts',
  'src/renderer/lib/agent/runtime/errors.ts',
  'src/renderer/lib/agent/runtime/write-review-feedback.ts',
  'src/renderer/lib/agent/runtime/long-task-context.ts',
  'src/renderer/sqlite-repo/agent-runtime-long-task-repo.ts',
  'src/renderer/lib/agent/runtime/types.ts',
  'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.ts',
  'src/renderer/sqlite-repo/agent-runtime-persistence-repo.ts',
  'src/renderer/lib/agent/runtime/repository-transport-persistence.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/tool-discovery.md',
  'docs/agent-runtime/context-engineering-protocol.md',
  'src/renderer/lib/agent/runtime/acceptance/milestone-f-context-engineering.acceptance.mjs',
  ...LINT_FILES,
];

const REQUIRED_ASSERTIONS = {
  steeringWholeBookWorkingSet:
    'compacts settled writes after steering and preserves a complete 15-chapter mixed read batch above 64k',
  steeringRestartOwnership:
    'recovers execution ownership after same-turn steering without changing checkpoint source hashes',
  settledMixedBatchCompaction:
    'compacts an older mixed read and settled task-write batch atomically after steering',
  steeringReceiptScope:
    'scopes reused call IDs to a verified execution turn after steering (verified)',
  steeringForeignReceipt:
    'scopes reused call IDs to a verified execution turn after steering (foreign-owner)',
  steeringMissingOwner:
    'scopes reused call IDs to a verified execution turn after steering (missing-ownership)',
  steeringWrongTool:
    'scopes reused call IDs to a verified execution turn after steering (wrong-tool)',
  singleToolArgumentBudget:
    'charges large tool arguments once while preserving canonical bytes and hashes',
  compactionNoGainDiagnostics:
    'opens the circuit when a compactor returns no token gain',
  compactionFallbackDiagnostics:
    'times out one stalled paid chunk and continues with the deterministic fallback',
  discoveryCompositeDispatch: 'executes named and empty-query discovery locally through the composite runtime read scheduler',
  discoveryRetryAfterFailure: 'reuses discovered schemas after a write and explicit retry across restart (failed)',
  discoveryRetryAfterAbort: 'reuses discovered schemas after a write and explicit retry across restart (aborted)',
  discoveryRetryAfterInterruption: 'reuses discovered schemas after a write and explicit retry across restart (interrupted)',
  fixedToolPrefix: 'keeps a complete directory and fixed tools while schemas arrive only in tool results',
  discoveryPermissions: 'authorizes the real write and never grants authority through the read-only dispatcher',
  discoveryRecovery: 'can switch to full schemas and back without invalidating discovered history',
  discoveryProviderWire: 'preserves openai-codex schemas, call IDs and encrypted reasoning through search/read/write/synthesis',
  longBookContext:
    'preserves literary evidence and author constraints across 200k multi-slice compaction, restart, and compactor faults',
  syntheticBookRetrieval:
    'recalls canon, voice, aliases, writing rules, and chapter evidence from the synthetic fixture',
  providerTarget: 'installs the default model declaration without a separate product target',
  providerCannotBeEnlarged: 'never enlarges a smaller provider declaration with a DEV override',
  undeclaredProviderFallback: 'uses a conservative window for an undeclared custom driver',
  safeCompactorFallback:
    'leaves committed-write proof to durable receipts and rejects forged provider evidence',
  sameTurnOversize: 'compacts older tool batches inside one oversized current turn',
  sameTurnChunking: 'chunks inside one turn at tool-topology boundaries without splitting a pair',
  boundedCompactorCalls: 'stops after enough chunk gain instead of compacting all history',
  declaredModelWindows: 'uses discovered model windows without standard or Max caps',
  retiredContextPreference: 'retires a persisted Max preference of false',
  mixedChunkGain:
    'keeps a no-gain short chunk exact while applying profitable full-compactor chunks',
  activeTurnWriteDelta:
    'drops same-turn pre-write prose after recovery while retaining the successful delta',
  focusedWorkingCopy: 'keeps one complete same-turn working copy across focused authored edits',
  supersededRead:
    'drops an older complete read when a newer complete read covers the same authored object',
  obsoleteSummaryRetirement:
    'retires a cached summary when a later read makes one covered source discardable',
  multiChapterWorkingSet:
    'keeps a bounded multi-chapter authored working set exact when it fits the window',
  noopContextRetirement:
    'drops a successful side-effect-free write while retaining an unresolved write',
  noopWriteSettlement: 'settles a workspace no-op as success without claiming a durable effect',
  durableReadProgress:
    'keeps complete authored reading as current domain state after body and summary writes',
  domainReadProgressPresentation:
    'retains full-read and current-summary state without transport vocabulary',
  wholeChapterSummaryReview:
    'commits whole-chapter prose and summary together and restores the summary when one block is rejected',
  wholeChapterSummaryRollback:
    'rolls back prose, summary, Yjs receipt, and sync journal when their shared transaction fails',
  artifactRestart: 'pages exact Unicode content after closing and reopening the repository',
  checkpointRestart:
    'commits the final assistant atomically, restarts, verifies nested integrity, and resumes canonical history',
  interruptedContinuation:
    'preserves interrupted author intent and completed reads through repeated restart and a completed continuation (writes: false)',
  interruptedWriteSafety:
    'preserves interrupted author intent and completed reads through repeated restart and a completed continuation (writes: true)',
  atomicContinuation:
    'atomically accepts continuation context and rejects altered or partial acceptance replays',
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
      syntheticLongBook:
        metrics.fixture.syntheticCorpusGenerated === true &&
        metrics.fixture.syntheticCorpusDocuments >= 16 &&
        metrics.fixture.syntheticCorpusBytes >= 250_000,
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
        syntheticProse:
          'generated at test runtime only; machine report stores counts and bytes, never prose',
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
