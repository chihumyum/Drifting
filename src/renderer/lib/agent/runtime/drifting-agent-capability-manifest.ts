import { AGENT_TOOL_CATALOG, getRegisteredTool } from '../tool-registry';
import type {
  AgentToolAccess,
  AgentToolApproval,
  AgentToolCertification,
  AgentToolEffect,
  AgentToolRevertStrategy,
  AgentToolRisk,
  RegisteredTool,
} from '../tool-registry.types';
import {
  DRIFTING_AGENT_CONTEXT_PROFILE,
  DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
} from './drifting-agent-product-contract';
import {
  DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION,
  DRIFTING_LITERARY_EVIDENCE_KINDS,
} from './literary-context-summary';
import {
  DRIFTING_DOMAIN_CRUD_CONTRACTS,
  DRIFTING_DOMAIN_PROVIDER_TOOLS,
  DRIFTING_DOMAIN_READ_TOOLS,
  DRIFTING_WORKSPACE_COMMAND_NAMES,
} from './drifting-workspace-tool-contract';
import {
  AGENT_LONG_TASK_EXECUTION_CONTRACT,
  AGENT_LONG_TASK_TOOL_CONTRACTS,
} from './long-task-tool-contract';
import { AGENT_AUTHOR_CONTROL_CONTRACT } from './system-prompt';
import { AGENT_PROVIDER_OPTIONS } from './agent-provider-contract';
import { DRIFTING_MCP_PROTOCOL_VERSION } from './mcp-transport';
import { DRIFTING_AGENT_CONCURRENCY_CONTRACT } from './agent-concurrency-contract';
import {
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';
import { TOOL_SEARCH, CALL_TOOL } from './tool-discovery';
import { AGENT_RUNTIME_TOOL_SEARCH_LIMIT } from './types';

export const DRIFTING_AGENT_CAPABILITY_MANIFEST_SCHEMA_VERSION = 22 as const;

export type DriftingAgentToolOwner =
  | 'workspace-runtime'
  | 'drifting-runtime'
  | 'long-task-runtime'
  | 'working-memory-runtime';

export type DriftingAgentToolSurface =
  | 'domain-tools'
  | 'runtime-control'
  | 'long-task-runtime'
  | 'working-memory-runtime';

export interface DriftingAgentInstalledToolCapability {
  name: string;
  access: AgentToolAccess;
  owner: DriftingAgentToolOwner;
  surface: DriftingAgentToolSurface;
  certification: AgentToolCertification | 'runtime-certified';
  risk: AgentToolRisk | 'runtime-owned';
  effect: AgentToolEffect | 'task-state';
  approval: AgentToolApproval | 'runtime-owned';
  revertStrategy: AgentToolRevertStrategy | 'runtime-owned';
}

export interface DriftingAgentCapabilityManifest {
  schemaVersion: typeof DRIFTING_AGENT_CAPABILITY_MANIFEST_SCHEMA_VERSION;
  source: 'drifting-final-product-contract';
  product: {
    runtimeHost: 'tauri-renderer';
    providerNeutralProtocol: true;
    contextWindowPolicy: 'model-declared';
    dynamicToolRegistration: 'project-scoped-runtime';
    concurrency: typeof DRIFTING_AGENT_CONCURRENCY_CONTRACT;
  };
  installedModelTools: {
    total: number;
    read: number;
    write: number;
    entries: DriftingAgentInstalledToolCapability[];
  };
  directCatalogWrites: {
    total: number;
    certified: number;
    unavailable: number;
    certifiedNames: string[];
    unavailableNames: string[];
  };
  domainToolSurface: {
    providerTools: string[];
    hiddenDomainOperations: string[];
  };
  toolSelection: {
    authorPreference: 'agent-tool-search-off-auto-on-default-auto';
    offMode: 'complete-installed-surface-stable-per-iteration';
    discoveryMode: 'model-requested-schemas-in-tool-results';
    providerEntrypoints: readonly string[];
    runtimeHardLimit: number;
    writePrerequisiteReads: 'complete-directory-discovery-preserves-original-validation';
    alwaysAvailable: readonly [
      'complete-authorized-tool-directory',
      'schema-lookup-and-pagination-through-tool_search',
      'canonical-permissions-and-write-receipts',
      'stable-tool-prefix-through-synthesis',
    ];
    promptCaching: 'fixed-tools-directory-and-dispatch-schemas-results-append-to-context';
  };
  domainCrud: {
    totalDomains: number;
    closedLifecycleOperations: number;
    entries: typeof DRIFTING_DOMAIN_CRUD_CONTRACTS;
  };
  longTaskTools: string[];
  longTaskExecution: typeof AGENT_LONG_TASK_EXECUTION_CONTRACT;
  workingMemory: {
    format: 'single-rolling-markdown';
    filename: 'WORKING_MEMORY.md';
    scope: 'project-shared-general-agent-conversations';
    lifecycle: 'turn-start-injection-and-on-demand-important-updates';
    compaction: 'soft-6000-hard-8000-oldest-first-retirement';
    concurrency: 'sqlite-revision-cas';
    sync: 'device-local-excluded-from-sync';
  };
  contextEngineering: {
    providerProfile: typeof DRIFTING_AGENT_CONTEXT_PROFILE;
    undeclaredProviderWindowTokens: number;
    compaction: {
      summarySchemaVersion: number;
      exactCitationKinds: readonly string[];
      constraintRetention: 'exact-source-hash-witness';
      conflictPolicy: 'no-runtime-write-gate-model-follows-current-author-guidance';
    };
    evidenceRetrieval: 'weighted-cjk-latin-relevance-with-freshness-provenance';
    resultArtifacts: 'sqlite-hash-verified-unicode-paging-across-restart';
  };
  authorControl: typeof AGENT_AUTHOR_CONTROL_CONTRACT;
  providerExtensionPlatform: {
    subscriptionModelDiscovery: {
      provider: 'openai-codex';
      catalog: string;
      refresh: string;
      cache: string;
      fallback: string;
      savedSelection: string;
      outputBudget: string;
      acceptance: string;
    };
    certifiedProviders: Array<{
      provider: string;
      models: Array<{
        id: string;
        wireContract: string;
        thinkingModes: string[];
        efforts: string[];
      }>;
    }>;
    mcpProtocolVersion: string;
    transports: readonly ['stdio', 'streamable_http'];
    stdioTargets: 'desktop-only-native-child-host';
    httpTargets: 'desktop-ios-android-native-request-host';
    configuration: 'project-scoped-settings-with-health-reconnect-disable';
    secrets: 'provider-and-extension-secrets-in-native-keychain';
    grants: 'exact-project-server-tool-schema-arguments-scope-durable-revocable';
    lifecycle: 'generation-isolated-no-tool-call-replay-fail-closed';
  };
  nativeEnduranceAcceptance: {
    mobileBuilds: 'ios-aarch64-simulator-and-android-aarch64-debug';
    endurance: 'resumable-4h-16-epoch-and-12h-48-epoch-workload-equivalent';
    cadence: '15-logical-minutes-per-fresh-process-epoch';
    privateProse: 'read-only-never-persisted-in-report';
  };
  deferredProductCapabilities: string[];
}

const RUNTIME_CONTROL_TOOL_NAMES = ['ask_user', 'read_tool_result'] as const;

function catalogCapability(
  tool: RegisteredTool,
  owner: DriftingAgentToolOwner,
  surface: DriftingAgentToolSurface,
): DriftingAgentInstalledToolCapability {
  return {
    name: tool.name,
    access: tool.access,
    owner,
    surface,
    certification: tool.certification,
    risk: tool.risk,
    effect: tool.effect,
    approval: tool.approval,
    revertStrategy: tool.revertStrategy,
  };
}

function requiredCatalogTool(name: string): RegisteredTool {
  const tool = getRegisteredTool(name);
  if (!tool || tool.name !== name) {
    throw new Error(`Agent capability contract references missing canonical tool "${name}"`);
  }
  return tool;
}

function assertUniqueInstalledNames(
  entries: readonly DriftingAgentInstalledToolCapability[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Agent capability contract installs tool "${entry.name}" more than once`);
    }
    seen.add(entry.name);
  }
}

/**
 * Deterministic, Node-loadable projection of the final built-in product
 * composition. A Vitest acceptance test compares it with the actual composed
 * runtimes so this pure projection cannot silently become a second registry.
 */
export function buildDriftingAgentCapabilityManifest(): DriftingAgentCapabilityManifest {
  const domainReadNames = new Set<string>(DRIFTING_DOMAIN_READ_TOOLS);
  const domainEntries = DRIFTING_DOMAIN_PROVIDER_TOOLS.map((name) =>
    catalogCapability(
      requiredCatalogTool(name),
      domainReadNames.has(name) ? 'workspace-runtime' : 'drifting-runtime',
      'domain-tools',
    ),
  );
  const controlEntries = RUNTIME_CONTROL_TOOL_NAMES.map((name) =>
    catalogCapability(requiredCatalogTool(name), 'workspace-runtime', 'runtime-control'),
  );
  const longTaskEntries: DriftingAgentInstalledToolCapability[] =
    AGENT_LONG_TASK_TOOL_CONTRACTS.map((tool) => ({
      name: tool.name,
      access: tool.access,
      owner: 'long-task-runtime',
      surface: 'long-task-runtime',
      certification: 'runtime-certified',
      risk: 'runtime-owned',
      effect: 'task-state',
      approval: 'runtime-owned',
      revertStrategy: 'runtime-owned',
    }));
  const workingMemoryEntries = [
    AGENT_WORKING_MEMORY_READ_TOOL,
    AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  ].map((name) =>
    catalogCapability(
      requiredCatalogTool(name),
      'working-memory-runtime',
      'working-memory-runtime',
    ),
  );
  const installed = [
    ...domainEntries,
    ...controlEntries,
    ...longTaskEntries,
    ...workingMemoryEntries,
  ].sort((left, right) => left.name.localeCompare(right.name, 'en'));
  assertUniqueInstalledNames(installed);

  const directCatalogWrites = AGENT_TOOL_CATALOG.filter(
    (tool) => tool.scope === 'general' && tool.access === 'write',
  );
  const certifiedWrites = directCatalogWrites
    .filter((tool) => tool.certification === 'write-certified')
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const unavailableWrites = directCatalogWrites
    .filter((tool) => tool.certification === 'unavailable')
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (certifiedWrites.length + unavailableWrites.length !== directCatalogWrites.length) {
    throw new Error('General Agent write catalog contains an unclassified certification state');
  }

  return {
    schemaVersion: DRIFTING_AGENT_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    source: 'drifting-final-product-contract',
    product: {
      runtimeHost: 'tauri-renderer',
      providerNeutralProtocol: true,
      contextWindowPolicy: 'model-declared',
      dynamicToolRegistration: 'project-scoped-runtime',
      concurrency: DRIFTING_AGENT_CONCURRENCY_CONTRACT,
    },
    installedModelTools: {
      total: installed.length,
      read: installed.filter((tool) => tool.access === 'read').length,
      write: installed.filter((tool) => tool.access === 'write').length,
      entries: installed,
    },
    directCatalogWrites: {
      total: directCatalogWrites.length,
      certified: certifiedWrites.length,
      unavailable: unavailableWrites.length,
      certifiedNames: certifiedWrites,
      unavailableNames: unavailableWrites,
    },
    domainToolSurface: {
      providerTools: [...DRIFTING_DOMAIN_PROVIDER_TOOLS],
      hiddenDomainOperations: [...DRIFTING_WORKSPACE_COMMAND_NAMES],
    },
    toolSelection: {
      authorPreference: 'agent-tool-search-off-auto-on-default-auto',
      offMode: 'complete-installed-surface-stable-per-iteration',
      discoveryMode: 'model-requested-schemas-in-tool-results',
      providerEntrypoints: [TOOL_SEARCH, CALL_TOOL],
      runtimeHardLimit: AGENT_RUNTIME_TOOL_SEARCH_LIMIT,
      writePrerequisiteReads:
        'complete-directory-discovery-preserves-original-validation',
      alwaysAvailable: [
        'complete-authorized-tool-directory',
        'schema-lookup-and-pagination-through-tool_search',
        'canonical-permissions-and-write-receipts',
        'stable-tool-prefix-through-synthesis',
      ],
      promptCaching:
        'fixed-tools-directory-and-dispatch-schemas-results-append-to-context',
    },
    domainCrud: {
      totalDomains: DRIFTING_DOMAIN_CRUD_CONTRACTS.length,
      closedLifecycleOperations: DRIFTING_DOMAIN_CRUD_CONTRACTS.reduce(
        (total, domain) =>
          total +
          Object.values(domain.operations).filter((operation) => operation.status === 'closed')
            .length,
        0,
      ),
      entries: DRIFTING_DOMAIN_CRUD_CONTRACTS,
    },
    longTaskTools: AGENT_LONG_TASK_TOOL_CONTRACTS.map((tool) => tool.name),
    longTaskExecution: AGENT_LONG_TASK_EXECUTION_CONTRACT,
    workingMemory: {
      format: 'single-rolling-markdown',
      filename: 'WORKING_MEMORY.md',
      scope: 'project-shared-general-agent-conversations',
      lifecycle: 'turn-start-injection-and-on-demand-important-updates',
      compaction: 'soft-6000-hard-8000-oldest-first-retirement',
      concurrency: 'sqlite-revision-cas',
      sync: 'device-local-excluded-from-sync',
    },
    contextEngineering: {
      providerProfile: DRIFTING_AGENT_CONTEXT_PROFILE,
      undeclaredProviderWindowTokens: DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
      compaction: {
        summarySchemaVersion: DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION,
        exactCitationKinds: DRIFTING_LITERARY_EVIDENCE_KINDS,
        constraintRetention: 'exact-source-hash-witness',
        conflictPolicy: 'no-runtime-write-gate-model-follows-current-author-guidance',
      },
      evidenceRetrieval: 'weighted-cjk-latin-relevance-with-freshness-provenance',
      resultArtifacts: 'sqlite-hash-verified-unicode-paging-across-restart',
    },
    authorControl: AGENT_AUTHOR_CONTROL_CONTRACT,
    providerExtensionPlatform: {
      subscriptionModelDiscovery: {
        provider: 'openai-codex',
        catalog: 'native-account-scoped-codex-models',
        refresh: 'sign-in-account-change-composer-menu-focus-online',
        cache: 'memory-only-five-minutes-with-stale-response-fencing',
        fallback: 'last-successful-account-catalog-then-bundled-models',
        savedSelection: 'preserved-across-restart-and-discovery-failure',
        outputBudget: 'provider-controlled-no-client-cap;unknown-ceilings-null;input-reserve-is-not-output-limit',
        acceptance: 'synthetic-catalog-and-native-projection-tests;live-account-unverified',
      },
      certifiedProviders: AGENT_PROVIDER_OPTIONS.map((provider) => ({
        provider: provider.value,
        models: provider.models.map((model) => ({
          id: model.value,
          wireContract: model.context.id,
          thinkingModes: [...model.reasoning.thinkingModes],
          efforts: [...model.reasoning.efforts],
        })),
      })),
      mcpProtocolVersion: DRIFTING_MCP_PROTOCOL_VERSION,
      transports: ['stdio', 'streamable_http'],
      stdioTargets: 'desktop-only-native-child-host',
      httpTargets: 'desktop-ios-android-native-request-host',
      configuration: 'project-scoped-settings-with-health-reconnect-disable',
      secrets: 'provider-and-extension-secrets-in-native-keychain',
      grants: 'exact-project-server-tool-schema-arguments-scope-durable-revocable',
      lifecycle: 'generation-isolated-no-tool-call-replay-fail-closed',
    },
    nativeEnduranceAcceptance: {
      mobileBuilds: 'ios-aarch64-simulator-and-android-aarch64-debug',
      endurance: 'resumable-4h-16-epoch-and-12h-48-epoch-workload-equivalent',
      cadence: '15-logical-minutes-per-fresh-process-epoch',
      privateProse: 'read-only-never-persisted-in-report',
    },
    deferredProductCapabilities: [
      'native-interactive-device-visual-smoke',
      'subagent-orchestration',
    ],
  };
}
