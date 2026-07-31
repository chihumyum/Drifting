import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);

const TEST_GROUPS = {
  toolSelectorAcceptance: [
    'src/renderer/lib/agent/runtime/acceptance/p4-tool-selector.acceptance.test.ts',
  ],
  toolSelectionIntegration: [
    'src/renderer/lib/agent/runtime/tool-selector.test.ts',
    'src/renderer/lib/agent/runtime/runtime-tool-search.test.ts',
    'src/renderer/lib/agent/runtime/drifting-tool-selection.test.ts',
  ],
  contextPlannerAcceptance: [
    'src/renderer/lib/agent/runtime/acceptance/p4-context-planner.acceptance.test.ts',
  ],
  contextPlannerUnit: [
    'src/renderer/lib/agent/runtime/context-planner.test.ts',
  ],
  contextBridge: [
    'src/renderer/lib/agent/runtime/context-message-adapter.test.ts',
  ],
  runtimeContextPlanning: [
    'src/renderer/lib/agent/runtime/runtime-context-planning.test.ts',
  ],
  providerPlannedContextSeam: [
    'src/renderer/lib/agent/runtime/runtime.test.ts',
    'src/renderer/lib/agent/runtime/drivers/openai-compatible-completion-driver.test.ts',
  ],
  completedCheckpointTransport: [
    'src/renderer/lib/agent/runtime/local-transport-persistence.test.ts',
    'src/renderer/lib/agent/runtime/local-transport.test.ts',
  ],
  freshnessRepository: [
    'src/renderer/sqlite-repo/agent-runtime-freshness-repo.integration.test.ts',
  ],
  productFreshnessCas: [
    'src/renderer/lib/agent/runtime/drifting-freshness-product.integration.test.ts',
  ],
  checkpointV2: [
    'src/renderer/lib/agent/runtime/recovery.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const HASHED_SOURCE_FILES = [
  'src/renderer/lib/agent/runtime/acceptance/p4.acceptance.mjs',
  ...TEST_FILES,
  'drizzle/meta/_journal.json',
];

function parseOptions(argv) {
  const options = { output: null };
  for (const argument of argv) {
    if (argument.startsWith('--output=')) {
      options.output = path.resolve(
        CORE_DIRECTORY,
        argument.slice('--output='.length),
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function normalizeTestPath(value) {
  return path
    .relative(CORE_DIRECTORY, path.resolve(value))
    .split(path.sep)
    .join('/');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CORE_DIRECTORY,
      env: { ...process.env, ...options.env },
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

async function runVitest(outputPath) {
  return await runCommand(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      ...TEST_FILES,
      '--reporter=json',
      `--outputFile=${outputPath}`,
    ],
    {
      env: {
        DRIFTING_AGENT_ACCEPTANCE_VERBOSE: '1',
      },
    },
  );
}

function parseObservedNumber(stdout, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stdout.match(
    new RegExp(`${escaped}:\\s*(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`, 'i'),
  );
  return match ? Number(match[1]) : null;
}

function summarizeGroup(report, files) {
  const wanted = new Set(files);
  const results = report.testResults.filter((result) =>
    wanted.has(normalizeTestPath(result.name)),
  );
  const assertions = results.flatMap(
    (result) => result.assertionResults ?? [],
  );
  const passed = assertions.filter(
    (assertion) => assertion.status === 'passed',
  ).length;
  const failed = assertions.filter(
    (assertion) => assertion.status === 'failed',
  ).length;
  const pending = assertions.length - passed - failed;
  return {
    files: files.length,
    discoveredFiles: results.length,
    tests: {
      total: assertions.length,
      passed,
      failed,
      pending,
    },
    passed:
      results.length === files.length &&
      assertions.length > 0 &&
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

async function readMigrationIdentity() {
  const journal = JSON.parse(
    await readFile(
      path.join(CORE_DIRECTORY, 'drizzle/meta/_journal.json'),
      'utf8',
    ),
  );
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const latest = entries.at(-1);
  const journalIsSequential = entries.every(
    (entry, index) =>
      entry?.idx === index &&
      Number.isSafeInteger(entry?.when) &&
      typeof entry?.tag === 'string' &&
      /^[A-Za-z0-9_-]+$/u.test(entry.tag),
  );
  const latestMigrationExists =
    latest?.tag &&
    (await readFile(
      path.join(CORE_DIRECTORY, 'drizzle', `${latest.tag}.sql`),
    ).then(
      () => true,
      () => false,
    ));
  return {
    count: entries.length,
    latestIndex: latest?.idx ?? null,
    latestTag: latest?.tag ?? null,
    journalIsSequential,
    latestMigrationExists: Boolean(latestMigrationExists),
    passed:
      entries.length > 0 &&
      journalIsSequential &&
      latest?.idx === entries.length - 1 &&
      Boolean(latestMigrationExists),
  };
}

async function readGitHead() {
  const result = await runCommand('git', ['rev-parse', 'HEAD']);
  if (result.code !== 0 || result.signal !== null) return null;
  return result.stdout.trim() || null;
}

export async function runP4Acceptance(options = parseOptions([])) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-p4-acceptance-'),
  );
  try {
    const vitestOutput = path.join(directory, 'p4-vitest.json');
    const execution = await runVitest(vitestOutput);
    let vitest;
    try {
      vitest = JSON.parse(await readFile(vitestOutput, 'utf8'));
    } catch (error) {
      throw new Error(
        [
          'P4 Vitest did not produce a readable JSON report.',
          `exit=${String(execution.code)} signal=${String(execution.signal)}`,
          execution.stderr || execution.stdout,
          error instanceof Error ? error.message : String(error),
        ].join('\n'),
      );
    }

    const groups = Object.fromEntries(
      Object.entries(TEST_GROUPS).map(([name, files]) => [
        name,
        summarizeGroup(vitest, files),
      ]),
    );
    const migration = await readMigrationIdentity();
    const allGroupsPassed = Object.values(groups).every(
      (group) => group.passed,
    );
    const processPassed =
      execution.code === 0 && execution.signal === null;
    const summary = {
      suite: 'p4-agent-runtime-framework',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await readGitHead(),
      provider: 'not applicable',
      model: 'not applicable',
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      migration,
      vitest: {
        files: {
          required: TEST_FILES.length,
          discovered: new Set(
            vitest.testResults.map((result) =>
              normalizeTestPath(result.name),
            ),
          ).size,
        },
        tests: {
          total: vitest.numTotalTests,
          passed: vitest.numPassedTests,
          failed: vitest.numFailedTests,
          pending: vitest.numPendingTests,
          todo: vitest.numTodoTests,
        },
        groups,
        process: {
          exitCode: execution.code,
          signal: execution.signal,
        },
        passed: processPassed && vitest.success === true && allGroupsPassed,
      },
      gates: {
        metricPolicy: [
          'latestObservedThisRun values are parsed from this verbose Vitest run;',
          'null means the reporter omitted the observation, while',
          'machineAsserted thresholds remain enforced by test assertions',
        ].join(' '),
        toolSelection: {
          corpus: {
            intents: 150,
            bilingual: true,
          },
          machineAsserted: {
            top3RecallGte: 0.95,
            top5RecallGte: 0.99,
            safetyTop5RecallEquals: 1,
            maxSelectedToolsLte: 8,
            medianSchemaReductionGte: 0.3,
            warmedSearches: 10_000,
            warmedP95MsLt: 20,
          },
          latestObservedThisRun: {
            top3Recall: parseObservedNumber(
              execution.stdout,
              'top3Recall',
            ),
            top5Recall: parseObservedNumber(
              execution.stdout,
              'top5Recall',
            ),
            safetyTop5Recall: parseObservedNumber(
              execution.stdout,
              'safetyTop5Recall',
            ),
            medianSchemaReduction: parseObservedNumber(
              execution.stdout,
              'medianSchemaReduction',
            ),
            warmedSearches: parseObservedNumber(
              execution.stdout,
              'warmedSearches',
            ),
            warmedP95Ms: parseObservedNumber(
              execution.stdout,
              'p95Ms',
            ),
          },
        },
        contextPlanning: {
          machineAsserted: {
            generatedHistories: 10_000,
            danglingOrphanDuplicateViolationsEquals: 0,
            longScenarios: 20,
            deterministicSeeds: 3,
            longRuns: 60,
            pinnedExactRecallEquals: 1,
            constraintRecallEquals: 1,
            completionDropLte: 0.05,
            medianTokenReductionGte: 0.5,
            p95ContextWindowRatioLte: 0.9,
            fullCompactorCallsPerLongRunEquals: 1,
            compactorFaultRetriesEquals: 0,
          },
          latestObservedThisRun: {
            generatedHistories: parseObservedNumber(
              execution.stdout,
              'propertyHistories',
            ),
            danglingOrphanDuplicateViolations: parseObservedNumber(
              execution.stdout,
              'danglingOrphanDuplicateViolations',
            ),
            longRuns: parseObservedNumber(execution.stdout, 'runs'),
            pinnedExactRecall: parseObservedNumber(
              execution.stdout,
              'pinnedExactRecall',
            ),
            constraintRecall: parseObservedNumber(
              execution.stdout,
              'constraintRecall',
            ),
            completionDrop: parseObservedNumber(
              execution.stdout,
              'completionDrop',
            ),
            medianTokenReduction: parseObservedNumber(
              execution.stdout,
              'medianTokenReduction',
            ),
            p95ContextWindowRatio: parseObservedNumber(
              execution.stdout,
              'p95ContextWindowRatio',
            ),
          },
        },
        contextBridgeAndRuntime: {
          machineAsserted: {
            summariesAreFirstClassContextMessages: true,
            latestTwoTurnsRemainExact: true,
            toolCallTopologyVerified: true,
            selectedSchemaBudgetChargedPerProviderCall: true,
            providerPlanningRunsEveryIteration: true,
            providerSeamCannotAccessUnplannedCanonicalHistory: true,
            finalAssistantIncludedInCompletedCheckpoint: true,
            completedCheckpointPassedToTransportCommit: true,
            pinnedOverflowFailsBeforeProvider: true,
            compactorCircuitScopedBySessionProviderEpoch: true,
            canonicalDeniedUnknownToolPairSelfHeals: true,
            unknownSuccessfulOrForgedToolHistoryFailsClosed: true,
          },
        },
        freshnessRepository: {
          adapter: 'file-backed node:sqlite with transactional CAS',
          machineAsserted: {
            concurrentCompetitions: 1_000,
            contendersPerCompetition: 2,
            committedWritersEquals: 1_000,
            staleWritersEquals: 1_000,
            mutationCallsEquals: 1_000,
            committedEffectsEquals: 1_000,
            outboxRowsEquals: 1_000,
            crossProjectWritesEquals: 0,
            tamperedReceiptAndExpectationRejected: true,
          },
        },
        productFreshnessCas: {
          machineAsserted: {
            certifiedNodeWrites: [
              'rename_node',
              'set_node_summary',
            ],
            readReceiptReturnedToProvider: true,
            expectedRevisionRequired: true,
            staleManualRaceMutationsEquals: 0,
            staleManualRaceOutboxRowsEquals: 0,
            duplicateAndCrossProjectExpectationsRejected: true,
            exactInverseGuardsThePostWriteRevision: true,
          },
        },
        checkpointV2: {
          adapter: 'file-backed node:sqlite restart',
          machineAsserted: {
            finalAssistantCommittedAtomically: true,
            restartRecoveryUsesVerifiedCanonicalHistory: true,
            outerHashTamperRejected: true,
            nestedTamperCases: 5,
            nestedTamperRejected: true,
            legacyV1CheckpointStillRecoverable: true,
            legacyV1IsStorageCompatibilityNotProviderFallback: true,
          },
        },
        redTeamP1Blockers: {
          machineAsserted: {
            providerRequestHasNoLegacyUnplannedFallback: true,
            largeSummaryMetadataIsChargedToContextBudget: true,
            threeThousandSourceSummaryFailsClosedWhenOverBudget: true,
            v2ToolArgumentsUseCanonicalRecursiveJson: true,
          },
        },
      },
      boundaries: {
        providerCallsRequired: false,
        anthropicRequired: false,
        writeCertification: [
          'rename_node',
          'set_node_summary',
        ],
        otherEntityObservations: 'empty',
        oversizedResultPaging:
          'durable SQLite result artifacts support project/session-scoped continuation paging across restart; chunk-bounded storage IO and product GC remain open',
        checkpointIntegrity:
          'unkeyed SHA-256 self-consistency, not authenticity against a local attacker who can rewrite payloads and all hashes',
        manualNativeSmoke: 'pending',
      },
      passed:
        processPassed &&
        vitest.success === true &&
        allGroupsPassed &&
        migration.passed,
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
      const diagnostics = execution.stderr || execution.stdout;
      if (diagnostics) process.stderr.write(diagnostics);
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runP4Acceptance(parseOptions(process.argv.slice(2)))
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
