import { and, eq } from 'drizzle-orm';

import type { GeneralAgentAuthStatus } from '../protocol';
import { isChapter } from '../../../domain/book-node';
import { getActiveAgentToolContext, type AgentToolContext } from '../tool-handlers';
import { AGENT_TOOL_CATALOG } from '../tool-registry';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createElementPatchRepository } from '../../../sqlite-repo/element-patch-repo';
import { createAgentMemoryRepository } from '../../../sqlite-repo/agent-memory-repo';
import {
  createAgentRuntimeElementPatchReceiptRepository,
  type AgentRuntimeElementPatchReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-element-patch-receipt-repo';
import {
  createAgentRuntimeFreshnessRepository,
  type AgentRuntimeFreshnessRepository,
} from '../../../sqlite-repo/agent-runtime-freshness-repo';
import {
  createAgentRuntimePersistenceRepository,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  createAgentRuntimeResultArtifactRepository,
  type AgentRuntimeResultArtifactRepository,
} from '../../../sqlite-repo/agent-runtime-result-artifact-repo';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import {
  createAgentRuntimeLongTaskRepository,
  type AgentRuntimeLongTaskRepository,
} from '../../../sqlite-repo/agent-runtime-long-task-repo';
import {
  createAgentExtensionRepository,
  type AgentExtensionRepository,
} from '../../../sqlite-repo/agent-extension-repo';
import { getDb, type DbClient } from '../../../lib/db';
import { BookElementTable, ElementCategoryTable, StorylineTable } from '../../../schema/drizzle';
import { proseDocId, type ProseEntityType } from '../../yjs-doc-id';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { createDriftingContextCompactor } from './drifting-context-compactor';
import { createDriftingAgentPermissionPolicy } from './drifting-permission-policy';
import { createDurableAgentContextSummaryHook } from './durable-context-memory';
import {
  CompositeAgentToolRuntime,
  createDynamicAwareAgentPermissionPolicy,
  DynamicAgentToolRegistry,
} from './dynamic-tool-runtime';
import { DriftingReadToolRuntime } from './drifting-read-tool-runtime';
import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import {
  createDriftingWriteToolRuntime,
  resolveDriftingCertifiedToolAccess,
  type DriftingWriteToolRuntime,
} from './drifting-write-tool-runtime';
import { DriftingAgentModelDriver } from './drivers';
import { createLocalGeneralAgentTransport, type RuntimeIdKind } from './local-transport';
import { createAgentLongTaskSupplementalRowsHook } from './long-task-context';
import {
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
  AgentLongTaskToolRuntime,
  createAgentLongTaskAwarePermissionPolicy,
  resolveAgentLongTaskToolAccess,
} from './long-task-tool-runtime';
import { createRepositoryAgentTransportPersistence } from './repository-transport-persistence';
import { identifyExplicitAgentUserConstraints } from './runtime-context-planning';
import type {
  AgentJournalSink,
  AgentModelDriver,
  AgentRuntimeLimits,
  AgentToolRuntime,
} from './types';

const DRIFTING_AGENT_FULL_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const DRIFTING_AGENT_COMPACTION_REDUCTION_RATIO = 0.85;
const DRIFTING_AGENT_MAX_PROVIDER_SUMMARY_CHUNKS = 2;
const DRIFTING_AGENT_COMPACTION_CHUNK_INPUT_TOKENS = 64_000;
import { createYjsProseSeedState } from './yjs-prose-command';
import {
  createYjsProsePersistenceCoordinator,
  type YjsProsePersistenceCoordinator,
} from './yjs-prose-persistence-coordinator';
import {
  loadAgentAuthoredReadProgressContextRows,
  loadAgentDurableWriteReceiptContextRows,
  loadAgentWriteReviewContextRows,
} from './write-review-feedback';
import type { GeneralAgentTransport } from '../transport';
import { DriftingWorkspaceToolRuntime } from './drifting-workspace-tool-runtime';
import {
  requestedDriftingAgentContextWindowTokens,
  resolveDriftingAgentContextProfile,
} from './drifting-agent-product-contract';
import { resolveAgentProviderContextProfile } from './agent-provider-contract';
import { loadStorylineMembershipSnapshot } from './domain-crud-revision';
import { createDurableDynamicPermissionAuthority } from './durable-permission-authority';
import {
  AgentWorkingMemoryToolRuntime,
  createAgentWorkingMemoryAwarePermissionPolicy,
  resolveAgentWorkingMemoryToolAccess,
} from './working-memory-tool-runtime';
import { AgentExtensionManager } from './agent-extension-manager';
import { platform } from '../../../platform';
import type { AgentAuthoredJournal } from './agent-authored-journal';

/** Product-level provider window. Planner defaults stay conservative for reuse. */
export { DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS } from './drifting-agent-product-contract';

export interface DriftingAgentProductRepositories {
  runtime: AgentRuntimePersistenceRepository;
  writeEffects: AgentRuntimeWriteEffectRepository;
  freshness: AgentRuntimeFreshnessRepository;
  artifacts: AgentRuntimeResultArtifactRepository;
  elementPatchReceipts: AgentRuntimeElementPatchReceiptRepository;
  longTasks: AgentRuntimeLongTaskRepository;
  extensions: AgentExtensionRepository;
}

export interface CreateDriftingAgentProductCompositionOptions {
  driver?: AgentModelDriver;
  /**
   * One transaction-owning product database. `DbClient` is also a
   * `DbExecutor`, so every repository and the Yjs coordinator share the same
   * isolated database without binding the runtime to a transient transaction.
   */
  database?: DbClient;
  getContext?: () => AgentToolContext | null;
  journal?: AgentJournalSink;
  authoredJournal?: AgentAuthoredJournal;
  limits?: Partial<AgentRuntimeLimits>;
  /** Test/DEV override; product defaults to the exported 200k window. */
  contextWindowTokens?: number;
  /** Test/DEV cap that can only make read-result paging happen earlier. */
  readResultBudgetCharsCap?: number;
  createId?: (kind: RuntimeIdKind) => string;
  authStatus?: () => Promise<GeneralAgentAuthStatus>;
  /** Live author preference for bypassing destructive confirmation prompts. */
  allowDangerousOperations?: () => boolean;
  /** Runtime-discovered MCP/plugin tools, project-filtered by the registry. */
  dynamicTools?: DynamicAgentToolRegistry;
}

export interface DriftingAgentProductComposition {
  transport: GeneralAgentTransport;
  /** Drifting write runtime remains exposed for durable review actions. */
  tools: DriftingWriteToolRuntime;
  /** Complete model-facing surface: Drifting + long-task + dynamic tools. */
  toolRuntime: AgentToolRuntime;
  workspaceTools: DriftingWorkspaceToolRuntime;
  longTaskTools: AgentLongTaskToolRuntime;
  workingMemoryTools: AgentWorkingMemoryToolRuntime;
  dynamicTools: DynamicAgentToolRegistry;
  extensionManager: AgentExtensionManager;
  repositories: DriftingAgentProductRepositories;
  proseCoordinator: YjsProsePersistenceCoordinator;
}

/**
 * Canonical access classifier for every installed built-in definition.
 * Dynamic tools remain project/generation-bound and are resolved separately.
 */
export function resolveDriftingBuiltInToolAccess(name: string): 'read' | 'write' | undefined {
  return (
    resolveDriftingCertifiedToolAccess(name) ??
    resolveAgentLongTaskToolAccess(name) ??
    resolveAgentWorkingMemoryToolAccess(name)
  );
}

/**
 * Canonical product composition for the renderer-owned General Agent.
 *
 * Passing a database makes every durable runtime concern use that exact
 * database. Omitting it preserves the renderer product behavior: repositories
 * resolve the initialized application database lazily when a turn starts.
 */
export function createDriftingAgentProductComposition(
  options: CreateDriftingAgentProductCompositionOptions = {},
): DriftingAgentProductComposition {
  const driver = options.driver ?? new DriftingAgentModelDriver();
  const contextProfile = resolveDriftingAgentContextProfile({
    ...(driver.capabilities?.context ? { declared: driver.capabilities.context } : {}),
    ...(options.contextWindowTokens !== undefined
      ? { requestedContextWindowTokens: options.contextWindowTokens }
      : {}),
  });
  const getContext = options.getContext ?? getActiveAgentToolContext;
  const repositories: DriftingAgentProductRepositories = {
    runtime: createAgentRuntimePersistenceRepository(options.database),
    writeEffects: createAgentRuntimeWriteEffectRepository(options.database),
    freshness: createAgentRuntimeFreshnessRepository(options.database),
    artifacts: createAgentRuntimeResultArtifactRepository(options.database),
    elementPatchReceipts: createAgentRuntimeElementPatchReceiptRepository(options.database),
    longTasks: createAgentRuntimeLongTaskRepository(options.database),
    extensions: createAgentExtensionRepository(options.database),
  };
  const contentRepository = createBookContentRepository(options.database);
  const elementPatchRepository = createElementPatchRepository(options.database);
  const proseCoordinator = createYjsProsePersistenceCoordinator({
    ...(options.database ? { database: options.database } : {}),
    ...(options.authoredJournal ? { journal: options.authoredJournal } : {}),
  });
  const readProseBase = async (entityId: string, entityType: ProseEntityType = 'node') => {
    const projectId = getContext()?.projectId;
    if (!projectId) throw new Error('Drifting prose context is not mounted');
    let contentJson = '{}';
    if (entityType === 'node') {
      contentJson = (await contentRepository.findByNodeId(entityId))?.contentJson ?? '{}';
    } else {
      const database = options.database ?? getDb();
      if (entityType === 'element') {
        const rows = await database
          .select({ contentJson: BookElementTable.contentJson })
          .from(BookElementTable)
          .where(and(eq(BookElementTable.id, entityId), eq(BookElementTable.projectId, projectId)))
          .limit(1);
        contentJson = rows[0]?.contentJson ?? '{}';
      } else if (entityType === 'storyline') {
        const rows = await database
          .select({ contentJson: StorylineTable.contentJson })
          .from(StorylineTable)
          .where(and(eq(StorylineTable.id, entityId), eq(StorylineTable.projectId, projectId)))
          .limit(1);
        contentJson = rows[0]?.contentJson ?? '{}';
      } else {
        const rows = await database
          .select({ contentJson: ElementCategoryTable.contentJson })
          .from(ElementCategoryTable)
          .where(
            and(
              eq(ElementCategoryTable.id, entityId),
              eq(ElementCategoryTable.projectId, projectId),
            ),
          )
          .limit(1);
        contentJson = rows[0]?.contentJson ?? '{}';
      }
    }
    const seedStateUpdate = await createYjsProseSeedState(contentJson);
    const base = await proseCoordinator.readBase(proseDocId(entityType, entityId), seedStateUpdate);
    return {
      revision: base.revision,
      stateVector: new Uint8Array(base.stateVector),
      stateHash: base.stateHash,
    };
  };
  const readTools = new DriftingReadToolRuntime({
    getContext,
    freshness: repositories.freshness,
    artifacts: repositories.artifacts,
    ...(options.readResultBudgetCharsCap
      ? { resultBudgetCharsCap: options.readResultBudgetCharsCap }
      : {}),
    readProseBase,
    readElementPatches: (elementId) => elementPatchRepository.listByElement(elementId),
    readMemories: (projectId) => createAgentMemoryRepository(projectId, options.database).findAll(),
    readStorylineMembershipRevision: async (projectId, storylineId) =>
      (await loadStorylineMembershipSnapshot(options.database ?? getDb(), projectId, storylineId))
        .updatedAt,
  });
  const workspaceTools = new DriftingWorkspaceToolRuntime({
    readRuntime: readTools,
    getContext,
    persistence: repositories.runtime,
  });
  const tools = createDriftingWriteToolRuntime({
    repository: repositories.writeEffects,
    freshness: repositories.freshness,
    getContext,
    readRuntime: readTools,
    prepareRequest: (request) => workspaceTools.prepareWriteRequest(request),
    proseCoordinator,
    readNodeContent: async (nodeId) =>
      (await contentRepository.findByNodeId(nodeId))?.contentJson ?? null,
    ...(options.database ? { elementPatchDb: options.database } : {}),
    elementPatchReceipts: repositories.elementPatchReceipts,
    ...(options.authoredJournal ? { authoredJournal: options.authoredJournal } : {}),
  });
  const longTaskTools = new AgentLongTaskToolRuntime({
    repository: repositories.longTasks,
    resolveTarget: resolveDriftingLongTaskTarget,
    getWholeBookChapterManifest: snapshotDriftingWholeBookChapterManifest,
    resolveCurrentChapterName: resolveDriftingCurrentChapterName,
  });
  const workingMemoryTools = new AgentWorkingMemoryToolRuntime({
    ...(options.database ? { database: options.database } : {}),
  });
  const dynamicTools =
    options.dynamicTools ??
    new DynamicAgentToolRegistry({
      reservedNames: [
        ...AGENT_TOOL_CATALOG.map((tool) => tool.name),
        AGENT_LONG_TASK_READ_TOOL,
        AGENT_LONG_TASK_PLAN_TOOL,
        AGENT_LONG_TASK_STEP_TOOL,
        AGENT_LONG_TASK_CONSTRAINT_TOOL,
      ],
    });
  const toolRuntime = new CompositeAgentToolRuntime(
    [workspaceTools, tools, longTaskTools, workingMemoryTools],
    dynamicTools,
  );
  const extensionManager = new AgentExtensionManager({
    repository: repositories.extensions,
    registry: dynamicTools,
    stdioPlatform: platform.mcpStdio,
    httpPlatform: platform.mcpHttp,
    readSecret: (keychainId) => platform.keychain.get(keychainId),
  });
  const longTaskSupplementalRows = createAgentLongTaskSupplementalRowsHook(repositories.longTasks, {
    resolveCurrentChapterName: resolveDriftingCurrentChapterName,
  });
  const transport = createLocalGeneralAgentTransport({
    driver,
    tools: toolRuntime,
    toolSelector: createDriftingWorkspaceToolSelectionStrategy(),
    permissionPolicy: createDynamicAwareAgentPermissionPolicy(
      createAgentWorkingMemoryAwarePermissionPolicy(
        createAgentLongTaskAwarePermissionPolicy(
          createDriftingAgentPermissionPolicy({
            ...(options.allowDangerousOperations
              ? { allowDangerousOperations: options.allowDangerousOperations }
              : {}),
          }),
        ),
      ),
      dynamicTools,
      createDurableDynamicPermissionAuthority(repositories.extensions),
    ),
    contextPlanning: {
      contextWindowTokens: contextProfile.contextWindowTokens,
      providerProfileId: contextProfile.id,
      providerMaxOutputTokens: contextProfile.maxOutputTokens,
      providerOverheadTokens: contextProfile.providerOverheadTokens,
      perToolOverheadTokens: contextProfile.perToolOverheadTokens,
      resolveProviderProfile: (input) =>
        resolveDriftingAgentContextProfile({
          declared: resolveAgentProviderContextProfile(input.provider, input.model),
          requestedContextWindowTokens:
            options.contextWindowTokens ??
            requestedDriftingAgentContextWindowTokens(input.contextMode),
        }),
      // A long writing turn can expose several disjoint, topology-safe runs.
      // Each provider chunk keeps its own short timeout and deterministic
      // fallback, while the outer pass needs enough time to validate and
      // persist all resulting summaries instead of killing healthy progress.
      compactionTimeoutMs: DRIFTING_AGENT_FULL_COMPACTION_TIMEOUT_MS,
      fullCompactor: createDriftingContextCompactor({
        driver,
        targetReductionRatio: DRIFTING_AGENT_COMPACTION_REDUCTION_RATIO,
        maxProviderChunksPerPass: DRIFTING_AGENT_MAX_PROVIDER_SUMMARY_CHUNKS,
        maxInputTokensPerRequest: DRIFTING_AGENT_COMPACTION_CHUNK_INPUT_TOKENS,
      }),
      userConstraintPolicy: identifyExplicitAgentUserConstraints,
      deterministicSummaries: createDurableAgentContextSummaryHook(repositories.runtime),
      supplementalRows: async (input) => {
        // The Tauri sqlite proxy owns one transaction lane. Keep independent
        // context reads sequential so neither can escape another repository's
        // active transaction during recovery/acceptance fault injection.
        const writeReviewRows = await loadAgentWriteReviewContextRows(
          input.sessionId,
          repositories.writeEffects,
          { currentTurnId: input.turnId },
        );
        const writeReceiptRows = await loadAgentDurableWriteReceiptContextRows(
          input.sessionId,
          repositories.writeEffects,
          { currentTurnId: input.turnId },
        );
        const readProgressRows = await loadAgentAuthoredReadProgressContextRows(
          input.sessionId,
          repositories.writeEffects,
          { currentTurnId: input.turnId },
        );
        const longTaskRows = await longTaskSupplementalRows(input);
        return [
          ...writeReceiptRows,
          ...writeReviewRows,
          ...readProgressRows,
          ...longTaskRows,
        ];
      },
    },
    persistence: createRepositoryAgentTransportPersistence({
      repository: repositories.runtime,
      writeEffects: repositories.writeEffects,
      beforeResumeSession: (sessionId, signal) =>
        tools.reconcileInterruptedWrites(sessionId, signal),
      resolveToolAccess: (name, projectId) =>
        resolveDriftingBuiltInToolAccess(name) ?? dynamicTools.resolveAccess(name, projectId),
    }),
    ...(options.journal ? { journal: options.journal } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    ...(options.authStatus ? { authStatus: options.authStatus } : {}),
  });

  return {
    transport,
    tools,
    toolRuntime,
    workspaceTools,
    longTaskTools,
    workingMemoryTools,
    dynamicTools,
    extensionManager,
    repositories,
    proseCoordinator,
  };
}

function normalizeEntityName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function authoredLongTaskTargetName(
  kind: 'book' | 'project' | 'chapter' | 'drift' | 'element' | 'storyline' | 'category' | 'other',
  value: string,
): string {
  const name = value.trim();
  const patterns: Partial<Record<typeof kind, RegExp>> = {
    chapter: /^章节[「“"](.+?)[」”"](?:正文|摘要|标题)?$/u,
    drift: /^(?:灵感|漂移)[「“"](.+?)[」”"](?:正文|摘要|标题)?$/u,
    element: /^(?:人物|角色|地点|区域|组织|势力|物品|道具|要素)[「“"](.+?)[」”"](?:正文|设定|说明|摘要|名称|别名|事实|分组|分类|完整档案)?$/u,
    storyline: /^故事线[「“"](.+?)[」”"](?:正文|设定|说明|摘要|名称|事实|章节关系|章节|完整档案)?$/u,
    category: /^要素分类[「“"](.+?)[」”"](?:正文|设定|说明|完整档案)?$/u,
  };
  return patterns[kind]?.exec(name)?.[1]?.trim() || name;
}

function resolveUniqueNamedId(
  rows: readonly { id: string; names: readonly string[] }[],
  name: string,
): string | null {
  const wanted = normalizeEntityName(name);
  const matches = rows.filter((row) =>
    row.names.some((candidate) => normalizeEntityName(candidate) === wanted),
  );
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Freeze the current canonical reading order. The id is retained only inside
 * renderer persistence; provider-facing task projections expose ordinal and
 * title, never this internal identity.
 */
export function snapshotDriftingWholeBookChapterManifest(input: { projectId: string }) {
  return useDataStore
    .getState()
    .bookNodes.filter(isChapter)
    .filter((node) => node.projectId === input.projectId)
    .slice()
    .sort(
      (left, right) => left.bookOrder - right.bookOrder || left.id.localeCompare(right.id, 'en'),
    )
    .map((chapter, ordinal) => ({
      ordinal,
      name: chapter.title,
      resolvedChapterId: chapter.id,
    }));
}

export function resolveDriftingCurrentChapterName(input: {
  projectId: string;
  resolvedChapterId: string;
}): string | null {
  return (
    useDataStore
      .getState()
      .bookNodes.find(
        (node) =>
          node.id === input.resolvedChapterId &&
          node.projectId === input.projectId &&
          isChapter(node),
      )?.title ?? null
  );
}

/**
 * Resolve provider-visible names only inside the routed project. Ambiguous
 * names fail closed and remain unresolved in the durable plan.
 */
export function resolveDriftingLongTaskTarget(input: {
  projectId: string;
  kind: 'book' | 'project' | 'chapter' | 'drift' | 'element' | 'storyline' | 'category' | 'other';
  name: string;
}): string | null {
  if (input.kind === 'other') return null;
  const authoredName = authoredLongTaskTargetName(input.kind, input.name);
  if (input.kind === 'book' || input.kind === 'project') {
    const projectState = useProjectStore.getState();
    const projects = [
      ...(projectState.currentProject ? [projectState.currentProject] : []),
      ...projectState.projects,
    ].filter(
      (project, index, all) => all.findIndex((candidate) => candidate.id === project.id) === index,
    );
    return resolveUniqueNamedId(
      projects
        .filter((project) => project.id === input.projectId)
        .map((project) => ({ id: project.id, names: [project.name] })),
      authoredName,
    );
  }

  const state = useDataStore.getState();
  if (input.kind === 'chapter' || input.kind === 'drift') {
    return resolveUniqueNamedId(
      state.bookNodes
        .filter((node) => node.projectId === input.projectId && node.kind === input.kind)
        .map((node) => ({ id: node.id, names: [node.title] })),
      authoredName,
    );
  }
  if (input.kind === 'element') {
    return resolveUniqueNamedId(
      state.bookElements
        .filter((element) => element.projectId === input.projectId)
        .map((element) => ({
          id: element.id,
          names: [element.name, ...element.aliases],
        })),
      authoredName,
    );
  }
  if (input.kind === 'category') {
    return resolveUniqueNamedId(
      state.bookElementCategories
        .filter((category) => category.projectId === input.projectId)
        .map((category) => ({ id: category.id, names: [category.name] })),
      authoredName,
    );
  }
  return resolveUniqueNamedId(
    state.storylines
      .filter((storyline) => storyline.projectId === input.projectId)
      .map((storyline) => ({
        id: storyline.id,
        names: [storyline.name],
      })),
    authoredName,
  );
}
