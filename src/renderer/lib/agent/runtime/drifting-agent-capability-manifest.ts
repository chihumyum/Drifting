import { AGENT_TOOL_CATALOG, getRegisteredTool, listProviderTools } from '../tool-registry';
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
  DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS,
  DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
} from './drifting-agent-product-contract';
import {
  DRIFTING_LITERARY_CONTEXT_SUMMARY_VERSION,
  DRIFTING_LITERARY_EVIDENCE_KINDS,
} from './literary-context-summary';
import {
  DRIFTING_DOMAIN_CRUD_CONTRACTS,
  DRIFTING_WORKSPACE_COMMAND_NAMES,
  DRIFTING_WORKSPACE_PROVIDER_TOOLS,
  DRIFTING_WORKSPACE_READ_TOOLS,
} from './drifting-workspace-tool-contract';
import {
  AGENT_LONG_TASK_EXECUTION_CONTRACT,
  AGENT_LONG_TASK_TOOL_CONTRACTS,
} from './long-task-tool-contract';
import { AGENT_USER_CHECKPOINT_CONTRACT } from './agent-user-checkpoint-contract';
import { AGENT_AUTHOR_CONTROL_CONTRACT } from './system-prompt';
import { AGENT_PROVIDER_OPTIONS } from './agent-provider-contract';
import { DRIFTING_MCP_PROTOCOL_VERSION } from './mcp-transport';

export const DRIFTING_AGENT_CAPABILITY_MANIFEST_SCHEMA_VERSION = 9 as const;

export type DriftingAgentToolOwner = 'workspace-runtime' | 'drifting-runtime' | 'long-task-runtime';

export type DriftingAgentToolSurface =
  | 'workspace-facade'
  | 'catalog-direct'
  | 'runtime-control'
  | 'long-task-runtime';

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
    contextWindowTokens: number;
    dynamicToolRegistration: 'project-scoped-runtime';
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
  workspaceFacade: {
    providerTools: string[];
    hiddenDomainOperations: string[];
  };
  domainCrud: {
    totalDomains: number;
    closedLifecycleOperations: number;
    entries: typeof DRIFTING_DOMAIN_CRUD_CONTRACTS;
  };
  longTaskTools: string[];
  longTaskExecution: typeof AGENT_LONG_TASK_EXECUTION_CONTRACT;
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
  userCheckpoint: typeof AGENT_USER_CHECKPOINT_CONTRACT;
  authorControl: typeof AGENT_AUTHOR_CONTROL_CONTRACT;
  providerExtensionPlatform: {
    certifiedProviders: Array<{ provider: string; models: string[] }>;
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
  const workspaceReadNames = new Set<string>(DRIFTING_WORKSPACE_READ_TOOLS);
  const workspaceEntries = DRIFTING_WORKSPACE_PROVIDER_TOOLS.map((name) =>
    catalogCapability(
      requiredCatalogTool(name),
      workspaceReadNames.has(name) ? 'workspace-runtime' : 'drifting-runtime',
      'workspace-facade',
    ),
  );
  const directEntries = listProviderTools({ allowWrite: true }).map((tool) =>
    catalogCapability(tool, 'drifting-runtime', 'catalog-direct'),
  );
  const controlEntries = RUNTIME_CONTROL_TOOL_NAMES.map((name) =>
    catalogCapability(requiredCatalogTool(name), 'drifting-runtime', 'runtime-control'),
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
  const installed = [
    ...workspaceEntries,
    ...directEntries,
    ...controlEntries,
    ...longTaskEntries,
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
      contextWindowTokens: DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS,
      dynamicToolRegistration: 'project-scoped-runtime',
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
    workspaceFacade: {
      providerTools: [...DRIFTING_WORKSPACE_PROVIDER_TOOLS],
      hiddenDomainOperations: [...DRIFTING_WORKSPACE_COMMAND_NAMES],
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
    userCheckpoint: AGENT_USER_CHECKPOINT_CONTRACT,
    authorControl: AGENT_AUTHOR_CONTROL_CONTRACT,
    providerExtensionPlatform: {
      certifiedProviders: AGENT_PROVIDER_OPTIONS.map((provider) => ({
        provider: provider.value,
        models: provider.models.map((model) => model.value),
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
