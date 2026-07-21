import { useCallback, useRef, useMemo } from 'react';

import { createBookContentRepository } from '../sqlite-repo/content-repo';
import type { NodeContent } from '../domain/node-content';
import { initDatabase } from '../lib/db';
import { withAtomicSyncTransaction } from './sync-helpers';

export interface UseBookContentContext {
  userId: string;
  projectId: string;
}

export function useBookContent({ userId, projectId }: UseBookContentContext) {
  if (!userId) {
    throw new Error('useBookContent requires a userId');
  }
  const contentRepoRef = useRef(createBookContentRepository());
  const contentRepo = contentRepoRef.current;
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getContentByNodeId = useCallback(
    async (nodeId: string) => {
      await ensureDb();
      return contentRepo.findByNodeId(nodeId);
    },
    [contentRepo, ensureDb],
  );

  const getContentById = useCallback(
    async (id: string) => {
      await ensureDb();
      return contentRepo.findById(id);
    },
    [contentRepo, ensureDb],
  );

  const updateContentByNodeId = useCallback(
    async (nodeId: string, updates: Partial<NodeContent>) => {
      await ensureDb();
      // Write and sync only the columns the caller owns. Reconstructing a full
      // stale row here lets the editor's content debounce overwrite a newer
      // plot-grid write (and vice versa).
      const syncPatch: Record<string, unknown> = {};
      if (updates.contentJson !== undefined) syncPatch.contentJson = updates.contentJson;
      if (updates.outlineJson !== undefined) syncPatch.outlineJson = updates.outlineJson;
      if (updates.plotGridJson !== undefined) syncPatch.plotGridJson = updates.plotGridJson;

      return withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repo = createBookContentRepository(tx);
        const cont = await repo.findByNodeId(nodeId);
        if (!cont) {
          throw new Error(`Content with nodeId: ${nodeId} not found`);
        }
        const result = await repo.update(cont.nodeId, {
          ...updates,
          updatedAt: new Date().toISOString(),
        });
        await sync('nodeContent', 'update', nodeId, projectId, syncPatch);
        return result;
      });
    },
    [ensureDb, projectId],
  );

  const updateContentById = useCallback(
    async (id: string, updates: Partial<NodeContent>) => {
      await ensureDb();
      const syncPatch: Record<string, unknown> = {};
      if (updates.contentJson !== undefined) syncPatch.contentJson = updates.contentJson;
      if (updates.outlineJson !== undefined) syncPatch.outlineJson = updates.outlineJson;
      if (updates.plotGridJson !== undefined) syncPatch.plotGridJson = updates.plotGridJson;

      return withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repo = createBookContentRepository(tx);
        const cont = await repo.findById(id);
        if (!cont) {
          throw new Error(`Content with id: ${id} not found`);
        }
        const result = await repo.update(cont.nodeId, {
          ...updates,
          updatedAt: new Date().toISOString(),
        });
        await sync('nodeContent', 'update', cont.nodeId, projectId, syncPatch);
        return result;
      });
    },
    [ensureDb, projectId],
  );

  const createContent = useCallback(
    async (nodeId: string, content: Partial<NodeContent>) => {
      await ensureDb();
      return withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const created = await createBookContentRepository(tx).create({
          nodeId,
          contentJson: content.contentJson,
          outlineJson: content.outlineJson,
          plotGridJson: content.plotGridJson,
        });
        await sync('nodeContent', 'update', nodeId, projectId, {
          contentJson: created.contentJson,
          outlineJson: created.outlineJson,
          plotGridJson: created.plotGridJson,
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

  // Plot planner grid lives on the same NodeContent row but is edited
  // independently of the prose editor, so it gets its own create-or-update
  // path (the prose save in NodeEditorView only ever touches content/outline).
  const updatePlotGridByNodeId = useCallback(
    async (nodeId: string, plotGridJson: string) => {
      await ensureDb();
      return withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const repo = createBookContentRepository(tx);
        const existing = await repo.findByNodeId(nodeId);
        const result = existing
          ? await repo.update(nodeId, { plotGridJson })
          : await repo.create({ nodeId, plotGridJson });
        await sync('nodeContent', 'update', nodeId, projectId, { plotGridJson });
        return result;
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
