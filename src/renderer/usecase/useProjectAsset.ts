import { useCallback, useMemo } from 'react';
import { initDatabase } from '../lib/db';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { useDataStore } from '../store/data-store';

export interface UseProjectAssetContext {
  projectId: string;
  userId: string;
}

export function useProjectAsset({ projectId, userId }: UseProjectAssetContext) {
  if (!projectId) throw new Error('useProjectAsset requires a projectId');
  if (!userId) throw new Error('useProjectAsset requires a userId');

  const repo = useMemo(() => createProjectAssetSqliteRepository(projectId), [projectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const assets = await repo.findAll();
    useDataStore.getState().setProjectAssets(assets);
  }, [ensureDb, repo]);

  return useMemo(() => ({ loadInitial }), [loadInitial]);
}
