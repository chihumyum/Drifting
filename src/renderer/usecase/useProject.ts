import { useCallback, useMemo } from 'react';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { isProseMetricBasisHash } from '@drifting/prose-metrics';

import type { Project } from '../domain/project';
import { createProjectRepository } from '../sqlite-repo/project-repo';
import { getDb, initDatabase } from '../lib/db';
import apiClient from '../lib/axios-config';
import { isSyncEnabled } from '../lib/config';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import { v7 as uuidv7 } from 'uuid';
import { withAtomicSyncTransaction } from './sync-helpers';
import { defaultProjectKvJson } from '../domain/kv';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntityRelationTable,
  InlineMentionTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
} from '../schema/drizzle';
import LogLevel from 'loglevel';
import { cancelAssetUploadsForProjectDeletion } from '../services/durable-asset-upload.service';
const log = LogLevel.getLogger('UseProject');
log.setLevel(LogLevel.levels.WARN);

export interface CreateProjectInput {
  projectName?: string | null;
}

// Partial so callers can target specific fields (e.g. just `kvJson`) without
// having to round-trip every project property they don't care about. The
// repo's update layer already merges against the existing row.
export type UpdateProjectInput = Partial<
  Omit<Project, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
>;

export interface UseProjectContext {
  userId: string;
}

export interface ProjectStats {
  nodes: number;
  words: number;
  wordsReady: boolean;
  storylines: number;
  storylineLinks: number;
  elements: number;
  categories: number;
  entityRelations: number;
  inlineMentions: number;
}

export type ProjectSummary = Project & {
  stats: ProjectStats;
  source: 'local' | 'server';
};

type ServerProjectSummary = {
  id: string;
  userId: string;
  name: string;
  summary?: string | null;
  kvJson?: string | null;
  storylineTemplateKvJson?: string | null;
  createdAt: string;
  updatedAt: string;
  stats?: Partial<ProjectStats> | null;
};

const EMPTY_PROJECT_STATS: ProjectStats = {
  nodes: 0,
  words: 0,
  wordsReady: false,
  storylines: 0,
  storylineLinks: 0,
  elements: 0,
  categories: 0,
  entityRelations: 0,
  inlineMentions: 0,
};

function createRequestId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function emitSyncOperation(event: Omit<SyncOperationEvent, 'at'>): void {
  events.emit('sync:operation', { ...event, at: Date.now() });
}

function normalizeDateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return new Date().toISOString();
}

function normalizeProjectStats(stats?: Partial<ProjectStats> | null): ProjectStats {
  return {
    ...EMPTY_PROJECT_STATS,
    ...stats,
  };
}

function normalizeServerProjectSummary(row: ServerProjectSummary, userId: string): ProjectSummary {
  return {
    id: row.id,
    userId: row.userId || userId,
    name: row.name,
    summary: row.summary ?? '',
    kvJson: row.kvJson ?? '[]',
    storylineTemplateKvJson: row.storylineTemplateKvJson ?? '[]',
    createdAt: normalizeDateText(row.createdAt),
    updatedAt: normalizeDateText(row.updatedAt),
    stats: normalizeProjectStats(row.stats),
    source: 'server',
  };
}

function sortProjectSummaries(a: ProjectSummary, b: ProjectSummary): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

async function buildLocalProjectStats(projectId: string): Promise<ProjectStats> {
  const db = getDb();
  const [
    nodes,
    storylines,
    elements,
    elementCategories,
  ] = await Promise.all([
    db
      .select({
        id: BookNodeTable.id,
        kind: BookNodeTable.kind,
        wordCount: BookNodeTable.wordCount,
        wordCountBasisKind: BookNodeTable.wordCountBasisKind,
        wordCountBasisHash: BookNodeTable.wordCountBasisHash,
        wordCountBasisRevision: BookNodeTable.wordCountBasisRevision,
        wordCountBasisServerSeq: BookNodeTable.wordCountBasisServerSeq,
      })
      .from(BookNodeTable)
      .where(and(eq(BookNodeTable.projectId, projectId), isNull(BookNodeTable.deletedAt))),
    db
      .select({ id: StorylineTable.id })
      .from(StorylineTable)
      .where(eq(StorylineTable.projectId, projectId)),
    db
      .select({ id: BookElementTable.id })
      .from(BookElementTable)
      .where(eq(BookElementTable.projectId, projectId)),
    db
      .select({ id: ElementCategoryTable.id })
      .from(ElementCategoryTable)
      .where(eq(ElementCategoryTable.projectId, projectId)),
  ]);

  const nodeIds = nodes.map((node) => node.id);

  const [nodeStorylineLinks, entityRelations, inlineMentions] = await Promise.all([
    nodeIds.length
      ? db
          .select({
            nodeId: NodeStorylineLinkTable.nodeId,
            storylineId: NodeStorylineLinkTable.storylineId,
          })
          .from(NodeStorylineLinkTable)
          .where(inArray(NodeStorylineLinkTable.nodeId, nodeIds))
      : [],
    // Polymorphic; filtered by project_id directly (no FK to nodes).
    db
      .select({ id: EntityRelationTable.id })
      .from(EntityRelationTable)
      .where(eq(EntityRelationTable.projectId, projectId)),
    db
      .select({ id: InlineMentionTable.id })
      .from(InlineMentionTable)
      .where(eq(InlineMentionTable.projectId, projectId)),
  ]);

  const chapters = nodes.filter((node) => node.kind === 'chapter');
  const hasCanonicalWords = (node: (typeof chapters)[number]) =>
    Boolean(node.wordCountBasisKind && isProseMetricBasisHash(node.wordCountBasisHash)) &&
    (node.wordCountBasisKind === 'seed' ||
      node.wordCountBasisRevision != null ||
      node.wordCountBasisServerSeq != null);

  return {
    nodes: nodes.length,
    words: chapters.reduce(
      (total, node) => total + (hasCanonicalWords(node) ? (node.wordCount ?? 0) : 0),
      0,
    ),
    wordsReady: chapters.every(hasCanonicalWords),
    storylines: storylines.length,
    storylineLinks: nodeStorylineLinks.length,
    elements: elements.length,
    categories: elementCategories.length,
    entityRelations: entityRelations.length,
    inlineMentions: inlineMentions.length,
  };
}

async function buildLocalProjectSummaries(projects: Project[]): Promise<ProjectSummary[]> {
  const summaries = await Promise.all(
    projects.map(async (project) => ({
      ...project,
      stats: await buildLocalProjectStats(project.id),
      source: 'local' as const,
    })),
  );
  return summaries.sort(sortProjectSummaries);
}

async function upsertServerProjectSummaries(summaries: ProjectSummary[]): Promise<void> {
  if (summaries.length === 0) return;

  await getDb().transaction(async (tx) => {
    for (const project of summaries) {
      await tx
        .insert(ProjectTable)
        .values({
          id: project.id,
          userId: project.userId,
          name: project.name,
          summary: project.summary,
          kvJson: project.kvJson,
          storylineTemplateKvJson: project.storylineTemplateKvJson,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })
        .onConflictDoUpdate({
          target: ProjectTable.id,
          set: {
            userId: project.userId,
            name: project.name,
            summary: project.summary,
            kvJson: project.kvJson,
            storylineTemplateKvJson: project.storylineTemplateKvJson,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        });
    }
  });
}

async function pullProjectSummariesFromServer(userId: string): Promise<ProjectSummary[]> {
  const requestId = createRequestId('crud:projects:summaries');
  const deviceId = getDeviceId();
  const startedAt = nowMs();

  emitSyncOperation({
    requestId,
    kind: 'crud',
    phase: 'pull',
    state: 'started',
    operation: 'pull',
    method: 'GET',
    endpoint: '/api/projects/summaries',
    entityType: 'project',
    deviceId,
  });

  try {
    const response = await apiClient.get<ServerProjectSummary[]>('/api/projects/summaries');
    const summaries = response.data.map((row) => normalizeServerProjectSummary(row, userId));
    await upsertServerProjectSummaries(summaries);

    emitSyncOperation({
      requestId,
      kind: 'crud',
      phase: 'pull',
      state: 'succeeded',
      operation: 'pull',
      method: 'GET',
      endpoint: '/api/projects/summaries',
      entityType: 'project',
      deviceId,
      resourceCount: summaries.length,
      durationMs: nowMs() - startedAt,
    });

    return summaries;
  } catch (error) {
    emitSyncOperation({
      requestId,
      kind: 'crud',
      phase: 'pull',
      state: 'failed',
      operation: 'pull',
      method: 'GET',
      endpoint: '/api/projects/summaries',
      entityType: 'project',
      deviceId,
      durationMs: nowMs() - startedAt,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

function mergeProjectSummaries(
  localSummaries: ProjectSummary[],
  serverSummaries: ProjectSummary[],
): ProjectSummary[] {
  const byId = new Map<string, ProjectSummary>();
  localSummaries.forEach((summary) => byId.set(summary.id, summary));
  serverSummaries.forEach((summary) => byId.set(summary.id, summary));
  return Array.from(byId.values()).sort(sortProjectSummaries);
}

export function useProject({ userId }: UseProjectContext) {
  const repo = useMemo(() => createProjectRepository(userId), [userId]);
  const ensureDb = useCallback(async () => {
    if (!userId) {
      log.warn('No authenticated user found');
      throw new Error('Cannot access projects without a userId');
    }
    await initDatabase(userId);
  }, [userId]);

  const loadProjects = useCallback(async (): Promise<Project[]> => {
    await ensureDb();
    return await repo.findAll();
  }, [repo, ensureDb]);

  const loadProjectSummaries = useCallback(
    async (options: { pullRemote?: boolean } = {}): Promise<ProjectSummary[]> => {
      await ensureDb();

      const localSummaries = await buildLocalProjectSummaries(await repo.findAll());
      let summaries = localSummaries;

      if (options.pullRemote ?? true) {
        if (isSyncEnabled()) {
          try {
            const serverSummaries = await pullProjectSummariesFromServer(userId);
            summaries = mergeProjectSummaries(localSummaries, serverSummaries);
          } catch (error) {
            log.warn('Failed to pull project summaries; using local project list', error);
          }
        }
      }

      useProjectStore.getState().setProjects(summaries);
      return summaries;
    },
    [repo, userId, ensureDb],
  );

  const loadProject = useCallback(
    async (id: string): Promise<Project | null> => {
      await ensureDb();
      const project = await repo.findById(id);
      if (project) {
        // Seed the in-memory store from local SQLite so the dashboard title
        // (and other subscribers) paint the real name on first render after a
        // refresh, instead of flashing the placeholder until the network graph
        // pull returns. pullAndHydrateProjectGraph still runs afterwards and
        // overwrites this with fresh server data when sync is enabled.
        const store = useProjectStore.getState();
        store.setCurrentProject(project);
        store.setProjects([project, ...store.projects.filter((p) => p.id !== project.id)]);
      }
      return project;
    },
    [repo, ensureDb],
  );

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<Project> => {
      if (!userId) {
        throw new Error('Cannot create project: No authenticated user');
      }
      await ensureDb();

      const now = new Date().toISOString();
      const seededProjectKvJson = defaultProjectKvJson();
      const projectId = uuidv7();
      const project = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const created = await createProjectRepository(userId, tx).create({
          id: projectId,
          userId,
          name: input.projectName ?? 'New Project',
          summary: '',
          kvJson: seededProjectKvJson,
          storylineTemplateKvJson: '[]',
          createdAt: now,
          updatedAt: now,
        });
        await sync('project', 'create', created.id, created.id, {
          id: created.id,
          name: created.name,
          summary: created.summary,
          kvJson: created.kvJson,
          storylineTemplateKvJson: created.storylineTemplateKvJson,
        });
        return created;
      });

      // Projects are allowed to have zero storylines AND zero categories. Both
      // are user-created on demand. element.categoryId is nullable; orphan
      // elements live in the "未分类" bucket.

      const dataStore = useDataStore.getState();
      dataStore.setStorylines([]);
      dataStore.setBookElementCategories([]);

      return project;
    },
    [userId, ensureDb],
  );

  const updateProject = useCallback(
    async (id: string, input: UpdateProjectInput): Promise<Project | null> => {
      if (!userId) {
        log.warn('Cannot update project: No authenticated user');
        return Promise.resolve(null);
      }
      await ensureDb();
      const result = await withAtomicSyncTransaction(id, async (tx, sync) => {
        const updated = await createProjectRepository(userId, tx).update(id, {
          userId,
          name: input.name,
          summary: input.summary,
          kvJson: input.kvJson,
          storylineTemplateKvJson: input.storylineTemplateKvJson,
          updatedAt: new Date().toISOString(),
        });
        if (updated) {
          await sync('project', 'update', id, id, {
            name: input.name,
            summary: input.summary,
            kvJson: input.kvJson,
            storylineTemplateKvJson: input.storylineTemplateKvJson,
          });
        }
        return updated;
      });
      if (result) {
        // Reflect the write into useProjectStore so subscribers (the
        // dashboard's KvEditor in particular) re-render against the
        // persisted value. Without this, the editor's effect re-seeds
        // local rows from the stale prop and the user sees their input
        // vanish on blur. Storylines / categories / elements don't have
        // this problem because their usecases already write back through
        // useDataStore.update*State.
        useProjectStore.getState().updateProjectInList(id, result);
      }
      return result;
    },
    [userId, ensureDb],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<boolean> => {
      await ensureDb();
      await cancelAssetUploadsForProjectDeletion(id);
      return withAtomicSyncTransaction(id, async (tx, sync) => {
        const ok = await createProjectRepository(userId, tx).delete(id);
        if (ok) await sync('project', 'delete', id, id);
        return ok;
      });
    },
    [userId, ensureDb],
  );

  return useMemo(
    () => ({
      loadProjects,
      loadProjectSummaries,
      loadProject,
      createProject,
      updateProject,
      deleteProject,
    }),
    [loadProjects, loadProjectSummaries, loadProject, createProject, updateProject, deleteProject],
  );
}
