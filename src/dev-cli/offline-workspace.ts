import type { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { createAgentAuthoredJournal } from '../renderer/lib/agent/runtime/agent-authored-journal';
import type { DbClient, DbTransaction } from '../renderer/lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  ProjectTable,
  StorylineTable,
} from '../renderer/schema/drizzle';
import {
  createHeadlessWorkspaceComposition,
  executeHeadlessWorkspaceTool,
  HeadlessWorkspaceError,
  headlessRuntimeContext,
  hydrateHeadlessWorkspace,
  type HeadlessWorkspaceCallResult,
  type HeadlessWorkspaceRoute,
} from '../renderer/services/sample-project/headless-workspace';
import {
  appendAuthoredDomainMutation,
  createAuthoredTransactionRunner,
} from '../renderer/sync/journal';
import type { BookNodeAtomicTransactionRunner } from '../renderer/usecase/book-node-write';
import type { AtomicSyncWriter } from '../renderer/usecase/sync-helpers';
import { DEV_CLI_PROVIDER_TOOLS, DEV_CLI_TABLE_MODEL_COVERAGE } from './manifest';
import { CliError } from './protocol';

export type WorkspaceCallResult = HeadlessWorkspaceCallResult;

export interface WorkspaceToolDescription {
  name: string;
  description: string;
  inputSchema: object;
  access: 'read' | 'write';
}

const DEV_CLI_SYNC_IDENTITY = {
  installationId: 'drifting-dev-cli',
  createWriterIdentity: () => ({
    writerId: `writer-${uuidv7()}`,
    writerEpoch: `epoch-${uuidv7()}`,
  }),
};

const DEV_CLI_SYNC_GENERATION_IDS = {
  createSyncGenerationId: () => `sync-generation-${uuidv7()}`,
  createProjectSyncId: () => `project-sync-${uuidv7()}`,
};

export function createDevCliAgentAuthoredJournal() {
  return createAgentAuthoredJournal({
    identity: async () => DEV_CLI_SYNC_IDENTITY,
    syncGenerationIds: DEV_CLI_SYNC_GENERATION_IDS,
  });
}

/** One authored, journaled domain transaction under the developer CLI's writer. */
export function createAtomicRunner(database: DbClient): BookNodeAtomicTransactionRunner {
  const runAuthored = createAuthoredTransactionRunner({
    database: () => database,
    identity: async () => DEV_CLI_SYNC_IDENTITY,
    clock: () => {
      const now = new Date();
      return { nowMs: now.getTime(), nowIso: now.toISOString() };
    },
    syncGenerationIds: DEV_CLI_SYNC_GENERATION_IDS,
  });
  return (projectId, work) =>
    runAuthored(projectId, 'dev-cli.domain-write', async ({ tx, changes }) => {
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
          appendAuthoredDomainMutation(changes, {
            entityType,
            mutationType,
            entityId,
            projectId,
            payload,
            parentId,
          });
        };
        return work(tx as DbTransaction, sync, changes);
      });
}

/** The CLI's retained audit conversation for every workspace call. */
function cliWorkspaceRoute(projectId: string): HeadlessWorkspaceRoute {
  return {
    conversationId: `cli-workspace-conversation:${projectId}`,
    conversationTitle: 'Developer CLI workspace',
    sessionId: `cli-workspace-session:${projectId}`,
    provider: 'dev-cli',
    turnIdPrefix: 'cli-turn',
  };
}

function asCliError(error: unknown): unknown {
  return error instanceof HeadlessWorkspaceError
    ? new CliError(error.code, error.message, error.details)
    : error;
}

export async function executeOfflineWorkspaceTool(input: {
  database: DbClient;
  projectId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestId: string;
}): Promise<WorkspaceCallResult> {
  try {
    return await executeHeadlessWorkspaceTool({
      ...input,
      writer: {
        runAtomic: createAtomicRunner(input.database),
        authoredJournal: createDevCliAgentAuthoredJournal(),
      },
      route: cliWorkspaceRoute(input.projectId),
    });
  } catch (error) {
    throw asCliError(error);
  }
}

export async function describeOfflineWorkspaceTools(
  database: DbClient,
  projectId: string,
  toolName?: string,
): Promise<{ count: number; tools: WorkspaceToolDescription[] }> {
  let context;
  try {
    context = await hydrateHeadlessWorkspace(database, projectId, createAtomicRunner(database));
  } catch (error) {
    throw asCliError(error);
  }
  const composition = createHeadlessWorkspaceComposition(
    database,
    context,
    createDevCliAgentAuthoredJournal(),
  );
  const agentContext = headlessRuntimeContext(projectId, `cli-workspace-describe:${projectId}`);
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
