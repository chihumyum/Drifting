import { useCallback, useMemo } from 'react';
import type { ProjectAsset } from '../domain/project-asset';
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

  const upsertLocalAsset = useCallback(
    async (asset: ProjectAsset) => {
      await ensureDb();
      const persisted = await repo.upsert(asset);
      useDataStore.getState().upsertProjectAsset(persisted);
      return persisted;
    },
    [ensureDb, repo],
  );

  const removeLocalAsset = useCallback(
    async (assetId: string) => {
      await ensureDb();
      await repo.delete(assetId);
      useDataStore.getState().removeProjectAsset(assetId);
    },
    [ensureDb, repo],
  );

  return useMemo(
    () => ({ loadInitial, upsertLocalAsset, removeLocalAsset }),
    [loadInitial, upsertLocalAsset, removeLocalAsset],
  );
}
