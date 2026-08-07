import { describe, expect, it } from 'vitest';

import type { AgentToolContext } from '../tool-handlers';
import type { DbExecutor } from '../../../lib/db';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { buildDriftingAgentCapabilityManifest } from './drifting-agent-capability-manifest';
import {
  DRIFTING_AGENT_CONTEXT_PROFILE,
  DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
} from './drifting-agent-product-contract';
import {
  createDriftingAgentProductComposition,
  resolveDriftingBuiltInToolAccess,
} from './drifting-product-composition';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import { AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES } from './long-task-auto-continuation';
import { DEFAULT_AGENT_RUNTIME_LIMITS } from './runtime';
import {
  DRIFTING_DOMAIN_CRUD_CONTRACTS,
  DRIFTING_WORKSPACE_COMMAND_NAMES,
} from './drifting-workspace-tool-contract';
import type { AgentModelDriver, AgentRuntimeContext, AgentToolRuntime } from './types';

const projectId = 'capability-project';
const context: AgentRuntimeContext = {
  route: { kind: 'chat', projectId },
};
const toolContext = {
  projectId,
  write: {},
} as unknown as AgentToolContext;
const unusedDriver: AgentModelDriver = {
  id: 'capability-inspection',
  stream() {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error('Capability inspection must not call the provider');
          },
        };
      },
    };
  },
};

function definitionMap(runtime: AgentToolRuntime): Map<string, 'read' | 'write'> {
  return new Map(
    runtime.listDefinitions(context).map((definition) => [definition.name, definition.access]),
  );
}

describe('Drifting Agent capability manifest', () => {
  it('matches the final built-in product composition and executable ownership', () => {
    const manifest = buildDriftingAgentCapabilityManifest();
    const composition = createDriftingAgentProductComposition({
      driver: unusedDriver,
      getContext: () => toolContext,
    });
    const actual = definitionMap(composition.toolRuntime);
    const expected = new Map(
      manifest.installedModelTools.entries.map((tool) => [tool.name, tool.access]),
    );
    expect(actual).toEqual(expected);

    const owners = {
      'workspace-runtime': definitionMap(composition.workspaceTools),
      'drifting-runtime': definitionMap(composition.tools),
      'long-task-runtime': definitionMap(composition.longTaskTools),
    } as const;
    for (const tool of manifest.installedModelTools.entries) {
      expect(owners[tool.owner].get(tool.name)).toBe(tool.access);
      expect(Object.values(owners).filter((owner) => owner.has(tool.name))).toHaveLength(1);
      expect(resolveDriftingBuiltInToolAccess(tool.name)).toBe(tool.access);
    }
  });

  it('keeps totals and names derived from the same entries', () => {
    const manifest = buildDriftingAgentCapabilityManifest();
    const installed = manifest.installedModelTools.entries;
    const writes = manifest.directCatalogWrites;

    expect(new Set(installed.map((tool) => tool.name)).size).toBe(installed.length);
    expect(manifest.installedModelTools.total).toBe(installed.length);
    expect(manifest.installedModelTools.read).toBe(
      installed.filter((tool) => tool.access === 'read').length,
    );
    expect(manifest.installedModelTools.write).toBe(
      installed.filter((tool) => tool.access === 'write').length,
    );
    expect(writes.certified + writes.unavailable).toBe(writes.total);
    expect(writes.certifiedNames).toHaveLength(writes.certified);
    expect(writes.unavailableNames).toHaveLength(writes.unavailable);
  });

  it('keeps the long-task execution contract tied to executable runtime defaults', () => {
    const contract = buildDriftingAgentCapabilityManifest().longTaskExecution;
    expect(contract).toMatchObject({
      defaultTaskBudgets: 'unlimited',
      stopBoundary: 'after-current-tool',
      steeringBoundary: 'next-model-iteration-exactly-once',
      restartBehavior: 'durable-plan-manual-reauthorization',
      manifestPolicy: 'detect-explicitly-reconcile-before-completion',
      completionPolicy: 'current-manifest-plus-work-kind-evidence',
      automaticContinuationPrompts: 'model-visible-transcript-hidden',
      stagnantSliceWatchdog: AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES,
    });
    expect(
      [
        DEFAULT_AGENT_RUNTIME_LIMITS.maxModelIterations,
        DEFAULT_AGENT_RUNTIME_LIMITS.maxToolCalls,
        DEFAULT_AGENT_RUNTIME_LIMITS.maxInputTokens,
        DEFAULT_AGENT_RUNTIME_LIMITS.maxOutputTokens,
        DEFAULT_AGENT_RUNTIME_LIMITS.maxTotalTokens,
        DEFAULT_AGENT_RUNTIME_LIMITS.maxCostUsd,
        DEFAULT_AGENT_RUNTIME_LIMITS.maxDurationMs,
      ].every((limit) => limit === null),
    ).toBe(true);
  });

  it('publishes the executable provider, compaction, conflict, retrieval, and artifact contract', () => {
    const context = buildDriftingAgentCapabilityManifest().contextEngineering;
    expect(context).toMatchObject({
      providerProfile: DRIFTING_AGENT_CONTEXT_PROFILE,
      undeclaredProviderWindowTokens: DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
      compaction: {
        summarySchemaVersion: 1,
        constraintRetention: 'exact-source-hash-witness',
        conflictPolicy: 'no-runtime-write-gate-model-follows-current-author-guidance',
      },
      evidenceRetrieval: 'weighted-cjk-latin-relevance-with-freshness-provenance',
      resultArtifacts: 'sqlite-hash-verified-unicode-paging-across-restart',
    });
    expect(context.compaction.exactCitationKinds).toEqual([
      'canon_fact',
      'character_voice',
      'author_decision',
      'write_outcome',
      'task_progress',
      'unresolved',
    ]);
  });

  it('does not publish the removed user checkpoint or conversation-fork surface', () => {
    const manifest = buildDriftingAgentCapabilityManifest();
    expect(manifest.schemaVersion).toBe(17);
    expect(manifest.product).toMatchObject({
      contextWindowTokens: 200_000,
      maxContextWindowTokens: 1_000_000,
      concurrency: {
        admissionPolicy: 'unbounded-user-owned',
        activeTurnCardinality: 'one-per-conversation',
        projectScope: 'same-mounted-project',
        controlRouting: 'session-and-turn-scoped',
        readScheduling: 'concurrent',
        writeScheduling: 'shared-reader-writer-barrier',
        staleWritePolicy: 'revision-cas-stop-after-two-conflicts-per-target-turn',
        yjsCollaboratorIdentity: 'session-turn-call-origin',
        yjsRevisionProvenance: 'durable-per-revision-agent-user-remote-system-legacy',
        conflictAttribution: 'self-other-agent-user-mixed-external',
        restartBehavior: 'durable-plans-manual-resume-no-active-turn-replay',
      },
    });
    expect('userCheckpoint' in manifest).toBe(false);
    expect('authoredObjectFacade' in manifest).toBe(false);
  });

  it('publishes certified providers, concrete MCP transports, and exact durable grants', () => {
    const platform = buildDriftingAgentCapabilityManifest().providerExtensionPlatform;
    expect(platform.certifiedProviders.map((item) => item.provider)).toEqual([
      'deepseek',
      'anthropic',
      'openai',
    ]);
    expect(
      platform.certifiedProviders.find((item) => item.provider === 'openai')?.models,
    ).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-sol',
        wireContract: 'gpt-5.6-sol:responses-v1',
        thinkingModes: ['off', 'adaptive'],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }),
      expect.objectContaining({ id: 'gpt-5.6-terra' }),
      expect.objectContaining({ id: 'gpt-5.6-luna' }),
    ]);
    expect(platform).toMatchObject({
      mcpProtocolVersion: '2025-06-18',
      transports: ['stdio', 'streamable_http'],
      stdioTargets: 'desktop-only-native-child-host',
      httpTargets: 'desktop-ios-android-native-request-host',
      grants: 'exact-project-server-tool-schema-arguments-scope-durable-revocable',
      lifecycle: 'generation-isolated-no-tool-call-replay-fail-closed',
    });
  });

  it('publishes mobile build and resumable endurance acceptance without claiming device visuals', () => {
    const manifest = buildDriftingAgentCapabilityManifest();
    expect(manifest.nativeEnduranceAcceptance).toEqual({
      mobileBuilds: 'ios-aarch64-simulator-and-android-aarch64-debug',
      endurance: 'resumable-4h-16-epoch-and-12h-48-epoch-workload-equivalent',
      cadence: '15-logical-minutes-per-fresh-process-epoch',
      privateProse: 'read-only-never-persisted-in-report',
    });
    expect(manifest.deferredProductCapabilities).toContain(
      'native-interactive-device-visual-smoke',
    );
  });

  it('publishes author-owned writing policy without product content guards', () => {
    expect(buildDriftingAgentCapabilityManifest().authorControl).toEqual({
      productWritingDefaults: 'none',
      editorContextInjection: 'disabled',
      contentMutationScopeGuard: 'disabled',
      canonPatchGate: 'disabled',
      projectRules: 'author-editable-project-facts',
      standingGuidance: 'author-created-or-author-approved-active-memory',
      guidanceLifecycle: 'author-editable-and-deletable',
      executionSafety: 'data-integrity-review-and-author-configurable-destructive-confirmation',
    });
  });

  it('proves every declared domain lifecycle and hidden mutation has an executable strategy', () => {
    const manifest = buildDriftingAgentCapabilityManifest();
    const installedNames = new Set(manifest.installedModelTools.entries.map((tool) => tool.name));
    const matrixCommands = new Set<string>();
    const fakeFreshness = {} as AgentRuntimeFreshnessRepository;
    const fakeDatabase = {} as DbExecutor;

    for (const domain of DRIFTING_DOMAIN_CRUD_CONTRACTS) {
      for (const operation of Object.values(domain.operations)) {
        for (const providerTool of operation.providerTools) {
          expect(installedNames.has(providerTool)).toBe(true);
        }
        for (const command of operation.hiddenCommands) {
          matrixCommands.add(command);
          expect(
            getDriftingWriteStrategy(command, {
              freshness: fakeFreshness,
              elementPatchDb: fakeDatabase,
            }),
          ).toBeDefined();
        }
      }
      if (domain.domain !== 'project_facts') {
        expect(
          Object.values(domain.operations).every((operation) => operation.status === 'closed'),
        ).toBe(true);
      }
    }

    expect([...matrixCommands].sort()).toEqual([...DRIFTING_WORKSPACE_COMMAND_NAMES].sort());
    expect(manifest.domainCrud.totalDomains).toBe(DRIFTING_DOMAIN_CRUD_CONTRACTS.length);
    expect(manifest.domainCrud.closedLifecycleOperations).toBe(
      DRIFTING_DOMAIN_CRUD_CONTRACTS.reduce(
        (total, domain) =>
          total +
          Object.values(domain.operations).filter((operation) => operation.status === 'closed')
            .length,
        0,
      ),
    );
  });
});
