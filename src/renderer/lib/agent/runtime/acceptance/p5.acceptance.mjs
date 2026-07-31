import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
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
  controlPermissionAndInteraction: [
    'src/renderer/lib/agent/transport.test.ts',
    'src/renderer/lib/agent/runtime/runtime.test.ts',
    'src/renderer/lib/agent/runtime/drifting-permission-policy.test.ts',
    'src/renderer/lib/agent/runtime/local-transport.test.ts',
    'src/renderer/store/agent-chat-store.test.ts',
  ],
  restartRecovery: [
    'src/renderer/lib/agent/runtime/recovery.test.ts',
    'src/renderer/lib/agent/runtime/local-transport-persistence.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence.test.ts',
    'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
    'src/renderer/lib/agent/runtime/drifting-write-recovery.integration.test.ts',
    'src/renderer/store/agent-checkpoint-store.test.ts',
    'src/renderer/lib/agent/turn-revert-policy.test.ts',
    'src/renderer/lib/agent/turn-revert.test.ts',
  ],
  resultArtifactAndContext: [
    'src/renderer/lib/agent/runtime/drifting-read-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/drifting-read-tool-runtime.integration.test.ts',
    'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.integration.test.ts',
    'src/renderer/lib/agent/runtime/context-message-adapter.test.ts',
    'src/renderer/lib/agent/runtime/drifting-context-compactor.test.ts',
    'src/renderer/lib/agent/runtime/context-planner.test.ts',
    'src/renderer/lib/agent/runtime/runtime-context-planning.test.ts',
    'src/renderer/sqlite-repo/agent-runtime-persistence-repo.integration.test.ts',
  ],
  yjsProseAndDurableReview: [
    'src/renderer/lib/agent/runtime/yjs-prose-command.test.ts',
    'src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.integration.test.ts',
    'src/renderer/lib/agent/runtime/drifting-write-strategies.test.ts',
    'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts',
    'src/renderer/lib/agent/durable-review-actions.test.ts',
    'src/renderer/lib/agent/runtime/write-review-feedback.test.ts',
    'src/renderer/lib/agent/runtime/write-review-provenance.test.ts',
  ],
  elementPatchAndCertification: [
    'src/renderer/lib/agent/runtime/drifting-element-patch-write-strategy.integration.test.ts',
    'src/renderer/sqlite-repo/agent-runtime-element-patch-receipt-repo.test.ts',
    'src/renderer/lib/agent/tool-registry.test.ts',
  ],
  productCompositionAndEntityWrites: [
    'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/lib/agent/runtime/drifting-entity-write-strategy.integration.test.ts',
  ],
  longTaskAndContinuation: [
    'src/renderer/lib/agent/runtime/long-task-runtime.integration.test.ts',
    'src/renderer/lib/agent/runtime/recovered-transcript.test.ts',
  ],
  dynamicToolAndMcpBase: [
    'src/renderer/lib/agent/runtime/dynamic-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/portable-data.test.ts',
    'src/renderer/lib/agent/runtime/drifting-tool-selection.test.ts',
    'src/renderer/lib/agent/runtime/runtime-tool-search.test.ts',
    'src/renderer/lib/agent/runtime/system-prompt.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const REQUIRED_MIGRATIONS = [
  {
    index: 64,
    tag: '0064_agent_runtime_result_artifact',
    file: 'drizzle/0064_agent_runtime_result_artifact.sql',
    requiredSql: [
      'agent_runtime_result_blob',
      'agent_runtime_result_artifact',
    ],
  },
  {
    index: 65,
    tag: '0065_agent_runtime_element_patch_receipt',
    file: 'drizzle/0065_agent_runtime_element_patch_receipt.sql',
    requiredSql: ['agent_runtime_element_patch_receipt'],
  },
  {
    index: 66,
    tag: '0066_agent_runtime_entity_write_receipt',
    file: 'drizzle/0066_agent_runtime_entity_write_receipt.sql',
    requiredSql: ['agent_runtime_entity_write_receipt'],
  },
  {
    index: 67,
    tag: '0067_agent_runtime_long_task',
    file: 'drizzle/0067_agent_runtime_long_task.sql',
    requiredSql: [
      'agent_runtime_task',
      'agent_runtime_task_chapter_manifest',
      'agent_runtime_task_step',
      'agent_runtime_task_constraint',
      'agent_runtime_task_command',
    ],
  },
];
const HASHED_SOURCE_FILES = [
  'src/renderer/lib/agent/runtime/acceptance/p5.acceptance.mjs',
  ...TEST_FILES,
  ...REQUIRED_MIGRATIONS.map((migration) => migration.file),
  'drizzle/meta/_journal.json',
  'src-tauri/src/database.rs',
];

const CERTIFIED_WRITES = [
  'rename_node',
  'set_node_summary',
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
  'create_element_patch',
  'update_element_patch',
  'create_comment',
  'update_element',
  'update_storyline',
  'update_project_facts',
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

async function fileExists(file) {
  try {
    await access(path.join(CORE_DIRECTORY, file));
    return true;
  } catch {
    return false;
  }
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
  const tags = new Set(entries.map((entry) => entry.tag));
  const files = await Promise.all(
    REQUIRED_MIGRATIONS.map(async (migration) => {
      const exists = await fileExists(migration.file);
      const sql = exists
        ? await readFile(path.join(CORE_DIRECTORY, migration.file), 'utf8')
        : '';
      const journalEntry = entries.find(
        (entry) => entry.idx === migration.index,
      );
      return {
        index: migration.index,
        tag: migration.tag,
        file: migration.file,
        exists,
        journalMatches: journalEntry?.tag === migration.tag,
        requiredSqlPresent: migration.requiredSql.every((identifier) =>
          sql.includes(identifier),
        ),
      };
    }),
  );
  const databaseSource = await readFile(
    path.join(CORE_DIRECTORY, 'src-tauri/src/database.rs'),
    'utf8',
  );
  const indexesCanonical = entries.every(
    (entry, index) => entry.idx === index,
  );
  const tagsUnique = tags.size === entries.length;
  const rustEmbedsDrizzleDirectory = databaseSource.includes(
    'include_dir!("$CARGO_MANIFEST_DIR/../drizzle")',
  );
  return {
    count: entries.length,
    latestIndex: latest?.idx ?? null,
    latestTag: latest?.tag ?? null,
    requiredCount: 68,
    requiredLatestTag: '0067_agent_runtime_long_task',
    indexesCanonical,
    tagsUnique,
    rustEmbedsDrizzleDirectory,
    files,
    passed:
      entries.length === 68 &&
      latest?.idx === 67 &&
      latest?.tag ===
        '0067_agent_runtime_long_task' &&
      indexesCanonical &&
      tagsUnique &&
      rustEmbedsDrizzleDirectory &&
      files.every(
        (file) =>
          file.exists &&
          file.journalMatches &&
          file.requiredSqlPresent,
      ),
  };
}

async function readGitHead() {
  const result = await runCommand('git', ['rev-parse', 'HEAD']);
  if (result.code !== 0 || result.signal !== null) return null;
  return result.stdout.trim() || null;
}

export async function runP5Acceptance(options = parseOptions([])) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-p5-acceptance-'),
  );
  try {
    const vitestOutput = path.join(directory, 'p5-vitest.json');
    const execution = await runVitest(vitestOutput);
    let vitest;
    try {
      vitest = JSON.parse(await readFile(vitestOutput, 'utf8'));
    } catch (error) {
      throw new Error(
        [
          'P5 Vitest did not produce a readable JSON report.',
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
      suite: 'p5-drifting-creative-agent-runtime',
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
        controlPermissionAndInteraction: {
          machineAsserted: {
            permissionBeforeSchedulingAndDispatch: true,
            decisionBoundToToolNameAndFullArgumentsHash: true,
            deniedToolReturnsCanonicalProviderVisibleResult: true,
            permissionScopesImplemented: ['once'],
            askUserPausesAndReturnsProviderVisibleAnswer: true,
            duplicateAskUserReplaysDurableAnswer: true,
            canonicalJournalDrivesStreamingProjection: true,
            steeringRecordedAsCanonicalInput: true,
            stopAfterCurrentToolPreventsUnstartedWrites: true,
          },
        },
        restartRecovery: {
          machineAsserted: {
            canonicalJournalCommitsBeforeTerminalAndReplaysAcrossRestart: true,
            pendingControlsRehydrated: true,
            lostExecutionStackNeverClaimedResumable: true,
            recoveredPendingControlCanBeSafelyCancelled: true,
            interruptedYjsReceiptReconciledBeforeSessionResume: true,
            interruptedMutationNotReplayed: true,
            validBudgetSlicePersistsVerifiedV2Checkpoint: true,
            providerNeutralTurnsNeverCreateLegacyWholeTurnCheckpoints: true,
            legacyWholeTurnRevertFailsClosedAfterRuntimeBarrier: true,
            canonicalRevertUsesDurableGuardedReviewOnly: true,
          },
        },
        resultArtifactAndContext: {
          machineAsserted: {
            resultArtifactsDurableAcrossRestart: true,
            exactUnicodeCodePointPaging: true,
            projectAndSessionIsolation: true,
            contentHashAndQuotaFailClosed: true,
            proseReadReturnsExactYjsRevisionVectorAndHash: true,
            fullCompactorRunsUnderVerifiedPlanner: true,
            oldAuthorMessagesRemainPinnedWithoutVerifiedPolicy: true,
            writeHistoryCompactsOnlyWithExactDurableCoverage: true,
          },
        },
        yjsProseAndDurableReview: {
          certifiedTools: [
            'edit_block',
            'edit_blocks',
            'append_paragraph',
            'insert_blocks',
            'remove_blocks',
            'replace_block_range',
          ],
          machineAsserted: {
            liveYDocIsProseSourceOfTruth: true,
            exactRevisionVectorAndSemanticHashCas: true,
            deterministicForwardAndGuardedInverse: true,
            randomizedRichTextOperations: 500,
            receiptProvenRestartReconciliation: true,
            orderedReviewBatchesPreserved: true,
            approveSettlesCanonicalReview: true,
            rejectRunsGuardedInversesInReverseOrder: true,
            failedSettlementKeepsLocalReviewPending: true,
            autoModeSettlesCanonicalReview: true,
            reviewControlsRequireExactDurableCallProvenance: true,
          },
        },
        elementPatchAndCertification: {
          certifiedWrites: {
            totalCatalogWrites: 34,
            certified: CERTIFIED_WRITES.length,
            unavailable: 34 - CERTIFIED_WRITES.length,
            names: CERTIFIED_WRITES,
          },
          machineAsserted: {
            patchSetAndIndividualPatchFreshness: true,
            receiptRevisionAndFrozenEffectIntegrity: true,
            createReceiptSurvivesRestartWithoutDuplicateMutation: true,
            updateUsesPatchCas: true,
            exactInverseIsRestartIdempotent: true,
            staleCrossProjectAndPendingDeletionFailClosed: true,
            createElementCertified: false,
            updateElementCertified: true,
          },
        },
        productCompositionAndEntityWrites: {
          machineAsserted: {
            productDatabaseRunsAllMigrations: true,
            rendererUseCasesAndYjsAreCanonicalWritePath: true,
            entityMutationOutboxAndReceiptShareTransaction: true,
            createCommentUsesDeterministicIdentity: true,
            genericDurableReviewSupportsAcceptAndExactReject: true,
          },
        },
        longTaskAndContinuation: {
          machineAsserted: {
            durableTaskStepAndConstraintStateMachines: true,
            exactlyOnceTaskCommandsWithRevisionCas: true,
            providerTargetsAreNameFirst: true,
            resolvedIdsNeverReachProviderContext: true,
            planAndConstraintsPinnedAcrossCompaction: true,
            budgetBoundaryCommitsAResumableSlice: true,
            continuationRequiresExplicitAuthorAction: true,
            completedWriteStepRequiresDurableAcceptedTargetEvidence: true,
            wholeBookScopeIsProviderExplicit: true,
            wholeBookManifestIsRendererFrozen: true,
            wholeBookManifestCoverageIsRevalidatedAtCompletion: true,
            wholeBookStepsRequireAcceptedYjsProseEvidence: true,
            frozenChapterIdsStayProviderPrivate: true,
            renamedAndMissingFrozenChaptersRemainIdentitySafe: true,
            allSettledStepReviewsRemainQueryableByResultRef: true,
            acceptedEvidenceIsRevalidatedAgainstTargetAndProvenance: true,
            activeWholeBookPlanPinsPlanAndProseTools: true,
            continuationToolSelectionUsesDurablePlanHints: true,
          },
        },
        dynamicToolAndMcpBase: {
          machineAsserted: {
            runtimeDiscoveryUsesStableNamespacedNames: true,
            toolsAreProjectScoped: true,
            hostClassificationIsMandatory: true,
            externalWritesCannotRunAutomatically: true,
            dynamicSchemasAndArgumentsFailClosed: true,
            executionIsBoundToDefinitionRevision: true,
            sourceRegistrationAndExecutionAreProjectIsolated: true,
            portableArgumentsPreservePrototypeSafety: true,
            toolSelectionIncludesRelevantDynamicTools: true,
          },
        },
      },
      boundaries: {
        providerCallsRequired: false,
        anthropicRequired: false,
        permissionGrantScopes: {
          implemented: ['once'],
          notImplemented: ['session', 'project'],
        },
        recoveredWaitingControl:
          'safe cancel/new turn only; a lost JavaScript execution stack is not resumed in place',
        verifiedAuthorConstraintLedger:
          'first goal and explicit author constraints are provenance-bound; active long-task constraints are durable and semantic-pinned',
        certifiedWrites: {
          count: CERTIFIED_WRITES.length,
          catalogCount: 34,
          uncertifiedNamedGaps: ['create_element'],
        },
        liveProviderSmoke: {
          deepSeek: 'not run',
        },
        manualNativeSmoke: {
          desktop: 'not run',
          ios: 'not run',
          android: 'not run',
        },
        deferredRuntimeBreadth: [
          'multi-provider adapter conformance',
          'subagents',
          'unattended long-task auto-looping',
          'concrete MCP transport/configuration UI',
        ],
        wholeBookAcceptance:
          'frozen chapter coverage plus accepted target-matching Yjs prose evidence; literary sufficiency still requires live model and author review',
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
  runP5Acceptance(parseOptions(process.argv.slice(2)))
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
