// Run one certified workspace tool (the General Agent's domain read/write
// surface) against a project without a mounted workspace. The developer CLI
// (src/dev-cli/offline-workspace.ts) and the app's built-in sample project
// share this path, so both write the same journaled SQLite rows and live Yjs
// prose as an Agent turn would. Platform-neutral: no Node or Tauri APIs.
//
// The tool handlers resolve names through the renderer stores, so every call
// first loads the target project into `useDataStore`/`useProjectStore`.
// Callers that run inside the app own saving and restoring those stores.

import { and, eq, isNotNull } from 'drizzle-orm';

import type { BookNode } from '../../domain/book-node';
import type { AgentRuntimeNodeWriteGuard } from '../../domain/agent-runtime-freshness';
import type { AgentToolContext, AgentWriteApi } from '../../lib/agent/tool-handlers';
import type { AgentAuthoredJournal } from '../../lib/agent/runtime/agent-authored-journal';
import { hashAgentPermissionArguments } from '../../lib/agent/runtime/control-plane';
import { createDriftingAgentProductComposition } from '../../lib/agent/runtime/drifting-product-composition';
import {
  isDriftingDomainReadToolName,
  isDriftingDomainWriteToolName,
} from '../../lib/agent/runtime/drifting-workspace-tool-contract';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
} from '../../lib/agent/runtime/types';
import type { DbClient } from '../../lib/db';
import {
  AgentConversationTable,
  ElementCategoryTable,
  EntityRelationTable,
  NodeStorylineLinkTable,
  BookNodeTable,
  StorylineTable,
} from '../../schema/drizzle';
import { createBlockSectionRepository } from '../../sqlite-repo/block-section-repo';
import { createBookActRepository } from '../../sqlite-repo/book-act-repo';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createBookElementSqliteRepository } from '../../sqlite-repo/element-repo';
import { createElementCategoryRepository } from '../../sqlite-repo/element-category-repo';
import {
  createCommentActionRepository,
  createCommentRepository,
} from '../../sqlite-repo/comment-repo';
import { createDriftGroupRepository } from '../../sqlite-repo/drift-group-repo';
import { createEntityRelationTypeRepository } from '../../sqlite-repo/entity-relation-type-repo';
import { createLibraryItemSqliteRepository } from '../../sqlite-repo/library-item-repo';
import { createBookNodeSqliteRepository } from '../../sqlite-repo/node-repo';
import { createProjectAssetSqliteRepository } from '../../sqlite-repo/project-asset-repo';
import { createProjectRepository } from '../../sqlite-repo/project-repo';
import { createStorylineRepository } from '../../sqlite-repo/storyline-repo';
import { createTimelineMarkerRepository } from '../../sqlite-repo/timeline-marker-repo';
import { useDataStore, trashedKey, type EntityRelationLink } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';
import {
  persistBookNodeUpdateWithSync,
  type BookNodeAtomicTransactionRunner,
} from '../../usecase/book-node-write';

/** A failure with a stable code; the developer CLI maps it onto its envelope. */
export class HeadlessWorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HeadlessWorkspaceError';
  }
}

export interface HeadlessWorkspaceCallResult {
  result: AgentToolExecutionResult;
  sessionId: string;
  turnId: string;
  callId: string;
}

/**
 * The Agent runtime conversation/session that owns the tool-call ledger of a
 * headless writer. The CLI keeps its audit conversation; the built-in sample
 * removes its bookkeeping conversation once the project is complete.
 */
export interface HeadlessWorkspaceRoute {
  conversationId: string;
  conversationTitle: string;
  sessionId: string;
  provider: string;
  /** Turn ids are `${turnIdPrefix}:${requestId}`. */
  turnIdPrefix: string;
}

export interface HeadlessWorkspaceWriter {
  runAtomic: BookNodeAtomicTransactionRunner;
  authoredJournal: AgentAuthoredJournal;
}

function unsupported(name: keyof AgentWriteApi): (...args: unknown[]) => Promise<never> {
  return async () => {
    throw new Error(`Headless write API method ${name} is not a certified headless path`);
  };
}

function nodeSyncPayload(node: BookNode): Record<string, unknown> {
  return {
    title: node.title,
    bookOrder: node.bookOrder,
    narrativeOrder: node.narrativeOrder,
    summary: node.summary,
    kind: node.kind,
    driftGroupId: node.driftGroupId,
    positionX: node.position.x,
    positionY: node.position.y,
    wordCount: node.wordCount,
    wordCountBasisKind: node.wordCountBasisKind ?? null,
    wordCountBasisHash: node.wordCountBasisHash ?? null,
    wordCountBasisRevision: node.wordCountBasisRevision ?? null,
    wordCountBasisServerSeq: node.wordCountBasisServerSeq ?? null,
    writingStatus: node.writingStatus,
  };
}

function createHeadlessWriteApi(
  database: DbClient,
  projectId: string,
  runAtomic: BookNodeAtomicTransactionRunner,
): AgentWriteApi {
  const nodeRepository = createBookNodeSqliteRepository(projectId, database);
  const contentRepository = createBookContentRepository(database);
  const updateNode = async (
    id: string,
    updates: Partial<BookNode> & { mainStorylineId?: string | null },
    guard?: AgentRuntimeNodeWriteGuard,
  ) => {
    const current = await nodeRepository.findById(id);
    if (!current) throw new Error(`Node ${id} not found`);
    const { mainStorylineId: _legacy, position, ...rest } = updates;
    void _legacy;
    const nextUpdatedAt = new Date().toISOString();
    const projected = {
      ...current,
      ...rest,
      ...(position ? { position } : {}),
      updatedAt: nextUpdatedAt,
    } as BookNode;
    const result = await persistBookNodeUpdateWithSync(
      {
        projectId,
        nodeId: id,
        updates: { ...rest, ...(position ? { position } : {}), updatedAt: nextUpdatedAt },
        syncPayload: nodeSyncPayload(projected),
        ...(guard ? { guard } : {}),
      },
      runAtomic,
    );
    useDataStore.getState().updateBookNode(id, result);
    return result;
  };
  return {
    updateNode,
    renameNode: (id, title, guard) => updateNode(id, { title }, guard),
    updateContentByNodeId: (nodeId, updates) => contentRepository.updateByNodeId(nodeId, updates),
    updateElement: unsupported('updateElement'),
    createElement: unsupported('createElement'),
    addNodeToStoryline: unsupported('addNodeToStoryline'),
    removeNodeFromStoryline: unsupported('removeNodeFromStoryline'),
    setNodeStorylines: unsupported('setNodeStorylines'),
    addRelation: unsupported('addRelation'),
    removeRelation: unsupported('removeRelation'),
    updateRelationType: unsupported('updateRelationType'),
    createRelationType: unsupported('createRelationType'),
    updateRelationTypeDefinition: unsupported('updateRelationTypeDefinition'),
    deleteRelationType: unsupported('deleteRelationType'),
    removeElement: unsupported('removeElement'),
    createStoryline: unsupported('createStoryline'),
    updateStoryline: unsupported('updateStoryline'),
    createCategory: unsupported('createCategory'),
    updateCategory: unsupported('updateCategory'),
    updateProject: unsupported('updateProject'),
    createNode: unsupported('createNode'),
    createComment: unsupported('createComment'),
    deleteComment: unsupported('deleteComment'),
    resolveComment: unsupported('resolveComment'),
    reopenComment: unsupported('reopenComment'),
    convertToTodo: unsupported('convertToTodo'),
    revertToNote: unsupported('revertToNote'),
  } as AgentWriteApi;
}

/** Load one project into the renderer stores the tool handlers read. */
export async function hydrateHeadlessWorkspace(
  database: DbClient,
  projectId: string,
  runAtomic: BookNodeAtomicTransactionRunner,
): Promise<AgentToolContext> {
  const project = await createProjectRepository(undefined, database).findById(projectId);
  if (!project) throw new HeadlessWorkspaceError('PROJECT_NOT_FOUND', `Project ${projectId} was not found`);
  const nodeRepository = createBookNodeSqliteRepository(projectId, database);
  const elementRepository = createBookElementSqliteRepository(projectId, database);
  const categoryRepository = createElementCategoryRepository(projectId, database);
  const storylineRepository = createStorylineRepository(projectId, database);
  const [
    nodes,
    trashedNodes,
    elements,
    trashedElements,
    categories,
    storylines,
    comments,
    commentActions,
    relationTypes,
    blockSections,
    libraryItems,
    assets,
    bookActs,
    driftGroups,
    timelineMarkers,
    memberships,
    relations,
    trashedCategories,
    trashedStorylines,
  ] = await Promise.all([
    nodeRepository.findAll(),
    nodeRepository.findTrashed(),
    elementRepository.findAll(),
    elementRepository.findTrashed(),
    categoryRepository.findAll(),
    storylineRepository.getStorylinesByProject(),
    createCommentRepository(projectId, database).findAll(),
    createCommentActionRepository(projectId, database).findAll(),
    createEntityRelationTypeRepository(projectId, database).list(),
    createBlockSectionRepository(database).findByProject(projectId),
    createLibraryItemSqliteRepository(projectId, database).findAll(),
    createProjectAssetSqliteRepository(projectId, database).findAll(),
    createBookActRepository(projectId, database).findAll(),
    createDriftGroupRepository(projectId, database).findAll(),
    createTimelineMarkerRepository(projectId, database).findAll(),
    database
      .select({
        nodeId: NodeStorylineLinkTable.nodeId,
        storylineId: NodeStorylineLinkTable.storylineId,
        isPrimary: NodeStorylineLinkTable.isPrimary,
      })
      .from(NodeStorylineLinkTable)
      .innerJoin(BookNodeTable, eq(BookNodeTable.id, NodeStorylineLinkTable.nodeId))
      .where(eq(BookNodeTable.projectId, projectId)),
    database.select().from(EntityRelationTable).where(eq(EntityRelationTable.projectId, projectId)),
    database
      .select({ id: ElementCategoryTable.id })
      .from(ElementCategoryTable)
      .where(
        and(
          eq(ElementCategoryTable.projectId, projectId),
          isNotNull(ElementCategoryTable.deletedAt),
        ),
      ),
    database
      .select({ id: StorylineTable.id })
      .from(StorylineTable)
      .where(and(eq(StorylineTable.projectId, projectId), isNotNull(StorylineTable.deletedAt))),
  ]);
  const storylineNodeMapping: Record<string, string[]> = {};
  const primaryStorylineByNode: Record<string, string | null> = {};
  for (const link of memberships) {
    storylineNodeMapping[link.storylineId] = [
      ...(storylineNodeMapping[link.storylineId] ?? []),
      link.nodeId,
    ];
    if (link.isPrimary) primaryStorylineByNode[link.nodeId] = link.storylineId;
  }
  for (const node of nodes) primaryStorylineByNode[node.id] ??= null;
  const trashed = new Set<string>();
  trashedNodes.forEach((item) => trashed.add(trashedKey('node', item.id)));
  trashedElements.forEach((item) => trashed.add(trashedKey('element', item.id)));
  trashedCategories.forEach((item) => trashed.add(trashedKey('category', item.id)));
  trashedStorylines.forEach((item) => trashed.add(trashedKey('storyline', item.id)));
  const state = useDataStore.getState();
  state.setBookNodes(nodes);
  state.setStorylines(storylines);
  state.setNodeStorylineState(storylineNodeMapping, primaryStorylineByNode);
  state.setBookElements(elements);
  state.setBookElementCategories(categories);
  state.setComments(comments);
  state.setCommentActions(commentActions);
  state.setEntityRelationTypes(relationTypes);
  state.setEntityRelations(relations as EntityRelationLink[]);
  state.setBlockSections(blockSections);
  state.setLibraryItems(libraryItems);
  state.setProjectAssets(assets);
  state.setBookActs(bookActs);
  state.setDriftGroups(driftGroups);
  state.setTimelineMarkers(timelineMarkers);
  state.setTrashedEntityIds(trashed);
  useProjectStore.getState().setCurrentProject(project);
  useProjectStore.getState().setProjects([project]);
  return { projectId, write: createHeadlessWriteApi(database, projectId, runAtomic) };
}

/** A tool composition over the hydrated project, for reads or descriptions. */
export function createHeadlessWorkspaceComposition(
  database: DbClient,
  context: AgentToolContext,
  authoredJournal: AgentAuthoredJournal,
) {
  return createDriftingAgentProductComposition({
    database,
    getContext: () => context,
    authoredJournal,
  });
}

export function headlessRuntimeContext(projectId: string, conversationId: string): AgentRuntimeContext {
  return { route: { kind: 'chat', projectId, conversationId } };
}

function wholeBodyPreflight(
  toolName: string,
  args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } | null {
  switch (toolName) {
    case 'replace_chapter_body':
      return { name: 'read_chapter', arguments: { chapter: args.chapter } };
    case 'replace_inspiration_body':
      return { name: 'read_inspiration', arguments: { inspiration: args.inspiration } };
    case 'replace_element_body':
      return { name: 'read_element', arguments: { element: args.element } };
    case 'replace_storyline_body':
      return { name: 'read_storyline', arguments: { storyline: args.storyline } };
    case 'replace_element_category_body':
      return { name: 'read_element_category', arguments: { category: args.category } };
    default:
      return null;
  }
}

/**
 * Execute one domain tool as an author-approved Agent call: the call, its
 * write effect and the authored journal entry are recorded under `route`.
 */
export async function executeHeadlessWorkspaceTool(input: {
  database: DbClient;
  projectId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestId: string;
  writer: HeadlessWorkspaceWriter;
  route: HeadlessWorkspaceRoute;
}): Promise<HeadlessWorkspaceCallResult> {
  const access = isDriftingDomainReadToolName(input.toolName)
    ? 'read'
    : isDriftingDomainWriteToolName(input.toolName)
      ? 'write'
      : null;
  if (!access)
    throw new HeadlessWorkspaceError('UNKNOWN_WORKSPACE_TOOL', `Unknown workspace tool: ${input.toolName}`);
  const context = await hydrateHeadlessWorkspace(input.database, input.projectId, input.writer.runAtomic);
  const composition = createHeadlessWorkspaceComposition(
    input.database,
    context,
    input.writer.authoredJournal,
  );
  const { sessionId, conversationId } = input.route;
  const turnId = `${input.route.turnIdPrefix}:${input.requestId}`;
  const callId = 'call';
  const idempotencyKey = `${sessionId}:${turnId}:${callId}`;
  const persistence = composition.repositories.runtime;
  const now = new Date().toISOString();
  await input.database
    .insert(AgentConversationTable)
    .values({
      id: conversationId,
      projectId: input.projectId,
      title: input.route.conversationTitle,
      sdkSessionId: null,
      runtimeSessionId: null,
      mode: 'byok',
      messagesJson: '[]',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  if (!(await persistence.getSession(sessionId))) {
    await persistence.createSession({
      id: sessionId,
      projectId: input.projectId,
      routeKind: 'chat',
      conversationId,
      goalRunId: null,
      chapterId: null,
      provider: input.route.provider,
      model: null,
      providerEpoch: 0,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
  }
  if (!(await persistence.getTurn(turnId))) {
    const turns = await persistence.listTurns(sessionId);
    await persistence.createTurn({
      id: turnId,
      sessionId,
      ordinal: turns.reduce((maximum, turn) => Math.max(maximum, turn.ordinal), 0) + 1,
      status: 'running',
      promptMessageId: null,
      acceptedAt: now,
      startedAt: now,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    });
  }
  const request: AgentToolExecutionRequest = {
    sessionId,
    turnId,
    callId,
    idempotencyKey,
    name: input.toolName,
    arguments: input.arguments,
    access,
    context: headlessRuntimeContext(input.projectId, conversationId),
    control: {
      requestUserInput: async () => {
        throw new HeadlessWorkspaceError(
          'INTERACTIVE_INPUT_REQUIRED',
          'The workspace tool requires interactive input',
        );
      },
    },
    signal: new AbortController().signal,
    ...(access === 'write'
      ? {
          authorization: {
            kind: 'author_approved' as const,
            requestId: `permission:${input.requestId}`,
            argumentsHash: await hashAgentPermissionArguments(input.arguments),
          },
        }
      : {}),
  };
  const preflight = access === 'write' ? wholeBodyPreflight(input.toolName, input.arguments) : null;
  if (preflight) {
    let cursor = 0;
    for (let page = 0; page < 10_000; page += 1) {
      const preflightCallId = `preflight-${page}`;
      const preflightArguments = {
        ...preflight.arguments,
        cursor,
        maxCharacters: 32_000,
      };
      const preflightKey = `${sessionId}:${turnId}:${preflightCallId}`;
      await persistence.createToolCall({
        id: `agent-tool:${sessionId}:${turnId}:${preflightCallId}`,
        sessionId,
        turnId,
        callId: preflightCallId,
        name: preflight.name,
        access: 'read',
        status: 'running',
        idempotencyKey: preflightKey,
        arguments: preflightArguments,
        result: null,
        errorCode: null,
        createdAt: now,
        startedAt: now,
        completedAt: null,
      });
      const preflightResult = await composition.workspaceTools.execute({
        ...request,
        callId: preflightCallId,
        idempotencyKey: preflightKey,
        name: preflight.name,
        arguments: preflightArguments,
        access: 'read',
        authorization: undefined,
      });
      if (!preflightResult.ok) {
        throw new HeadlessWorkspaceError('WORKSPACE_PREFLIGHT_FAILED', preflightResult.error, preflightResult);
      }
      const data =
        preflightResult.data && typeof preflightResult.data === 'object'
          ? (preflightResult.data as Record<string, unknown>)
          : {};
      if (data.truncated !== true) break;
      if (typeof data.nextOffset !== 'number' || data.nextOffset <= cursor) {
        throw new HeadlessWorkspaceError(
          'WORKSPACE_PREFLIGHT_STALLED',
          'The authored-body reading cursor did not advance',
        );
      }
      cursor = data.nextOffset;
    }
  }
  await persistence.createToolCall({
    id: `agent-tool:${sessionId}:${turnId}:${callId}`,
    sessionId,
    turnId,
    callId,
    name: input.toolName,
    access,
    status: 'running',
    idempotencyKey,
    arguments: input.arguments,
    result: null,
    errorCode: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
  });
  const result =
    access === 'read'
      ? await composition.workspaceTools.execute(request)
      : await composition.tools.execute(request);
  return { result, sessionId, turnId, callId };
}

/** A scenario step the sample recipe emits: one certified workspace call. */
export interface WorkspaceCallStep {
  kind: 'workspace.call';
  tool: string;
  input?: Record<string, unknown>;
  expect?: { ok?: boolean };
}

/**
 * Run workspace calls in order and stop at the first failed or unexpected
 * result. `onStep` reports progress after each committed step.
 */
export async function runHeadlessWorkspaceSteps(input: {
  database: DbClient;
  projectId: string;
  steps: readonly WorkspaceCallStep[];
  requestId: string;
  writer: HeadlessWorkspaceWriter;
  route: HeadlessWorkspaceRoute;
  onStep?: (completed: number, total: number) => void;
}): Promise<void> {
  for (const [index, step] of input.steps.entries()) {
    const call = await executeHeadlessWorkspaceTool({
      database: input.database,
      projectId: input.projectId,
      toolName: step.tool,
      arguments: step.input ?? {},
      requestId: `${input.requestId}-step-${index + 1}`,
      writer: input.writer,
      route: input.route,
    });
    const expected = step.expect?.ok ?? true;
    if (call.result.ok !== expected) {
      throw new HeadlessWorkspaceError(
        'SCENARIO_STEP_FAILED',
        `Step ${index + 1} (${step.tool}) expected ok=${expected}, received ok=${call.result.ok}`,
        call.result,
      );
    }
    input.onStep?.(index + 1, input.steps.length);
  }
}
