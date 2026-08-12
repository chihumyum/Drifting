import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { and, eq, isNotNull } from 'drizzle-orm';

import type { BookNode } from '../renderer/domain/book-node';
import type { AgentRuntimeNodeWriteGuard } from '../renderer/domain/agent-runtime-freshness';
import type { AgentToolContext, AgentWriteApi } from '../renderer/lib/agent/tool-handlers';
import { createDriftingAgentProductComposition } from '../renderer/lib/agent/runtime/drifting-product-composition';
import {
  isDriftingDomainReadToolName,
  isDriftingDomainWriteToolName,
} from '../renderer/lib/agent/runtime/drifting-workspace-tool-contract';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
} from '../renderer/lib/agent/runtime/types';
import type { DbClient, DbTransaction } from '../renderer/lib/db';
import {
  AgentConversationTable,
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntityRelationTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
} from '../renderer/schema/drizzle';
import { createBlockSectionRepository } from '../renderer/sqlite-repo/block-section-repo';
import { createBookActRepository } from '../renderer/sqlite-repo/book-act-repo';
import { createBookContentRepository } from '../renderer/sqlite-repo/content-repo';
import { createBookElementSqliteRepository } from '../renderer/sqlite-repo/element-repo';
import { createElementCategoryRepository } from '../renderer/sqlite-repo/element-category-repo';
import {
  createCommentActionRepository,
  createCommentRepository,
} from '../renderer/sqlite-repo/comment-repo';
import { createDriftGroupRepository } from '../renderer/sqlite-repo/drift-group-repo';
import { createEntityRelationTypeRepository } from '../renderer/sqlite-repo/entity-relation-type-repo';
import { createLibraryItemSqliteRepository } from '../renderer/sqlite-repo/library-item-repo';
import { createBookNodeSqliteRepository } from '../renderer/sqlite-repo/node-repo';
import { createProjectAssetSqliteRepository } from '../renderer/sqlite-repo/project-asset-repo';
import { createProjectRepository } from '../renderer/sqlite-repo/project-repo';
import { createStorylineRepository } from '../renderer/sqlite-repo/storyline-repo';
import { createTimelineMarkerRepository } from '../renderer/sqlite-repo/timeline-marker-repo';
import { persistSyncMutationInTransaction } from '../renderer/services/entity-sync.service';
import { useDataStore, trashedKey, type EntityRelationLink } from '../renderer/store/data-store';
import { useProjectStore } from '../renderer/store/project-store';
import { useSettingsStore } from '../renderer/store/settings-store';
import {
  persistBookNodeUpdateWithSync,
  type BookNodeAtomicTransactionRunner,
} from '../renderer/usecase/book-node-write';
import type { AtomicSyncWriter } from '../renderer/usecase/sync-helpers';
import { DEV_CLI_PROVIDER_TOOLS, DEV_CLI_TABLE_MODEL_COVERAGE } from './manifest';
import { CliError } from './protocol';

export interface WorkspaceCallResult {
  result: AgentToolExecutionResult;
  sessionId: string;
  turnId: string;
  callId: string;
}

export interface WorkspaceToolDescription {
  name: string;
  description: string;
  inputSchema: object;
  access: 'read' | 'write';
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function argumentHash(value: Record<string, unknown>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex')}`;
}

function createAtomicRunner(database: DbClient): BookNodeAtomicTransactionRunner {
  return (projectId, work) =>
    database.transaction(
      async (tx) => {
        const sync: AtomicSyncWriter = async (
          entityType,
          mutationType,
          entityId,
          mutationProjectId,
          payload,
          parentId,
        ) => {
          if (mutationProjectId !== projectId)
            throw new Error('Cross-project CLI mutation refused');
          await persistSyncMutationInTransaction(tx as DbTransaction, {
            entityType,
            mutationType,
            entityId,
            projectId,
            payload,
            parentId,
            timestamp: Date.now(),
          });
        };
        return work(tx as DbTransaction, sync);
      },
      { behavior: 'immediate' },
    );
}

function unsupported(name: keyof AgentWriteApi): (...args: unknown[]) => Promise<never> {
  return async () => {
    throw new Error(`Headless write API method ${name} is not a certified CLI path`);
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
    writingStatus: node.writingStatus,
  };
}

function createHeadlessWriteApi(database: DbClient, projectId: string): AgentWriteApi {
  const nodeRepository = createBookNodeSqliteRepository(projectId, database);
  const contentRepository = createBookContentRepository(database);
  const runAtomic = createAtomicRunner(database);
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
    updateRelationKind: unsupported('updateRelationKind'),
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
    setCommentKind: unsupported('setCommentKind'),
  } as AgentWriteApi;
}

async function hydrateWorkspace(database: DbClient, projectId: string): Promise<AgentToolContext> {
  const project = await createProjectRepository(undefined, database).findById(projectId);
  if (!project) throw new CliError('PROJECT_NOT_FOUND', `Project ${projectId} was not found`);
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
  useSettingsStore.getState().setAgentEditMode('auto');
  return { projectId, write: createHeadlessWriteApi(database, projectId) };
}

function runtimeContext(projectId: string, conversationId: string): AgentRuntimeContext {
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

export async function executeOfflineWorkspaceTool(input: {
  database: DbClient;
  projectId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestId: string;
}): Promise<WorkspaceCallResult> {
  const access = isDriftingDomainReadToolName(input.toolName)
    ? 'read'
    : isDriftingDomainWriteToolName(input.toolName)
      ? 'write'
      : null;
  if (!access)
    throw new CliError('UNKNOWN_WORKSPACE_TOOL', `Unknown workspace tool: ${input.toolName}`);
  const context = await hydrateWorkspace(input.database, input.projectId);
  const composition = createDriftingAgentProductComposition({
    database: input.database,
    getContext: () => context,
  });
  const sessionId = `cli-workspace-session:${input.projectId}`;
  const conversationId = `cli-workspace-conversation:${input.projectId}`;
  const turnId = `cli-turn:${input.requestId}`;
  const callId = 'call';
  const idempotencyKey = `${sessionId}:${turnId}:${callId}`;
  const persistence = composition.repositories.runtime;
  const now = new Date().toISOString();
  await input.database
    .insert(AgentConversationTable)
    .values({
      id: conversationId,
      projectId: input.projectId,
      title: 'Developer CLI workspace',
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
      provider: 'dev-cli',
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
    context: runtimeContext(input.projectId, conversationId),
    control: {
      requestUserInput: async () => {
        throw new CliError(
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
            argumentsHash: argumentHash(input.arguments),
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
        throw new CliError('WORKSPACE_PREFLIGHT_FAILED', preflightResult.error, preflightResult);
      }
      const data =
        preflightResult.data && typeof preflightResult.data === 'object'
          ? (preflightResult.data as Record<string, unknown>)
          : {};
      if (data.truncated !== true) break;
      if (typeof data.nextOffset !== 'number' || data.nextOffset <= cursor) {
        throw new CliError(
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

export async function describeOfflineWorkspaceTools(
  database: DbClient,
  projectId: string,
  toolName?: string,
): Promise<{ count: number; tools: WorkspaceToolDescription[] }> {
  const context = await hydrateWorkspace(database, projectId);
  const composition = createDriftingAgentProductComposition({
    database,
    getContext: () => context,
  });
  const agentContext = runtimeContext(projectId, `cli-workspace-describe:${projectId}`);
  const publicNames = new Set<string>([
    ...DEV_CLI_PROVIDER_TOOLS.read,
    ...DEV_CLI_PROVIDER_TOOLS.write,
  ]);
  const definitions = [
    ...composition.workspaceTools.listDefinitions(agentContext),
    ...composition.tools.listDefinitions(agentContext),
  ]
    .filter((definition) => publicNames.has(definition.name))
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      access: definition.access,
    }));
  const tools = toolName
    ? definitions.filter((definition) => definition.name === toolName)
    : definitions;
  if (toolName && tools.length === 0) {
    throw new CliError('UNKNOWN_WORKSPACE_TOOL', `Unknown workspace tool: ${toolName}`);
  }
  return { count: tools.length, tools };
}

export async function inspectWorkspaceDatabase(
  database: DbClient,
  sqlite: DatabaseSync,
  projectId?: string,
): Promise<unknown> {
  const projectRows = projectId
    ? await database.select().from(ProjectTable).where(eq(ProjectTable.id, projectId))
    : await database.select().from(ProjectTable);
  const projects = [];
  for (const project of projectRows) {
    const [nodes, storylines, categories, elements] = await Promise.all([
      database.select().from(BookNodeTable).where(eq(BookNodeTable.projectId, project.id)),
      database.select().from(StorylineTable).where(eq(StorylineTable.projectId, project.id)),
      database
        .select()
        .from(ElementCategoryTable)
        .where(eq(ElementCategoryTable.projectId, project.id)),
      database.select().from(BookElementTable).where(eq(BookElementTable.projectId, project.id)),
    ]);
    projects.push({
      id: project.id,
      name: project.name,
      counts: {
        nodes: nodes.length,
        storylines: storylines.length,
        categories: categories.length,
        elements: elements.length,
      },
    });
  }
  const tables = Object.entries(DEV_CLI_TABLE_MODEL_COVERAGE).map(([table, model]) => {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
    }>;
    const totalRow = sqlite.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as {
      count: number;
    };
    let projectRows: number | null = null;
    if (projectId && columns.some((column) => column.name === 'project_id')) {
      const row = sqlite
        .prepare(`SELECT count(*) AS count FROM "${table}" WHERE project_id = ?`)
        .get(projectId) as { count: number };
      projectRows = Number(row.count);
    } else if (projectId && table === 'project') {
      const row = sqlite
        .prepare('SELECT count(*) AS count FROM project WHERE id = ?')
        .get(projectId) as { count: number };
      projectRows = Number(row.count);
    }
    return {
      table,
      model,
      rows: Number(totalRow.count),
      ...(projectId ? { projectRows } : {}),
    };
  });
  return {
    projects,
    tables,
    tableCount: tables.length,
    ...(projectId
      ? {
          projectScopeNote:
            'projectRows is null when the table has no direct project_id; rows is always the database-wide count.',
        }
      : {}),
  };
}
