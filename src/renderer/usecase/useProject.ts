import { useCallback, useMemo } from 'react';

import type { Project } from '../domain/project';
import { createProjectRepository } from '../sqlite-repo/project-repo';
import { initDatabase } from '../lib/db';
import { readProjectStats } from '../sqlite-repo/project-stats-repo';
import type { ProjectSummary } from '../domain/project-summary';
import { runAuthoredTransaction } from '../sync/journal';
import { v7 as uuidv7 } from 'uuid';
import { withAtomicSyncTransaction } from './sync-helpers';
import { defaultProjectKvJson } from '../domain/kv';
import { replaceEntityKvEntriesInTransaction } from './normalized-kv-alias-authority';
import { genericAssociationRelationType } from '../domain/entity-relation-type';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import LogLevel from 'loglevel';
import { deleteProjectDataInTransaction } from '../sqlite-repo/project-deletion-repo';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';
import { assetStoreService } from '../services/asset-store.service';
import { useRecentEntitiesStore } from '../store/recent-entities-store';
import { useWritingStatsStore } from '../store/writing-stats-store';
import { useUiStore } from '../store/ui-store';
import { useSettingsStore } from '../store/settings-store';
import { useAgentEditStore } from '../store/agent-edit-store';
import { reconcileProjectProseMetrics } from '../services/node-prose-metrics.service';
const log = LogLevel.getLogger('UseProject');
log.setLevel(LogLevel.levels.WARN);

export type { ProjectStats, ProjectSummary } from '../domain/project-summary';

const MAX_SHELF_METRIC_RECONCILE_CONCURRENCY = 2;
const MAX_SHELF_STATS_CONCURRENCY = 4;

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

function sortProjectSummaries(a: ProjectSummary, b: ProjectSummary): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

async function buildLocalProjectSummaries(projects: Project[]): Promise<ProjectSummary[]> {
  // Bound gateway work when a library contains many projects. Each project
  // returns one aggregate row, never its node/entity inventory.
  const summaries: ProjectSummary[] = new Array(projects.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_SHELF_STATS_CONCURRENCY, projects.length) }, async () => {
      while (cursor < projects.length) {
        const index = cursor++;
        const project = projects[index];
        summaries[index] = {
          ...project,
          stats: await readProjectStats(project.id),
          source: 'local',
        };
      }
    }),
  );
  return summaries.sort(sortProjectSummaries);
}

export function localProjectIdsNeedingProseMetricReconciliation(
  summaries: readonly ProjectSummary[],
): string[] {
  return summaries
    .filter((summary) => summary.stats.nodes > 0 && !summary.stats.wordsReady)
    .map((summary) => summary.id);
}

async function reconcileShelfProjectMetrics(summaries: readonly ProjectSummary[]): Promise<void> {
  const projectIds = localProjectIdsNeedingProseMetricReconciliation(summaries);
  let cursor = 0;
  const workers = Array.from(
    {
      length: Math.min(
        MAX_SHELF_METRIC_RECONCILE_CONCURRENCY,
        Math.max(1, projectIds.length),
      ),
    },
    async () => {
      while (cursor < projectIds.length) {
        const projectId = projectIds[cursor++];
        try {
          await reconcileProjectProseMetrics(projectId, { publishToDataStore: false });
        } catch (error) {
          // One damaged project must not keep the rest of the shelf hidden.
          // Its summary remains pending and the project runtime can retry it.
          log.warn(`Shelf prose metric reconciliation failed for ${projectId}`, error);
        }
      }
    },
  );
  await Promise.all(workers);
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
    async (): Promise<ProjectSummary[]> => {
      await ensureDb();
      const projects = await repo.findAll();
      let summaries = await buildLocalProjectSummaries(projects);
      if (localProjectIdsNeedingProseMetricReconciliation(summaries).length > 0) {
        await reconcileShelfProjectMetrics(summaries);
        summaries = await buildLocalProjectSummaries(projects);
      }
      useProjectStore.getState().setProjects(summaries);
      return summaries;
    },
    [repo, ensureDb],
  );

  const loadProject = useCallback(
    async (id: string): Promise<Project | null> => {
      await ensureDb();
      const project = await repo.findById(id);
      if (project) {
        // Local SQLite is the complete working replica and the only project
        // bootstrap source. SyncEngine materializes verified remote objects
        // into this same database before stores are refreshed.
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
      const builtInRelationType = genericAssociationRelationType(projectId, now);
      const project = await withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
        const projectRepo = createProjectRepository(userId, tx);
        const created = await projectRepo.create({
          id: projectId,
          userId,
          name: input.projectName ?? 'New Project',
          summary: '',
          kvJson: '[]',
          storylineTemplateKvJson: '[]',
          createdAt: now,
          updatedAt: now,
        });
        await sync('project', 'create', created.id, created.id, {
          id: created.id,
          name: created.name,
          summary: created.summary,
        });
        await replaceEntityKvEntriesInTransaction(tx, changes, {
          projectId,
          ownerKind: 'project',
          ownerId: projectId,
          namespace: 'facts',
          nextJson: seededProjectKvJson,
        });
        await createEntityRelationTypeRepository(projectId, tx).create(builtInRelationType);
        await sync(
          'entityRelationType',
          'create',
          builtInRelationType.id,
          projectId,
          { ...builtInRelationType },
        );
        return (await projectRepo.findById(projectId))!;
      });

      // Projects are allowed to have zero storylines AND zero categories. Both
      // are user-created on demand. element.categoryId is nullable; orphan
      // elements live in the "未分类" bucket.

      const dataStore = useDataStore.getState();
      dataStore.setStorylines([]);
      dataStore.setBookElementCategories([]);
      dataStore.setEntityRelationTypes([builtInRelationType]);
      dataStore.setEntityRelations([]);

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
      const result = await withAtomicSyncTransaction(id, async (tx, sync, changes) => {
        if (input.kvJson !== undefined) {
          await replaceEntityKvEntriesInTransaction(tx, changes, {
            projectId: id,
            ownerKind: 'project',
            ownerId: id,
            namespace: 'facts',
            nextJson: input.kvJson,
          });
        }
        if (input.storylineTemplateKvJson !== undefined) {
          await replaceEntityKvEntriesInTransaction(tx, changes, {
            projectId: id,
            ownerKind: 'project',
            ownerId: id,
            namespace: 'storyline-template',
            nextJson: input.storylineTemplateKvJson,
          });
        }
        const updated = await createProjectRepository(userId, tx).update(id, {
          userId,
          name: input.name,
          summary: input.summary,
          updatedAt: new Date().toISOString(),
        });
        if (updated && (input.name !== undefined || input.summary !== undefined)) {
          await sync('project', 'update', id, id, {
            name: input.name,
            summary: input.summary,
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
      const deletion = await runAuthoredTransaction(id, 'project.purge', async ({
        tx,
        changes,
        generation,
      }) => {
        if (!generation) throw new Error(`Project ${id} has no active SyncGeneration`);
        // Capture every file coordinate on the same transaction that deletes
        // its metadata. This includes soft-deleted assets and closes the race
        // where an import could commit between inventory and project cascade.
        const receipt = await deleteProjectDataInTransaction(tx, id);
        if (!receipt) return null;
        changes.add({
          action: 'sync-generation.purge',
          target: {
            family: 'sync-generation',
            kind: 'sync-generation',
            id: generation.syncGenerationId,
            incarnation: generation.generationNumber,
          },
          payload: {},
        });
        return receipt;
      });
      if (!deletion) return false;

      // SQLite is now committed. Remove every rebuildable/presentation trace
      // keyed by this project before attempting fallible native file cleanup.
      useProjectStore.getState().removeProject(id);
      useRecentEntitiesStore.getState().clearProject(id);
      useWritingStatsStore.getState().clearProject(id);
      useUiStore.getState().clearProjectTabs(id);
      useSettingsStore.getState().clearProjectSettings(id);
      useAgentEditStore
        .getState()
        .clearProject(id, deletion.proseDocIds, deletion.agentReviewIds);

      const cleanupResults = await Promise.allSettled([
        ...deletion.assetIds.map((assetId) => assetStoreService.deleteAsset(id, assetId)),
      ]);
      const cleanupFailures = cleanupResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (cleanupFailures.length > 0) {
        // The project is already durably deleted, so returning false or
        // throwing would tell the UI a retry is safe when it is not. Keep the
        // failure visible until a durable project-directory GC lands.
        log.warn(
          `Project ${id} was deleted, but ${cleanupFailures.length} local asset cleanup(s) failed`,
          new AggregateError(cleanupFailures),
        );
      }
      return true;
    },
    [ensureDb],
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
