import { useCallback, useMemo } from 'react';
import { eq, inArray } from 'drizzle-orm';

import type { Project } from '../domain/project';
import type { Storyline } from '../domain/storyline';
import type { BookElementCategory } from '../domain/book-element';
import { createProjectRepository } from '../sqlite-repo/project-repo';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import { getDb, initDatabase } from '../lib/db';
import apiClient from '../lib/axios-config';
import { isSyncEnabled } from '../lib/config';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import { v7 as uuidv7 } from 'uuid';
import {
  syncProjectCreate,
  syncProjectUpdate,
  syncProjectDelete,
  syncStorylineCreate,
  syncCategoryCreate,
} from './sync-helpers';
import { randomColor } from '../utils';
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
  descriptionJson?: string | null;
  kvJson?: string | null;
  storylineTemplateKvJson?: string | null;
  createdAt: string;
  updatedAt: string;
  stats?: Partial<ProjectStats> | null;
};

const EMPTY_PROJECT_STATS: ProjectStats = {
  nodes: 0,
  words: 0,
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
    descriptionJson: row.descriptionJson ?? '{}',
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
      .select({ id: BookNodeTable.id, wordCount: BookNodeTable.wordCount })
      .from(BookNodeTable)
      .where(eq(BookNodeTable.projectId, projectId)),
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

  return {
    nodes: nodes.length,
    words: nodes.reduce((total, node) => total + (node.wordCount ?? 0), 0),
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
          descriptionJson: project.descriptionJson,
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
            descriptionJson: project.descriptionJson,
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
      return await repo.findById(id);
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
      const project = await repo.create({
        id: uuidv7(),
        userId,
        name: input.projectName ?? 'New Project',
        descriptionJson: '', // TODO: fix to pmJson, or Ydoc
        kvJson: seededProjectKvJson,
        storylineTemplateKvJson: '[]',
        createdAt: now,
        updatedAt: now,
      });

      // Enforce invariant: Project must have at least one default storyline
      const storylineRepo = createStorylineRepository(project.id);
      const defaultStorylineId = uuidv7();
      const createdStoryline = await storylineRepo.createStoryline({
        id: defaultStorylineId,
        projectId: project.id,
        name: 'New Storyline',
        color: randomColor(),
        summary: '',
        orderKey: 1,
        descriptionJson: '{}',
        // The freshly-created project has an empty storyline template, so the
        // bootstrap storyline starts blank. Once the user fills in
        // storylineTemplateKvJson, subsequent storylines pick it up via
        // useStoryline.createStoryline.
        kvJson: '[]',
        nodeContentTemplateJson: '{}',
        createdAt: now,
        updatedAt: now,
      });
      log.debug('Created default storyline:', createdStoryline);
      let defaultStoryline: Storyline | null = createdStoryline;
      if (!defaultStoryline?.id || !defaultStoryline.name?.trim()) {
        defaultStoryline = await storylineRepo.getStorylineById(defaultStorylineId);
      }
      if (!defaultStoryline) {
        throw new Error('Failed to create default storyline');
      }
      if (!defaultStoryline.name?.trim()) {
        await storylineRepo.updateStoryline(defaultStoryline.id || defaultStorylineId, {
          name: 'New Storyline',
          updatedAt: new Date().toISOString(),
        });
        defaultStoryline = await storylineRepo.getStorylineById(defaultStorylineId);
        if (!defaultStoryline) {
          throw new Error('Failed to recover default storyline after name update');
        }
      }

      // Enforce invariant: Project must have at least one 'others' element category
      const categoryRepo = createElementCategoryRepository(project.id);
      const defaultCategoryId = uuidv7();
      const createdCategory = await categoryRepo.create({
        id: defaultCategoryId,
        projectId: project.id,
        name: 'others',
        descriptionJson: '{}',
        elementTemplateJson: '{}',
        elementTemplateKvJson: '[]',
        color: randomColor(),
        layoutMode: 'auto',
        gridX: null,
        gridY: null,
        createdAt: now,
        updatedAt: now,
      });
      let defaultCategory: BookElementCategory | null = createdCategory;
      if (!defaultCategory?.id || !defaultCategory.name?.trim()) {
        defaultCategory = await categoryRepo.findByName('others');
      }
      if (!defaultCategory) {
        throw new Error('Failed to create default element category');
      }
      if (!defaultCategory.name?.trim()) {
        await categoryRepo.update(defaultCategory.id || defaultCategoryId, {
          name: 'others',
          updatedAt: new Date().toISOString(),
        });
        defaultCategory = await categoryRepo.findByName('others');
        if (!defaultCategory) {
          throw new Error('Failed to recover default category after name update');
        }
      }

      const [storylines, categories] = await Promise.all([
        storylineRepo.getStorylinesByProject(),
        categoryRepo.findAll(),
      ]);
      const safeStorylines = storylines.filter((s) => Boolean(s?.id) && Boolean(s?.name?.trim()));
      const safeCategories = categories.filter((c) => Boolean(c?.id) && Boolean(c?.name?.trim()));

      const dataStore = useDataStore.getState();
      dataStore.setStorylines(safeStorylines.length > 0 ? safeStorylines : [defaultStoryline]);
      dataStore.setBookElementCategories(
        safeCategories.length > 0 ? safeCategories : [defaultCategory],
      );

      // Sync to server (fire-and-forget)
      syncProjectCreate(project.id, {
        id: project.id,
        name: project.name,
        descriptionJson: project.descriptionJson,
        kvJson: project.kvJson,
        storylineTemplateKvJson: project.storylineTemplateKvJson,
      });
      syncStorylineCreate(defaultStoryline.id, project.id, {
        id: defaultStoryline.id,
        name: defaultStoryline.name,
        color: defaultStoryline.color,
        summary: defaultStoryline.summary,
        orderKey: defaultStoryline.orderKey,
        descriptionJson: defaultStoryline.descriptionJson,
        kvJson: defaultStoryline.kvJson,
        nodeContentTemplateJson: defaultStoryline.nodeContentTemplateJson,
      });
      syncCategoryCreate(defaultCategory.id, project.id, {
        id: defaultCategory.id,
        name: defaultCategory.name,
        color: defaultCategory.color,
        descriptionJson: defaultCategory.descriptionJson,
        elementTemplateKvJson: defaultCategory.elementTemplateKvJson,
      });

      return project;
    },
    [repo, userId, ensureDb],
  );

  const updateProject = useCallback(
    async (id: string, input: UpdateProjectInput): Promise<Project | null> => {
      if (!userId) {
        log.warn('Cannot update project: No authenticated user');
        return Promise.resolve(null);
      }
      await ensureDb();
      const result = await repo.update(id, {
        userId,
        name: input.name,
        descriptionJson: input.descriptionJson,
        kvJson: input.kvJson,
        storylineTemplateKvJson: input.storylineTemplateKvJson,
        updatedAt: new Date().toISOString(),
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
        syncProjectUpdate(id, {
          name: input.name,
          descriptionJson: input.descriptionJson,
          kvJson: input.kvJson,
          storylineTemplateKvJson: input.storylineTemplateKvJson,
        });
      }
      return result;
    },
    [repo, userId, ensureDb],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<boolean> => {
      await ensureDb();
      const ok = await repo.delete(id);
      if (ok) syncProjectDelete(id);
      return ok;
    },
    [repo, ensureDb],
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
