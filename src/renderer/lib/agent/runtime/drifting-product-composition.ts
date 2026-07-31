import type { GeneralAgentAuthStatus } from '../protocol';
import { isChapter } from '../../../domain/book-node';
import {
  getActiveAgentToolContext,
  type AgentToolContext,
} from '../tool-handlers';
import { AGENT_TOOL_CATALOG } from '../tool-registry';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createElementPatchRepository } from '../../../sqlite-repo/element-patch-repo';
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
import type { DbClient } from '../../../lib/db';
import { proseDocId } from '../../yjs-doc-id';
import { useAgentEditStore } from '../../../store/agent-edit-store';
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
import { createDriftingToolSelectionStrategy } from './drifting-tool-selection';
import {
  createDriftingWriteToolRuntime,
  resolveDriftingCertifiedToolAccess,
  type DriftingWriteToolRuntime,
} from './drifting-write-tool-runtime';
import { DriftingAgentModelDriver } from './drivers';
import {
  createLocalGeneralAgentTransport,
  type RuntimeIdKind,
} from './local-transport';
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
import {
  identifyExplicitAgentUserConstraints,
} from './runtime-context-planning';
import type {
  AgentJournalSink,
  AgentModelDriver,
  AgentRuntimeLimits,
  AgentToolRuntime,
} from './types';
import {
  createYjsProseSeedState,
} from './yjs-prose-command';
import {
  createYjsProsePersistenceCoordinator,
  type YjsProsePersistenceCoordinator,
} from './yjs-prose-persistence-coordinator';
import { loadAgentWriteReviewContextRows } from './write-review-feedback';
import type { GeneralAgentTransport } from '../transport';

/** Product-level provider window. Planner defaults stay conservative for reuse. */
export const DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS = 200_000 as const;
/** Eight 200k-window iterations may contribute provider-reported input usage. */
export const DRIFTING_AGENT_MAX_TURN_INPUT_TOKENS = 1_600_000 as const;
export const DRIFTING_AGENT_MAX_TURN_TOTAL_TOKENS = 1_632_000 as const;

export interface DriftingAgentProductRepositories {
  runtime: AgentRuntimePersistenceRepository;
  writeEffects: AgentRuntimeWriteEffectRepository;
  freshness: AgentRuntimeFreshnessRepository;
  artifacts: AgentRuntimeResultArtifactRepository;
  elementPatchReceipts: AgentRuntimeElementPatchReceiptRepository;
  longTasks: AgentRuntimeLongTaskRepository;
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
  limits?: Partial<AgentRuntimeLimits>;
  /** Test/DEV override; product defaults to the exported 200k window. */
  contextWindowTokens?: number;
  /** Test/DEV cap that can only make read-result paging happen earlier. */
  readResultBudgetCharsCap?: number;
  createId?: (kind: RuntimeIdKind) => string;
  authStatus?: () => Promise<GeneralAgentAuthStatus>;
  /** Runtime-discovered MCP/plugin tools, project-filtered by the registry. */
  dynamicTools?: DynamicAgentToolRegistry;
}

export interface DriftingAgentProductComposition {
  transport: GeneralAgentTransport;
  /** Drifting write runtime remains exposed for durable review actions. */
  tools: DriftingWriteToolRuntime;
  /** Complete model-facing surface: Drifting + long-task + dynamic tools. */
  toolRuntime: AgentToolRuntime;
  longTaskTools: AgentLongTaskToolRuntime;
  dynamicTools: DynamicAgentToolRegistry;
  repositories: DriftingAgentProductRepositories;
  proseCoordinator: YjsProsePersistenceCoordinator;
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
  const getContext = options.getContext ?? getActiveAgentToolContext;
  const repositories: DriftingAgentProductRepositories = {
    runtime: createAgentRuntimePersistenceRepository(options.database),
    writeEffects: createAgentRuntimeWriteEffectRepository(options.database),
    freshness: createAgentRuntimeFreshnessRepository(options.database),
    artifacts: createAgentRuntimeResultArtifactRepository(options.database),
    elementPatchReceipts:
      createAgentRuntimeElementPatchReceiptRepository(options.database),
    longTasks: createAgentRuntimeLongTaskRepository(options.database),
  };
  const contentRepository = createBookContentRepository(options.database);
  const elementPatchRepository =
    createElementPatchRepository(options.database);
  const proseCoordinator = createYjsProsePersistenceCoordinator({
    ...(options.database ? { database: options.database } : {}),
  });
  const readProseBase = async (nodeId: string) => {
    const content = await contentRepository.findByNodeId(nodeId);
    const seedStateUpdate = await createYjsProseSeedState(
      content?.contentJson ?? '{}',
    );
    const base = await proseCoordinator.readBase(
      proseDocId('node', nodeId),
      seedStateUpdate,
    );
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
    readElementPatches: (elementId) =>
      elementPatchRepository.listByElement(elementId),
  });
  const tools = createDriftingWriteToolRuntime({
    repository: repositories.writeEffects,
    freshness: repositories.freshness,
    getContext,
    readRuntime: readTools,
    proseCoordinator,
    readNodeContent: async (nodeId) =>
      (await contentRepository.findByNodeId(nodeId))?.contentJson ?? null,
    ...(options.database ? { elementPatchDb: options.database } : {}),
    elementPatchReceipts: repositories.elementPatchReceipts,
    autoAcceptReview: (effect) => {
      const batch =
        useAgentEditStore.getState().reviewBatches[
          `agent-review:${effect.id}`
        ];
      if (
        batch &&
          batch.changes.length > 0 &&
        batch.changes.every((change) => change.mode === 'auto')
      ) {
        return true;
      }
      // Project facts and Agent-created comments have no entity-editor batch.
      // Their write strategy still freezes review mode in the durable command,
      // so auto mode must settle from that snapshot rather than leaving an
      // invisible pending review forever.
      return frozenEffectReviewMode(effect.forward) === 'auto';
    },
  });
  const longTaskTools = new AgentLongTaskToolRuntime({
    repository: repositories.longTasks,
    resolveTarget: resolveDriftingLongTaskTarget,
    getWholeBookChapterManifest:
      snapshotDriftingWholeBookChapterManifest,
    resolveCurrentChapterName:
      resolveDriftingCurrentChapterName,
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
    [tools, longTaskTools],
    dynamicTools,
  );
  const longTaskSupplementalRows =
    createAgentLongTaskSupplementalRowsHook(repositories.longTasks, {
      resolveCurrentChapterName:
        resolveDriftingCurrentChapterName,
    });
  const transport = createLocalGeneralAgentTransport({
    driver: options.driver ?? new DriftingAgentModelDriver(),
    tools: toolRuntime,
    toolSelector: createDriftingToolSelectionStrategy(),
    permissionPolicy: createDynamicAwareAgentPermissionPolicy(
      createAgentLongTaskAwarePermissionPolicy(
        createDriftingAgentPermissionPolicy(),
      ),
      dynamicTools,
    ),
    contextPlanning: {
      contextWindowTokens:
        options.contextWindowTokens ?? DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS,
      compactionTimeoutMs: 60_000,
      fullCompactor: createDriftingContextCompactor(),
      userConstraintPolicy: identifyExplicitAgentUserConstraints,
      deterministicSummaries:
        createDurableAgentContextSummaryHook(repositories.runtime),
      supplementalRows: async (input) => {
        // The Tauri sqlite proxy owns one transaction lane. Keep independent
        // context reads sequential so neither can escape another repository's
        // active transaction during recovery/acceptance fault injection.
        const writeReviewRows = await loadAgentWriteReviewContextRows(
          input.sessionId,
          repositories.writeEffects,
        );
        const longTaskRows = await longTaskSupplementalRows(input);
        return [...writeReviewRows, ...longTaskRows];
      },
    },
    persistence: createRepositoryAgentTransportPersistence({
      repository: repositories.runtime,
      writeEffects: repositories.writeEffects,
      beforeResumeSession: (sessionId, signal) =>
        tools.reconcileInterruptedWrites(sessionId, signal),
      resolveToolAccess: (name, projectId) =>
        resolveDriftingCertifiedToolAccess(name) ??
        resolveAgentLongTaskToolAccess(name) ??
        dynamicTools.resolveAccess(name, projectId),
    }),
    ...(options.journal ? { journal: options.journal } : {}),
    limits: {
      maxInputTokens: DRIFTING_AGENT_MAX_TURN_INPUT_TOKENS,
      maxTotalTokens: DRIFTING_AGENT_MAX_TURN_TOTAL_TOKENS,
      ...options.limits,
    },
    ...(options.createId ? { createId: options.createId } : {}),
    ...(options.authStatus ? { authStatus: options.authStatus } : {}),
  });

  return {
    transport,
    tools,
    toolRuntime,
    longTaskTools,
    dynamicTools,
    repositories,
    proseCoordinator,
  };
}

function normalizeEntityName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
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
export function snapshotDriftingWholeBookChapterManifest(input: {
  projectId: string;
}) {
  return useDataStore
    .getState()
    .bookNodes.filter(isChapter)
    .filter((node) => node.projectId === input.projectId)
    .slice()
    .sort(
      (left, right) =>
        left.bookOrder - right.bookOrder ||
        left.id.localeCompare(right.id, 'en'),
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
  kind:
    | 'book'
    | 'project'
    | 'chapter'
    | 'drift'
    | 'element'
    | 'storyline'
    | 'other';
  name: string;
}): string | null {
  if (input.kind === 'other') return null;
  if (input.kind === 'book' || input.kind === 'project') {
    const projectState = useProjectStore.getState();
    const projects = [
      ...(projectState.currentProject
        ? [projectState.currentProject]
        : []),
      ...projectState.projects,
    ].filter(
      (project, index, all) =>
        all.findIndex((candidate) => candidate.id === project.id) ===
        index,
    );
    return resolveUniqueNamedId(
      projects
        .filter((project) => project.id === input.projectId)
        .map((project) => ({ id: project.id, names: [project.name] })),
      input.name,
    );
  }

  const state = useDataStore.getState();
  if (input.kind === 'chapter' || input.kind === 'drift') {
    return resolveUniqueNamedId(
      state.bookNodes
        .filter(
          (node) =>
            node.projectId === input.projectId &&
            node.kind === input.kind,
        )
        .map((node) => ({ id: node.id, names: [node.title] })),
      input.name,
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
      input.name,
    );
  }
  return resolveUniqueNamedId(
    state.storylines
      .filter((storyline) => storyline.projectId === input.projectId)
      .map((storyline) => ({
        id: storyline.id,
        names: [storyline.name],
      })),
    input.name,
  );
}

function frozenEffectReviewMode(
  value: unknown,
): 'auto' | 'approve' | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const reviewSnapshot = (
    value as { reviewSnapshot?: unknown }
  ).reviewSnapshot;
  if (
    !reviewSnapshot ||
    typeof reviewSnapshot !== 'object' ||
    Array.isArray(reviewSnapshot)
  ) {
    return null;
  }
  const mode = (reviewSnapshot as { mode?: unknown }).mode;
  return mode === 'auto' || mode === 'approve' ? mode : null;
}
