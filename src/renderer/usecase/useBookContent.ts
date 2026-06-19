import { useCallback, useRef, useMemo } from 'react';

import { createBookContentRepository } from '../sqlite-repo/content-repo';
import type { NodeContent } from '../domain/node-content';
import { initDatabase } from '../lib/db';
import { syncNodeContentUpdate } from './sync-helpers';

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
      const cont = await contentRepo.findByNodeId(nodeId);
      if (!cont) {
        throw new Error(`Content with nodeId: ${nodeId} not found`);
      }
      const now = new Date().toISOString();
      const updatedData = {
        ...cont,
        ...updates,
        updatedAt: now,
      };

      const result = await contentRepo.update(cont.nodeId, updatedData);
      syncNodeContentUpdate(nodeId, projectId, {
        contentJson: updatedData.contentJson,
        outlineJson: updatedData.outlineJson,
        plotGridJson: updatedData.plotGridJson,
      });
      return result;
    },
    [contentRepo, ensureDb, projectId],
  );

  const updateContentById = useCallback(
    async (id: string, updates: Partial<NodeContent>) => {
      await ensureDb();
      const cont = await contentRepo.findById(id);
      if (!cont) {
        throw new Error(`Content with id: ${id} not found`);
      }
      const now = new Date().toISOString();
      const updatedData = {
        ...cont,
        ...updates,
        updatedAt: now,
      };

      const result = await contentRepo.update(cont.nodeId, updatedData);
      syncNodeContentUpdate(cont.nodeId, projectId, {
        contentJson: updatedData.contentJson,
        outlineJson: updatedData.outlineJson,
        plotGridJson: updatedData.plotGridJson,
      });
      return result;
    },
    [contentRepo, ensureDb, projectId],
  );

  const createContent = useCallback(
    async (nodeId: string, content: Partial<NodeContent>) => {
      await ensureDb();
      const created = await contentRepo.create({
        nodeId,
        contentJson: content.contentJson,
        outlineJson: content.outlineJson,
        plotGridJson: content.plotGridJson,
      });

      syncNodeContentUpdate(nodeId, projectId, {
        contentJson: created.contentJson,
        outlineJson: created.outlineJson,
        plotGridJson: created.plotGridJson,
      });

      return created;
    },
    [contentRepo, ensureDb, projectId],
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
      const existing = await contentRepo.findByNodeId(nodeId);
      if (existing) {
        return updateContentByNodeId(nodeId, { plotGridJson });
      }
      return createContent(nodeId, { plotGridJson });
    },
    [contentRepo, ensureDb, updateContentByNodeId, createContent],
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
