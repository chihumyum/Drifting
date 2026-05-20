import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { Memo, MemoResolution } from '../domain/memo';
import { createMemoSqliteRepository } from '../sqlite-repo/memo-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { syncMemoCreate, syncMemoUpdate, syncMemoDelete } from './sync-helpers';

export interface CreateMemoInput {
  title?: string;
  bodyJson?: string;
  resolution?: MemoResolution;
}

export type UpdateMemoUsecaseInput = Partial<
  Omit<Memo, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
>;

export interface UseBookMemoContext {
  projectId: string;
  userId: string;
}

export function useBookMemo({ projectId, userId }: UseBookMemoContext) {
  if (!projectId) throw new Error('useBookMemo requires a projectId');
  if (!userId) throw new Error('useBookMemo requires a userId');

  const repo = useMemo(() => createMemoSqliteRepository(projectId), [projectId]);
  const ensureDb = useCallback(async () => {
    await initDatabase(userId);
  }, [userId]);

  const getMemos = useCallback(() => useDataStore.getState().memos, []);
  const setMemos = useCallback(
    (memos: Memo[]) => useDataStore.getState().setMemos(memos),
    [],
  );

  const loadInitial = useCallback(async () => {
    await ensureDb();
    const memos = await repo.findAll();
    setMemos(memos);
  }, [repo, setMemos, ensureDb]);

  const createMemo = useCallback(
    async (input: CreateMemoInput) => {
      await ensureDb();
      const prev = getMemos().slice();
      const now = new Date().toISOString();
      const newMemo: Memo = {
        id: uuidv7(),
        projectId,
        title: input.title?.trim() ?? '',
        bodyJson: input.bodyJson ?? '{}',
        resolution: input.resolution ?? 'no_action',
        priority: null,
        dueAt: null,
        orderKey: 0,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => setMemos([newMemo, ...prev]),
        rollback: () => setMemos(prev),
        effect: () => repo.create(newMemo),
        onSuccess: (persisted) => {
          const current = getMemos();
          setMemos(current.map((m) => (m.id === persisted.id ? persisted : m)));
        },
        sync: (persisted) =>
          syncMemoCreate(persisted.id, projectId, {
            id: persisted.id,
            title: persisted.title,
            bodyJson: persisted.bodyJson,
            resolution: persisted.resolution,
            priority: persisted.priority,
            dueAt: persisted.dueAt,
            orderKey: persisted.orderKey,
            resolvedAt: persisted.resolvedAt,
          }),
      });
    },
    [repo, getMemos, setMemos, ensureDb, projectId],
  );

  const updateMemo = useCallback(
    async (id: string, updates: UpdateMemoUsecaseInput) => {
      await ensureDb();
      const now = new Date().toISOString();
      const memos = getMemos();
      const existing = memos.find((m) => m.id === id);
      if (!existing) throw new Error(`Memo with id ${id} not found`);

      const updated: Memo = {
        ...existing,
        ...updates,
        updatedAt: now,
      };

      return withOptimisticUpdate({
        apply: () => setMemos(memos.map((m) => (m.id === id ? updated : m))),
        rollback: () => setMemos(memos),
        effect: async () => {
          const persisted = await repo.update(id, {
            title: updated.title,
            bodyJson: updated.bodyJson,
            resolution: updated.resolution,
            priority: updated.priority,
            dueAt: updated.dueAt,
            orderKey: updated.orderKey,
            resolvedAt: updated.resolvedAt,
            updatedAt: updated.updatedAt,
          });
          if (!persisted) throw new Error(`Memo with id ${id} not found`);
          return persisted;
        },
        onSuccess: (persisted) => {
          const current = getMemos();
          setMemos(current.map((m) => (m.id === id ? persisted : m)));
        },
        sync: (persisted) =>
          syncMemoUpdate(id, projectId, {
            title: persisted.title,
            bodyJson: persisted.bodyJson,
            resolution: persisted.resolution,
            priority: persisted.priority,
            dueAt: persisted.dueAt,
            orderKey: persisted.orderKey,
            resolvedAt: persisted.resolvedAt,
          }),
      });
    },
    [repo, getMemos, setMemos, ensureDb, projectId],
  );

  const setMemoResolution = useCallback(
    async (id: string, resolution: MemoResolution) =>
      updateMemo(id, {
        resolution,
        resolvedAt: resolution === 'resolved' ? new Date().toISOString() : null,
      }),
    [updateMemo],
  );

  const removeMemo = useCallback(
    async (id: string) => {
      await ensureDb();
      const memos = getMemos();
      const existing = memos.find((m) => m.id === id);
      if (!existing) throw new Error(`Memo with id ${id} not found`);

      const filtered = memos.filter((m) => m.id !== id);
      return withOptimisticUpdate({
        apply: () => setMemos(filtered),
        rollback: () => setMemos(memos),
        effect: () => repo.delete(id),
        sync: () => syncMemoDelete(id, projectId),
      });
    },
    [repo, getMemos, setMemos, ensureDb, projectId],
  );

  return useMemo(
    () => ({
      loadInitial,
      createMemo,
      updateMemo,
      setMemoResolution,
      removeMemo,
    }),
    [loadInitial, createMemo, updateMemo, setMemoResolution, removeMemo],
  );
}
