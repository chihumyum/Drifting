import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  AgentRuntimeReadFreshnessObservation,
  AgentRuntimeReadResult,
  CreateAgentRuntimeReadObservation,
  PersistedAgentRuntimeReadReceipt,
} from '../../../domain/agent-runtime-freshness';
import type { AgentMemory } from '../../../domain/agent-memory';
import type { AgentRuntimeResultArtifactQuota } from '../../../domain/agent-runtime-result-artifact';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import {
  createAgentRuntimeFreshnessRepository,
  type AgentRuntimeFreshnessRepository,
} from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createAgentMemoryRepository } from '../../../sqlite-repo/agent-memory-repo';
import { getDb } from '../../../lib/db';
import { proseDocId, type ProseEntityType } from '../../yjs-doc-id';
import {
  createElementPatchRepository,
  type ElementPatch,
} from '../../../sqlite-repo/element-patch-repo';
import {
  createAgentRuntimeResultArtifactRepository,
  type AgentRuntimeResultArtifactRepository,
} from '../../../sqlite-repo/agent-runtime-result-artifact-repo';
import {
  getActiveAgentToolContext,
  pendingDeletedPatchIds,
  runAgentTool,
  type AgentToolContext,
} from '../tool-handlers';
import { AGENT_READ_TOOLS, getRegisteredTool, type RegisteredTool } from '../tool-registry';
import { isAgentAbort, throwIfAgentAborted } from './errors';
import { createYjsProseSeedState } from './yjs-prose-command';
import {
  createYjsProsePersistenceCoordinator,
  type YjsProsePersistenceBase,
} from './yjs-prose-persistence-coordinator';
import { elementPatchRevision, elementPatchSetRevision } from './element-patch-revision';
import { clonePortableData } from './portable-data';
import { agentMemorySetRevision, loadStorylineMembershipSnapshot } from './domain-crud-revision';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolRuntime,
} from './types';

const RESULT_PAGE_TOOL = 'read_tool_result';
const ASK_USER_TOOL = 'ask_user';
const DEFAULT_MAX_STORED_RESULTS = 128;
const DEFAULT_MAX_STORED_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_STORED_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_PAGE_CHARS = 16_000;

/** Canonical P1 catalog lookup used by durable tool lifecycle projection. */
export function resolveDriftingReadToolAccess(name: string): 'read' | undefined {
  return name === RESULT_PAGE_TOOL ||
    name === ASK_USER_TOOL ||
    AGENT_READ_TOOLS.some((tool) => tool.name === name)
    ? 'read'
    : undefined;
}

interface StoredReadResult {
  ref: string;
  projectId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  serialized: string;
}

export interface DriftingReadToolRuntimeOptions {
  getContext?: () => AgentToolContext | null;
  /**
   * Product runtimes use the canonical repository. `null` exists only for
   * isolated P1/P3 compatibility fixtures that have no canonical lifecycle
   * rows; never use it in the renderer product wiring.
   */
  freshness?: AgentRuntimeFreshnessRepository | null;
  /**
   * Product composition must supply this alongside an injected freshness
   * repository. `null` retains the bounded in-memory implementation only for
   * isolated compatibility fixtures with no canonical lifecycle rows.
   */
  artifacts?: AgentRuntimeResultArtifactRepository | null;
  /**
   * Injectable exact Yjs base reader for tests. Product defaults to the same
   * persistence coordinator used by certified prose writes.
   */
  readProseBase?: (
    entityId: string,
    entityType?: ProseEntityType,
  ) => Promise<Pick<YjsProsePersistenceBase, 'revision' | 'stateVector' | 'stateHash'>>;
  /** Injectable transaction-consistent patch reader for freshness tests. */
  readElementPatches?: (elementId: string) => Promise<readonly ElementPatch[]>;
  /** Exact full memory rows, including dismissed and soft-deleted provenance. */
  readMemories?: (projectId: string) => Promise<readonly AgentMemory[]>;
  /** Exact project membership graph revision for a storyline file read. */
  readStorylineMembershipRevision?: (projectId: string, storylineId: string) => Promise<string>;
  now?: () => string;
  dispatch?: typeof runAgentTool;
  maxStoredResults?: number;
  maxStoredChars?: number;
  resultArtifactQuota?: Partial<AgentRuntimeResultArtifactQuota>;
  /**
   * Optional upper bound used by tests and the DEV headless bridge to force
   * real artifact paging with a small fixture. It can only reduce a catalog
   * budget, never enlarge the production exposure.
   */
  resultBudgetCharsCap?: number;
}

export interface TruncatedAgentToolResult {
  truncated: true;
  resultRef: string;
  preview: string;
  totalChars: number;
  /** Present for SQLite-backed product artifacts. */
  contentHash?: string;
  totalBytes?: number;
  reread: {
    tool: typeof RESULT_PAGE_TOOL;
    arguments: {
      resultRef: string;
      offset: number;
      limit: number;
    };
  };
}

/**
 * Production read-only bridge from the provider-neutral runtime to Drifting's
 * canonical renderer dispatcher.
 *
 * It never receives an `AgentWriteApi` capability directly and only exposes
 * entries from `AGENT_READ_TOOLS`. The active renderer context is checked both
 * before and after every read so a project switch cannot return data from the
 * previously mounted project.
 */
export class DriftingReadToolRuntime implements AgentToolRuntime {
  private readonly getContext: () => AgentToolContext | null;
  private readonly freshness: AgentRuntimeFreshnessRepository | null;
  private readonly artifacts: AgentRuntimeResultArtifactRepository | null;
  private readonly readProseBase: NonNullable<DriftingReadToolRuntimeOptions['readProseBase']>;
  private readonly readElementPatches: NonNullable<
    DriftingReadToolRuntimeOptions['readElementPatches']
  >;
  private readonly readMemories: NonNullable<DriftingReadToolRuntimeOptions['readMemories']>;
  private readonly readStorylineMembershipRevision: NonNullable<
    DriftingReadToolRuntimeOptions['readStorylineMembershipRevision']
  >;
  private readonly now: () => string;
  private readonly dispatch: typeof runAgentTool;
  private readonly maxStoredResults: number;
  private readonly maxStoredChars: number;
  private readonly resultArtifactQuota: AgentRuntimeResultArtifactQuota;
  private readonly resultBudgetCharsCap: number | null;
  private readonly storedResults = new Map<string, StoredReadResult>();
  private storedChars = 0;

  constructor(options: DriftingReadToolRuntimeOptions = {}) {
    this.getContext = options.getContext ?? getActiveAgentToolContext;
    this.freshness =
      options.freshness === undefined ? createAgentRuntimeFreshnessRepository() : options.freshness;
    // A fully default runtime owns both repositories. Callers that inject a
    // lifecycle repository must inject the matching artifact repository too,
    // because an arbitrary repository may be backed by another DB executor.
    this.artifacts =
      options.artifacts === undefined
        ? options.freshness === undefined
          ? createAgentRuntimeResultArtifactRepository()
          : null
        : options.artifacts;
    this.readProseBase = options.readProseBase ?? createDefaultProseBaseReader();
    this.readElementPatches =
      options.readElementPatches ??
      ((elementId) => createElementPatchRepository().listByElement(elementId));
    this.readMemories =
      options.readMemories ?? ((projectId) => createAgentMemoryRepository(projectId).findAll());
    this.readStorylineMembershipRevision =
      options.readStorylineMembershipRevision ??
      (async (projectId, storylineId) =>
        (await loadStorylineMembershipSnapshot(getDb(), projectId, storylineId)).updatedAt);
    this.now = options.now ?? (() => new Date().toISOString());
    this.dispatch = options.dispatch ?? runAgentTool;
    this.maxStoredResults = options.maxStoredResults ?? DEFAULT_MAX_STORED_RESULTS;
    this.maxStoredChars = options.maxStoredChars ?? DEFAULT_MAX_STORED_CHARS;
    if (
      options.resultBudgetCharsCap !== undefined &&
      (!Number.isSafeInteger(options.resultBudgetCharsCap) || options.resultBudgetCharsCap <= 0)
    ) {
      throw new Error('resultBudgetCharsCap must be a positive safe integer');
    }
    this.resultBudgetCharsCap = options.resultBudgetCharsCap ?? null;
    this.resultArtifactQuota = {
      maxArtifactsPerSession:
        options.resultArtifactQuota?.maxArtifactsPerSession ?? this.maxStoredResults,
      maxBytesPerSession:
        options.resultArtifactQuota?.maxBytesPerSession ?? DEFAULT_MAX_STORED_BYTES,
    };
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    this.requireMatchingContext(context);
    return [
      ...AGENT_READ_TOOLS.map((tool) => this.toDefinition(tool)),
      askUserDefinition(),
      resultPageDefinition(),
    ];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    if (request.access !== 'read') {
      return {
        ok: false,
        error: `Read-only Agent runtime denied write tool "${request.name}"`,
      };
    }

    if (request.name === RESULT_PAGE_TOOL) {
      return this.executeReadWithReceipt(request, () => this.readStoredResultData(request), []);
    }
    if (request.name === ASK_USER_TOOL) {
      return this.executeReadWithReceipt(request, async () => {
        const prompt = String(request.arguments.prompt ?? '').trim();
        if (!request.control) {
          throw new Error('No interactive Agent control channel is installed');
        }
        const answer = await request.control.requestUserInput({
          requestId: `agent-user-input:${request.idempotencyKey}`,
          prompt,
        });
        const tool = getRegisteredTool(ASK_USER_TOOL);
        if (!tool || tool.scope !== 'runtime-virtual') {
          throw new Error('The ask_user runtime contract is unavailable');
        }
        return this.budgetResult(request, tool, { answer });
      }, []);
    }

    const catalogEntry = AGENT_READ_TOOLS.find((tool) => tool.name === request.name);
    if (!catalogEntry) {
      return {
        ok: false,
        error: `Tool "${request.name}" is not in the read-certified catalog`,
      };
    }

    try {
      const active = this.requireMatchingContext(request.context);
      const replay = await this.replayReadReceipt(request);
      if (replay) return replay;
      const observations = await this.captureObservations(request, active);
      const data = await this.dispatch(request.name, request.arguments, active);
      throwIfAgentAborted(request.signal);
      this.requireMatchingContext(request.context);
      await this.assertObservationsStillCurrent(observations, active.projectId);
      return await this.persistSuccessfulRead(
        request,
        await this.budgetResult(request, catalogEntry, data),
        observations,
      );
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return { ok: false, error: publicToolError(error) };
    }
  }

  private async executeReadWithReceipt(
    request: AgentToolExecutionRequest,
    read: () => unknown | Promise<unknown>,
    observations: readonly CreateAgentRuntimeReadObservation[],
  ): Promise<AgentToolExecutionResult> {
    try {
      const replay = await this.replayReadReceipt(request);
      if (replay) {
        this.requireMatchingContext(request.context);
        return replay;
      }
      const data = await read();
      throwIfAgentAborted(request.signal);
      this.requireMatchingContext(request.context);
      return await this.persistSuccessfulRead(request, data, observations);
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return { ok: false, error: publicToolError(error) };
    }
  }

  private async persistSuccessfulRead(
    request: AgentToolExecutionRequest,
    result: unknown,
    observations: readonly CreateAgentRuntimeReadObservation[],
  ): Promise<AgentToolExecutionResult> {
    const portableResult = clonePortableData(result);
    if (!this.freshness) {
      return { ok: true, data: portableResult };
    }
    const receiptId = readReceiptId(request);
    const providerObservations: AgentRuntimeReadFreshnessObservation[] = observations.map(
      (observation) => ({
        id: observation.id,
        entityKind: observation.entityKind,
        entityId: observation.entityId,
        revision: observation.revision,
      }),
    );
    const envelope: AgentRuntimeReadResult = {
      result: portableResult,
      freshness: {
        receiptId,
        observations: providerObservations,
      },
    };
    const persisted = await this.freshness.persistReadReceipt({
      id: receiptId,
      projectId: durableReadProjectId(request),
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: runtimeToolCallId(request),
      callId: request.callId,
      toolName: request.name,
      idempotencyKey: request.idempotencyKey,
      result: envelope,
      observations,
      createdAt: this.now(),
    });
    // Return the verified canonical result, not a separately-serialized
    // approximation. This makes the provider result and durable result exact.
    return { ok: true, data: persisted.receipt.result };
  }

  private async replayReadReceipt(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionResult | null> {
    if (!this.freshness) return null;
    const receipt = await this.freshness.getReadReceipt(readReceiptId(request));
    if (!receipt) return null;
    assertReadReceiptProvenance(receipt, request);
    return { ok: true, data: receipt.result };
  }

  private async captureObservations(
    request: AgentToolExecutionRequest,
    active: AgentToolContext,
  ): Promise<CreateAgentRuntimeReadObservation[]> {
    if (request.name === 'get_element_patches') {
      return this.captureElementPatchObservations(request, active);
    }
    if (request.name === 'get_project_brief' || request.name === 'get_overview') {
      const project = useProjectStore.getState().currentProject;
      return project?.id === active.projectId
        ? [
            {
              id: readObservationId(request, 0),
              entityKind: 'project',
              entityId: project.id,
              revision: project.updatedAt,
            },
          ]
        : [];
    }
    if (request.name === 'read_element') {
      const element = resolveObservedEntity(
        useDataStore
          .getState()
          .bookElements.filter((candidate) => candidate.projectId === active.projectId),
        request.arguments.element,
        (candidate) => candidate.name,
      );
      if (!element) return [];
      const prose = await this.readProseBase(element.id, 'element');
      return [
        {
          id: readObservationId(request, 0),
          entityKind: 'element',
          entityId: element.id,
          revision: element.updatedAt,
        },
        proseObservation(request, 1, 'element', element.id, prose),
      ];
    }
    if (request.name === 'get_storyline') {
      const storyline = resolveObservedEntity(
        useDataStore
          .getState()
          .storylines.filter((candidate) => candidate.projectId === active.projectId),
        request.arguments.storyline,
        (candidate) => candidate.name,
      );
      if (!storyline) return [];
      return [
        {
          id: readObservationId(request, 0),
          entityKind: 'storyline',
          entityId: storyline.id,
          revision: storyline.updatedAt,
        },
        {
          id: readObservationId(request, 1),
          entityKind: 'storyline_membership',
          entityId: storyline.id,
          revision: await this.readStorylineMembershipRevision(active.projectId, storyline.id),
        },
      ];
    }
    if (request.name === 'list_comments') {
      return useDataStore
        .getState()
        .comments.filter((comment) => comment.projectId === active.projectId)
        .map((comment, ordinal) => ({
          id: readObservationId(request, ordinal),
          entityKind: 'comment',
          entityId: comment.id,
          revision: comment.updatedAt,
        }));
    }
    if (request.name === 'get_relation_types') {
      return useDataStore
        .getState()
        .entityRelationTypes.filter((type) => type.projectId === active.projectId)
        .map((type, ordinal) => ({
          id: readObservationId(request, ordinal),
          entityKind: 'relation_type',
          entityId: type.id,
          revision: type.updatedAt,
        }));
    }
    if (request.name === 'list_memory') {
      const memories = await this.readMemories(active.projectId);
      const observations: CreateAgentRuntimeReadObservation[] = [
        {
          id: readObservationId(request, 0),
          entityKind: 'memory_set',
          entityId: active.projectId,
          revision: await agentMemorySetRevision(memories),
        },
      ];
      for (const memory of memories
        .filter((candidate) => candidate.deletedAt === null)
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
        observations.push({
          id: readObservationId(request, observations.length),
          entityKind: 'memory',
          entityId: memory.id,
          revision: memory.updatedAt,
        });
      }
      return observations;
    }
    if (request.name === 'get_entity_relations') {
      const target = resolveObservedRelationTarget(request, active.projectId);
      if (!target) return [];
      return useDataStore
        .getState()
        .entityRelations.filter(
          (relation) =>
            relation.projectId === active.projectId &&
            ((relation.fromKind === target.kind && relation.fromId === target.id) ||
              (relation.toKind === target.kind && relation.toId === target.id)),
        )
        .map((relation, ordinal) => ({
          id: readObservationId(request, ordinal),
          entityKind: 'relation',
          entityId: relation.id,
          revision: relation.updatedAt,
        }));
    }
    if (request.name !== 'read_node') return [];
    const rawKind = typeof request.arguments.kind === 'string' ? request.arguments.kind : 'node';
    const entityType = normalizeObservedProseEntityType(rawKind);
    if (!entityType) return [];
    const ref = String(request.arguments.node ?? '').trim();
    if (!ref) return [];
    const observed = resolveObservedProseEntity(entityType, active.projectId, ref);
    // The canonical dispatcher will produce the user-facing not-found or
    // ambiguity error. Only a uniquely-resolved node becomes an observation.
    if (!observed) return [];
    const observations: CreateAgentRuntimeReadObservation[] = [
      {
        id: readObservationId(request, 0),
        entityKind: entityType,
        entityId: observed.id,
        revision: observed.updatedAt,
      },
    ];
    if (request.arguments.prose !== false) {
      const prose = await this.readProseBase(observed.id, entityType);
      observations.push(
        proseObservation(request, observations.length, entityType, observed.id, prose),
      );
    }
    return observations;
  }

  private async captureElementPatchObservations(
    request: AgentToolExecutionRequest,
    active: AgentToolContext,
  ): Promise<CreateAgentRuntimeReadObservation[]> {
    const ref = String(request.arguments.element ?? '').trim();
    if (!ref) return [];
    const elements = useDataStore
      .getState()
      .bookElements.filter((element) => element.projectId === active.projectId);
    const direct = elements.find((element) => element.id === ref);
    const matches = direct
      ? [direct]
      : elements.filter(
          (element) => element.name.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
        );
    if (matches.length !== 1) return [];
    const element = matches[0]!;
    const pendingDeletes = pendingDeletedPatchIds(element.id);
    const patches = (await this.readElementPatches(element.id)).filter(
      (patch) =>
        patch.projectId === active.projectId &&
        !patch.invalidatedAt &&
        !pendingDeletes.has(patch.id),
    );
    const observations: CreateAgentRuntimeReadObservation[] = [
      {
        id: readObservationId(request, 0),
        entityKind: 'element_patch_set',
        entityId: element.id,
        revision: await elementPatchSetRevision(patches),
      },
    ];
    for (const patch of patches) {
      observations.push({
        id: readObservationId(request, observations.length),
        entityKind: 'element_patch',
        entityId: patch.id,
        revision: await elementPatchRevision(patch),
      });
    }
    return observations;
  }

  private async assertObservationsStillCurrent(
    observations: readonly CreateAgentRuntimeReadObservation[],
    projectId: string,
  ): Promise<void> {
    for (const observation of observations) {
      if (observation.entityKind === 'project') {
        const current = useProjectStore.getState().currentProject;
        if (
          !current ||
          current.id !== projectId ||
          current.id !== observation.entityId ||
          current.updatedAt !== observation.revision
        ) {
          throw new Error(
            'The project changed while it was being read; retry get_overview or get_project_brief before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'element') {
        const current = useDataStore
          .getState()
          .bookElements.find(
            (element) => element.id === observation.entityId && element.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error(
            'The element changed while it was being read; retry read_element before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'storyline') {
        const current = useDataStore
          .getState()
          .storylines.find(
            (storyline) =>
              storyline.id === observation.entityId && storyline.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error(
            'The storyline changed while it was being read; retry get_storyline before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'storyline_membership') {
        const revision = await this.readStorylineMembershipRevision(
          projectId,
          observation.entityId,
        );
        if (revision !== observation.revision) {
          throw new Error(
            'Storyline membership changed while it was being read; retry get_storyline before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'category') {
        const current = useDataStore
          .getState()
          .bookElementCategories.find(
            (category) => category.id === observation.entityId && category.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error(
            'The category changed while it was being read; retry read_node before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'comment') {
        const current = useDataStore
          .getState()
          .comments.find(
            (comment) => comment.id === observation.entityId && comment.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error(
            'The comment changed while it was being read; retry list_comments before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'memory_set') {
        const revision = await agentMemorySetRevision(await this.readMemories(projectId));
        if (revision !== observation.revision) {
          throw new Error(
            'Writing guidance changed while it was being read; retry list_memory before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'memory') {
        const memory = (await this.readMemories(projectId)).find(
          (candidate) => candidate.id === observation.entityId,
        );
        if (!memory || memory.updatedAt !== observation.revision) {
          throw new Error(
            'Writing guidance changed while it was being read; retry list_memory before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'relation') {
        const current = useDataStore
          .getState()
          .entityRelations.find(
            (relation) => relation.id === observation.entityId && relation.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error(
            'The relation changed while it was being read; retry get_entity_relations before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'relation_type') {
        const current = useDataStore
          .getState()
          .entityRelationTypes.find(
            (type) => type.id === observation.entityId && type.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error('Relation type changed while it was being read; retry list_relation_types');
        }
        continue;
      }
      if (observation.entityKind === 'node') {
        const current = useDataStore
          .getState()
          .bookNodes.find(
            (node) => node.id === observation.entityId && node.projectId === projectId,
          );
        if (!current || current.updatedAt !== observation.revision) {
          throw new Error(
            'The node changed while it was being read; retry read_node before writing',
          );
        }
        continue;
      }
      const proseType = proseEntityTypeFromObservation(observation.entityKind);
      if (proseType) {
        const current = await this.readProseBase(observation.entityId, proseType);
        if (
          observation.revision !== `yjs:${current.revision}` ||
          observation.stateHash !== current.stateHash ||
          !bytesEqual(observation.stateVector, current.stateVector)
        ) {
          throw new Error(
            'The node prose changed while it was being read; retry read_node before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'element_patch_set') {
        const pendingDeletes = pendingDeletedPatchIds(observation.entityId);
        const current = (await this.readElementPatches(observation.entityId)).filter(
          (patch) =>
            patch.projectId === projectId && !patch.invalidatedAt && !pendingDeletes.has(patch.id),
        );
        if ((await elementPatchSetRevision(current)) !== observation.revision) {
          throw new Error(
            'Element patches changed while they were being read; retry get_element_patches before writing',
          );
        }
        continue;
      }
      if (observation.entityKind === 'element_patch') {
        const elementIds = useDataStore
          .getState()
          .bookElements.filter((element) => element.projectId === projectId)
          .map((element) => element.id);
        const batches = await Promise.all(
          elementIds.map((elementId) => this.readElementPatches(elementId)),
        );
        const current = batches
          .flat()
          .find(
            (patch) =>
              patch.id === observation.entityId &&
              patch.projectId === projectId &&
              !patch.invalidatedAt &&
              !pendingDeletedPatchIds(patch.elementId).has(patch.id),
          );
        if (!current || (await elementPatchRevision(current)) !== observation.revision) {
          throw new Error(
            'An element patch changed while it was being read; retry get_element_patches before writing',
          );
        }
      }
    }
  }

  private toDefinition(tool: RegisteredTool): AgentToolDefinition {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parametersSchema,
      access: 'read',
      validateInput: (input) => validateToolInput(tool, input),
    };
  }

  private requireMatchingContext(runtimeContext: AgentRuntimeContext): AgentToolContext {
    const active = this.getContext();
    if (!active) {
      throw new Error('Drifting tool context is not mounted');
    }
    const routeProjectId = runtimeContext.route.projectId;
    if (routeProjectId && routeProjectId !== active.projectId) {
      throw new Error('Agent route does not match the active Drifting project');
    }
    return active;
  }

  private async budgetResult(
    request: AgentToolExecutionRequest,
    tool: RegisteredTool,
    data: unknown,
  ): Promise<unknown> {
    const serialized = serializeResult(data);
    const resultBudgetChars = Math.min(
      tool.resultBudgetChars,
      this.resultBudgetCharsCap ?? tool.resultBudgetChars,
    );
    if (serialized.length <= resultBudgetChars) return data;

    const resultRef = ['agent-result', request.sessionId, request.turnId, request.callId].join(':');
    const projectId = request.context.route.projectId ?? '';
    let durableIntegrity: { contentHash: string; totalBytes: number } | undefined;
    if (this.artifacts) {
      const persisted = await this.artifacts.persist({
        ref: resultRef,
        projectId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: runtimeToolCallId(request),
        callId: request.callId,
        toolName: request.name,
        idempotencyKey: request.idempotencyKey,
        arguments: request.arguments,
        serialized,
        createdAt: this.now(),
        quota: this.resultArtifactQuota,
      });
      durableIntegrity = {
        contentHash: persisted.artifact.contentHash,
        totalBytes: persisted.artifact.byteCount,
      };
    } else {
      this.storeResult({
        ref: resultRef,
        projectId,
        sessionId: request.sessionId,
        toolName: request.name,
        arguments: request.arguments,
        serialized,
      });
    }
    const previewLimit = Math.min(resultBudgetChars, 4_000);
    const result: TruncatedAgentToolResult = {
      truncated: true,
      resultRef,
      preview: sliceCodePoints(serialized, 0, previewLimit),
      totalChars: codePointLength(serialized),
      ...durableIntegrity,
      reread: {
        tool: RESULT_PAGE_TOOL,
        arguments: {
          resultRef,
          offset: previewLimit,
          limit: Math.min(MAX_RESULT_PAGE_CHARS, resultBudgetChars),
        },
      },
    };
    return result;
  }

  private async readStoredResultData(request: AgentToolExecutionRequest): Promise<unknown> {
    const resultRef = String(request.arguments.resultRef ?? '');
    const projectId = request.context.route.projectId ?? '';
    const offset = Number(request.arguments.offset ?? 0);
    const limit = Number(request.arguments.limit ?? MAX_RESULT_PAGE_CHARS);
    if (this.artifacts) {
      const page = await this.artifacts.readPage({
        ref: resultRef,
        projectId,
        sessionId: request.sessionId,
        offset,
        limit,
      });
      if (!page) {
        throw new Error('The requested Agent result is unavailable in this session');
      }
      return {
        resultRef,
        sourceTool: page.toolName,
        sourceArguments: page.arguments,
        offset: page.offset,
        nextOffset: page.nextOffset,
        totalChars: page.charCount,
        totalBytes: page.byteCount,
        contentHash: page.contentHash,
        createdAt: page.createdAt,
        truncated: page.truncated,
        content: page.content,
        ...(page.truncated
          ? {
              reread: {
                tool: RESULT_PAGE_TOOL,
                arguments: {
                  resultRef,
                  offset: page.nextOffset,
                  limit,
                },
              },
            }
          : {}),
      };
    }
    const stored = this.storedResults.get(resultRef);
    if (!stored || stored.sessionId !== request.sessionId || stored.projectId !== projectId) {
      throw new Error('The requested Agent result is unavailable in this session');
    }
    const totalChars = codePointLength(stored.serialized);
    const content = sliceCodePoints(stored.serialized, offset, limit);
    const nextOffset = Math.min(totalChars, offset + codePointLength(content));
    return {
      resultRef,
      sourceTool: stored.toolName,
      sourceArguments: stored.arguments,
      offset,
      nextOffset,
      totalChars,
      truncated: nextOffset < totalChars,
      content,
      ...(nextOffset < totalChars
        ? {
            reread: {
              tool: RESULT_PAGE_TOOL,
              arguments: { resultRef, offset: nextOffset, limit },
            },
          }
        : {}),
    };
  }

  private storeResult(result: StoredReadResult): void {
    const existing = this.storedResults.get(result.ref);
    if (existing) {
      this.storedChars -= existing.serialized.length;
      this.storedResults.delete(result.ref);
    }
    this.storedResults.set(result.ref, result);
    this.storedChars += result.serialized.length;

    while (
      this.storedResults.size > this.maxStoredResults ||
      (this.storedChars > this.maxStoredChars && this.storedResults.size > 1)
    ) {
      const oldest = this.storedResults.entries().next().value as
        | [string, StoredReadResult]
        | undefined;
      if (!oldest) break;
      this.storedResults.delete(oldest[0]);
      this.storedChars -= oldest[1].serialized.length;
    }
  }
}

function durableReadProjectId(request: AgentToolExecutionRequest): string {
  const projectId = request.context.route.projectId;
  if (!projectId || request.context.route.kind === 'test') {
    throw new Error('A durable Agent read requires a project route');
  }
  return projectId;
}

function runtimeToolCallId(request: AgentToolExecutionRequest): string {
  return `agent-tool:${request.sessionId}:${request.turnId}:${request.callId}`;
}

function readReceiptId(request: AgentToolExecutionRequest): string {
  return `agent-read:${request.idempotencyKey}`;
}

function readObservationId(request: AgentToolExecutionRequest, ordinal: number): string {
  return `agent-observation:${request.idempotencyKey}:${ordinal}`;
}

function resolveObservedEntity<T extends { id: string }>(
  values: readonly T[],
  rawRef: unknown,
  label: (value: T) => string,
): T | null {
  const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
  if (!ref) return null;
  const direct = values.find((value) => value.id === ref);
  if (direct) return direct;
  const lowered = ref.toLocaleLowerCase();
  const matches = values.filter((value) => label(value).trim().toLocaleLowerCase() === lowered);
  return matches.length === 1 ? matches[0]! : null;
}

function normalizeObservedProseEntityType(value: string): ProseEntityType | null {
  if (value === 'node' || value === 'chapter' || value === 'drift') return 'node';
  if (value === 'element' || value === 'storyline' || value === 'category') return value;
  return null;
}

function resolveObservedProseEntity(
  entityType: ProseEntityType,
  projectId: string,
  ref: string,
): { id: string; updatedAt: string } | null {
  const state = useDataStore.getState();
  if (entityType === 'node') {
    return resolveObservedEntity(
      state.bookNodes.filter((entity) => entity.projectId === projectId),
      ref,
      (entity) => entity.title,
    );
  }
  if (entityType === 'element') {
    return resolveObservedEntity(
      state.bookElements.filter((entity) => entity.projectId === projectId),
      ref,
      (entity) => entity.name,
    );
  }
  if (entityType === 'storyline') {
    return resolveObservedEntity(
      state.storylines.filter((entity) => entity.projectId === projectId),
      ref,
      (entity) => entity.name,
    );
  }
  return resolveObservedEntity(
    state.bookElementCategories.filter((entity) => entity.projectId === projectId),
    ref,
    (entity) => entity.name,
  );
}

function resolveObservedRelationTarget(
  request: AgentToolExecutionRequest,
  projectId: string,
): { kind: string; id: string } | null {
  const rawKind = String(request.arguments.kind ?? '').trim();
  const ref = String(request.arguments.name ?? request.arguments.id ?? '').trim();
  if (!rawKind || !ref) return null;
  const entityType = normalizeObservedProseEntityType(rawKind);
  if (entityType) {
    const entity = resolveObservedProseEntity(entityType, projectId, ref);
    return entity ? { kind: entityType, id: entity.id } : null;
  }
  if (rawKind === 'comment') {
    // A curated relation can temporarily outlive its comment endpoint while a
    // cleanup batch is deleting both resources. The relation row remains the
    // source of truth for its own revision, so the deleted endpoint must not
    // make that relation impossible to read or remove.
    return { kind: 'comment', id: ref };
  }
  return { kind: rawKind, id: ref };
}

function proseObservation(
  request: AgentToolExecutionRequest,
  ordinal: number,
  entityType: ProseEntityType,
  entityId: string,
  prose: Pick<YjsProsePersistenceBase, 'revision' | 'stateVector' | 'stateHash'>,
): CreateAgentRuntimeReadObservation {
  return {
    id: readObservationId(request, ordinal),
    entityKind: `${entityType}_prose`,
    entityId,
    revision: `yjs:${prose.revision}`,
    stateVector: new Uint8Array(prose.stateVector),
    stateHash: prose.stateHash,
  };
}

function proseEntityTypeFromObservation(value: string): ProseEntityType | null {
  if (value === 'node_prose') return 'node';
  if (value === 'element_prose') return 'element';
  if (value === 'storyline_prose') return 'storyline';
  if (value === 'category_prose') return 'category';
  return null;
}

function assertReadReceiptProvenance(
  receipt: PersistedAgentRuntimeReadReceipt,
  request: AgentToolExecutionRequest,
): void {
  if (
    receipt.projectId !== durableReadProjectId(request) ||
    receipt.sessionId !== request.sessionId ||
    receipt.turnId !== request.turnId ||
    receipt.toolCallId !== runtimeToolCallId(request) ||
    receipt.callId !== request.callId ||
    receipt.toolName !== request.name ||
    receipt.idempotencyKey !== request.idempotencyKey
  ) {
    throw new Error('The durable Agent read receipt has conflicting provenance');
  }
}

export function createDriftingReadToolRuntime(
  options?: DriftingReadToolRuntimeOptions,
): AgentToolRuntime {
  return new DriftingReadToolRuntime(options);
}

function resultPageDefinition(): AgentToolDefinition {
  const schema = Type.Object(
    {
      resultRef: Type.String({
        minLength: 1,
        description: 'resultRef returned by a truncated read tool',
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: 'Unicode character offset, default 0',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_RESULT_PAGE_CHARS,
          description: `Maximum Unicode characters, up to ${MAX_RESULT_PAGE_CHARS}`,
        }),
      ),
    },
    { additionalProperties: false },
  );
  return {
    name: RESULT_PAGE_TOOL,
    description:
      'Continue reading a truncated tool result by resultRef. Use the returned reread arguments until truncated=false.',
    inputSchema: schema,
    access: 'read',
    validateInput: (input) => {
      if (!Value.Check(schema, input)) {
        return {
          ok: false,
          error: formatSchemaErrors(schema, input),
        };
      }
      return {
        ok: true,
        value: {
          resultRef: input.resultRef,
          offset: input.offset ?? 0,
          limit: input.limit ?? MAX_RESULT_PAGE_CHARS,
        },
      };
    },
  };
}

function askUserDefinition(): AgentToolDefinition {
  const tool = getRegisteredTool(ASK_USER_TOOL);
  if (!tool || tool.scope !== 'runtime-virtual') {
    throw new Error('The ask_user runtime contract is unavailable');
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parametersSchema,
    access: 'read',
    validateInput: (input) => validateToolInput(tool, input),
  };
}

function validateToolInput(tool: RegisteredTool, input: Record<string, unknown>) {
  if (Value.Check(tool.parametersSchema as TSchema, input)) {
    return { ok: true as const, value: input };
  }
  return {
    ok: false as const,
    error: formatSchemaErrors(tool.parametersSchema, input),
  };
}

function formatSchemaErrors(schema: object, input: unknown): string {
  const errors = [...Value.Errors(schema as TSchema, input)]
    .slice(0, 4)
    .map((error) => `${error.path || '/'} ${error.message}`);
  return errors.join('; ') || 'Input did not match the tool schema';
}

function serializeResult(data: unknown): string {
  if (typeof data === 'string') return data;
  const serialized = JSON.stringify(data);
  return serialized ?? '';
}

function publicToolError(error: unknown): string {
  if (!(error instanceof Error)) return 'Drifting tool execution failed';
  return error.message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .slice(0, 500);
}

function createDefaultProseBaseReader(): NonNullable<
  DriftingReadToolRuntimeOptions['readProseBase']
> {
  const coordinator = createYjsProsePersistenceCoordinator();
  return async (entityId, entityType = 'node') => {
    const state = useDataStore.getState();
    const contentJson =
      entityType === 'node'
        ? (await createBookContentRepository().findByNodeId(entityId))?.contentJson
        : entityType === 'element'
          ? state.bookElements.find((entity) => entity.id === entityId)?.contentJson
          : entityType === 'storyline'
            ? state.storylines.find((entity) => entity.id === entityId)?.contentJson
            : state.bookElementCategories.find((entity) => entity.id === entityId)?.contentJson;
    const seedStateUpdate = await createYjsProseSeedState(contentJson ?? '{}');
    const base = await coordinator.readBase(proseDocId(entityType, entityId), seedStateUpdate);
    return {
      revision: base.revision,
      stateVector: new Uint8Array(base.stateVector),
      stateHash: base.stateHash,
    };
  };
}

function bytesEqual(left: Uint8Array | null | undefined, right: Uint8Array): boolean {
  return (
    left instanceof Uint8Array &&
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function codePointLength(value: string): number {
  return [...value].length;
}

function sliceCodePoints(value: string, offset: number, limit: number): string {
  return [...value].slice(offset, offset + limit).join('');
}
