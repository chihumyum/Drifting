import { useCallback, useRef, useMemo } from 'react';

import { createBookContentRepository } from '../sqlite-repo/content-repo';
import type { NodeContent } from '../domain/node-content';
import type { PlotGridMutation } from '../domain/plot-grid';
import { initDatabase } from '../lib/db';
import { createPlotGridRepository } from '../sqlite-repo/plot-grid-repo';
import { runDerivedTransaction } from '../sync/journal';
import { persistPlotGridMutations } from './plot-grid-write';

export interface UseBookContentContext {
  userId: string;
  projectId: string;
}

type BookContentPatch = Partial<Omit<NodeContent, 'plotGridJson'>>;

export function useBookContent({ userId, projectId }: UseBookContentContext) {
  if (!userId) {
    throw new Error('useBookContent requires a userId');
  }
  const contentRepo = useMemo(
    () => createBookContentRepository(undefined, projectId),
    [projectId],
  );
  const plotGridRepoRef = useRef(createPlotGridRepository());
  const plotGridRepo = plotGridRepoRef.current;
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getContentByNodeId = useCallback(
    async (nodeId: string) => {
      await ensureDb();
      const content = await contentRepo.findByNodeId(nodeId);
      if (!content) return null;
      const plotGridJson = await plotGridRepo.materializeProjection(nodeId);
      return { ...content, plotGridJson: plotGridJson ?? '{}' };
    },
    [contentRepo, ensureDb, plotGridRepo],
  );

  const getContentById = useCallback(
    async (id: string) => {
      await ensureDb();
      const content = await contentRepo.findById(id);
      if (!content) return null;
      const plotGridJson = await plotGridRepo.materializeProjection(content.nodeId);
      return { ...content, plotGridJson: plotGridJson ?? '{}' };
    },
    [contentRepo, ensureDb, plotGridRepo],
  );

  const updateContentByNodeId = useCallback(
    async (nodeId: string, updates: BookContentPatch) => {
      await ensureDb();
      // Write and sync only the columns the caller owns. Reconstructing a full
      // stale row here lets the editor's content debounce overwrite a newer
      // plot-grid write (and vice versa).
      return runDerivedTransaction('prose.node-content-projection', async (tx) => {
        const repo = createBookContentRepository(tx, projectId);
        const cont = await repo.findByNodeId(nodeId);
        if (!cont) {
          throw new Error(`Content with nodeId: ${nodeId} not found`);
        }
        const result = await repo.update(cont.nodeId, {
          ...updates,
          updatedAt: new Date().toISOString(),
        });
        return result;
      });
    },
    [ensureDb, projectId],
  );

  const updateContentById = useCallback(
    async (id: string, updates: BookContentPatch) => {
      await ensureDb();
      return runDerivedTransaction('prose.node-content-projection', async (tx) => {
        const repo = createBookContentRepository(tx, projectId);
        const cont = await repo.findById(id);
        if (!cont) {
          throw new Error(`Content with id: ${id} not found`);
        }
        const result = await repo.update(cont.nodeId, {
          ...updates,
          updatedAt: new Date().toISOString(),
        });
        return result;
      });
    },
    [ensureDb, projectId],
  );

  const createContent = useCallback(
    async (nodeId: string, content: BookContentPatch) => {
      await ensureDb();
      return runDerivedTransaction('prose.node-content-projection-create', async (tx) => {
        const created = await createBookContentRepository(tx, projectId).create({
          nodeId,
          contentJson: content.contentJson,
          outlineJson: content.outlineJson,
        });
        return created;
      });
    },
    [ensureDb, projectId],
  );

  const getOutlineByNodeId = useCallback(
    async (nodeId: string) => {
      await ensureDb();
      const content = await contentRepo.findByNodeId(nodeId);
      return content?.outlineJson;
    },
    [contentRepo, ensureDb],
  );

  // Plot Grid has its own normalized authored command path. plotGridJson is
  // rebuilt inside that transaction and never enters a generic field.set.
  const updatePlotGridByNodeId = useCallback(
    async (nodeId: string, mutations: readonly PlotGridMutation[]) => {
      await ensureDb();
      return persistPlotGridMutations({
        projectId,
        nodeId,
        mutations,
      });
    },
    [ensureDb, projectId],
  );

  return useMemo(
    () => ({
      getContentByNodeId,
      getContentById,
      updateContentById,
      updateContentByNodeId,
      createContent,
      getOutlineByNodeId,
      updatePlotGridByNodeId,
    }),
    [
      getContentByNodeId,
      getContentById,
      updateContentById,
      updateContentByNodeId,
      createContent,
      getOutlineByNodeId,
      updatePlotGridByNodeId,
    ],
  );
}
