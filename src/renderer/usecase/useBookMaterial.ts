import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { Material, MaterialKind, MaterialSource } from '../domain/material';
import { createMaterialSqliteRepository } from '../sqlite-repo/material-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { syncMaterialCreate, syncMaterialUpdate, syncMaterialDelete } from './sync-helpers';

export interface CreateMaterialInput {
  title?: string;
  kind: MaterialKind;
  source: MaterialSource;
  uri: string;
  localPath?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  bodyJson?: string | null;
  notesJson?: string | null;
  thumbnailUri?: string | null;
}

export type UpdateMaterialUsecaseInput = Partial<
  Omit<Material, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
>;

export interface UseBookMaterialContext {
  projectId: string;
  userId: string;
}

export function useBookMaterial({ projectId, userId }: UseBookMaterialContext) {
  if (!projectId) throw new Error('useBookMaterial requires a projectId');
  if (!userId) throw new Error('useBookMaterial requires a userId');

  const repo = useMemo(() => createMaterialSqliteRepository(projectId), [projectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getMaterials = useCallback(() => useDataStore.getState().materials, []);
  const setMaterials = useCallback(
    (mats: Material[]) => useDataStore.getState().setMaterials(mats),
    [],
  );

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const materials = await repo.findAll();
    setMaterials(materials);
  }, [repo, setMaterials, ensureDb]);

  const createMaterial = useCallback(
    async (input: CreateMaterialInput) => {
      await ensureDb();
      const prev = getMaterials().slice();
      const now = new Date().toISOString();
      const newMaterial: Material = {
        id: uuidv7(),
        projectId,
        title: input.title?.trim() ?? '',
        kind: input.kind,
        source: input.source,
        uri: input.uri,
        localPath: input.localPath ?? null,
        mime: input.mime ?? null,
        sizeBytes: input.sizeBytes ?? null,
        bodyJson: input.bodyJson ?? null,
        notesJson: input.notesJson ?? null,
        thumbnailUri: input.thumbnailUri ?? null,
        orderKey: 0,
        createdAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => setMaterials([newMaterial, ...prev]),
        rollback: () => setMaterials(prev),
        effect: () => repo.create(newMaterial),
        onSuccess: (persisted) => {
          const current = getMaterials();
          setMaterials(current.map((m) => (m.id === persisted.id ? persisted : m)));
        },
        sync: (persisted) =>
          syncMaterialCreate(persisted.id, projectId, {
            id: persisted.id,
            title: persisted.title,
            kind: persisted.kind,
            source: persisted.source,
            uri: persisted.uri,
            localPath: persisted.localPath,
            mime: persisted.mime,
            sizeBytes: persisted.sizeBytes,
            bodyJson: persisted.bodyJson,
            notesJson: persisted.notesJson,
            thumbnailUri: persisted.thumbnailUri,
            orderKey: persisted.orderKey,
          }),
      });
    },
    [repo, getMaterials, setMaterials, ensureDb, projectId],
  );

  const updateMaterial = useCallback(
    async (id: string, updates: UpdateMaterialUsecaseInput) => {
      await ensureDb();
      const now = new Date().toISOString();
      const materials = getMaterials();
      const existing = materials.find((m) => m.id === id);
      if (!existing) throw new Error(`Material with id ${id} not found`);

      const updated: Material = { ...existing, ...updates, updatedAt: now };
      return withOptimisticUpdate({
        apply: () => setMaterials(materials.map((m) => (m.id === id ? updated : m))),
        rollback: () => setMaterials(materials),
        effect: async () => {
          const persisted = await repo.update(id, {
            title: updated.title,
            kind: updated.kind,
            source: updated.source,
            uri: updated.uri,
            localPath: updated.localPath,
            mime: updated.mime,
            sizeBytes: updated.sizeBytes,
            bodyJson: updated.bodyJson,
            notesJson: updated.notesJson,
            thumbnailUri: updated.thumbnailUri,
            orderKey: updated.orderKey,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Material with id ${id} not found`);
          return persisted;
        },
        onSuccess: (persisted) => {
          const current = getMaterials();
          setMaterials(current.map((m) => (m.id === id ? persisted : m)));
        },
        sync: (persisted) =>
          syncMaterialUpdate(id, projectId, {
            title: persisted.title,
            kind: persisted.kind,
            source: persisted.source,
            uri: persisted.uri,
            localPath: persisted.localPath,
            mime: persisted.mime,
            sizeBytes: persisted.sizeBytes,
            bodyJson: persisted.bodyJson,
            notesJson: persisted.notesJson,
            thumbnailUri: persisted.thumbnailUri,
            orderKey: persisted.orderKey,
          }),
      });
    },
    [repo, getMaterials, setMaterials, ensureDb, projectId],
  );

  const removeMaterial = useCallback(
    async (id: string) => {
      await ensureDb();
      const materials = getMaterials();
      const existing = materials.find((m) => m.id === id);
      if (!existing) throw new Error(`Material with id ${id} not found`);

      const filtered = materials.filter((m) => m.id !== id);
      return withOptimisticUpdate({
        apply: () => setMaterials(filtered),
        rollback: () => setMaterials(materials),
        effect: () => repo.delete(id),
        sync: () => syncMaterialDelete(id, projectId),
      });
    },
    [repo, getMaterials, setMaterials, ensureDb, projectId],
  );

  return useMemo(
    () => ({ loadInitial, createMaterial, updateMaterial, removeMaterial }),
    [loadInitial, createMaterial, updateMaterial, removeMaterial],
  );
}
