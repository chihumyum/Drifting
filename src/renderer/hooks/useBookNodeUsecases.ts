import { useCallback, useMemo, useRef } from 'react';
import { useAppStore } from '../store';
import { createBookNodeSqliteRepository, createBookNodeEdgeSqliteRepository } from '../repositories/book_node_sqlite';
import { createBookContentRepository } from '../repositories/book_content_sqlite';
import { StoryThreadSQLiteRepository } from '../repositories/story_thread_sqlite';
import type { BookNodeUsecaseDeps } from '../usecase/book_node';
import type { BookNode } from '../domain/book_node';
import {
  createBookNode,
  loadBookNodeEdges,
  loadBookNodes,
  renameBookNode,
  reorderBookNode,
  updateBookNodePosition,
  updateBookNodeSummary,
  updateBookNode,
  deleteBookNode,
  type CreateBookNodeInput,
} from '../usecase/book_node';
import { initDatabase } from '../lib/db';
import { useAuthStore, getProjectId } from '../store/auth';

const getProjectIdForUser = () => {
  const user = useAuthStore.getState().user;
  return getProjectId(user?.id);
};

export function useBookNodeUsecases() {
  const store = useAppStore;
  const depsRef = useRef<BookNodeUsecaseDeps | null>(null);

  if (!depsRef.current) {
    const threadRepo = new StoryThreadSQLiteRepository();
    const contentRepo = createBookContentRepository();
    depsRef.current = {
      nodeRepo: createBookNodeSqliteRepository(getProjectIdForUser()),
      edgeRepo: createBookNodeEdgeSqliteRepository(getProjectIdForUser()),
      threadRepo,
      contentRepo,
      getNodesState: () => store.getState().bookNodes,
      setNodesState: (nodes) => store.getState().setBookNodes(nodes),
      updateNodeState: (id, updates) => store.getState().updateBookNode(id, updates),
      setEdgesState: (edges) => store.getState().setNodeEdges(edges),
      now: () => new Date(),
    };
  }

  const deps = depsRef.current!;
  const ensureDb = useCallback((projectId?: string) => initDatabase(projectId ?? getProjectIdForUser()), []);

  return useMemo(() => ({
    loadNodes: async (options?: { projectId?: string }) => {
      await ensureDb(options?.projectId);
      return loadBookNodes(deps, options);
    },
    loadEdges: async (projectId?: string) => {
      await ensureDb(projectId);
      return loadBookNodeEdges(deps, projectId);
    },
    createNode: async (input: CreateBookNodeInput) => {
      await ensureDb(input.projectId);
      return createBookNode(deps, input);
    },
    renameNode: async (id: string, title: string) => {
      await ensureDb();
      return renameBookNode(deps, id, title);
    },
    reorderNode: async (id: string, direction: 'up' | 'down') => {
      await ensureDb();
      return reorderBookNode(deps, id, direction);
    },
    updateNodePosition: async (id: string, position: CreateBookNodeInput['position']) => {
      if (!position) return;
      await ensureDb();
      return updateBookNodePosition(deps, id, position);
    },
    updateNodeSummary: async (id: string, summary: string | null) => {
      await ensureDb();
      return updateBookNodeSummary(deps, id, summary);
    },
    updateNode: async (id: string, updates: Partial<BookNode>) => {
      await ensureDb();
      return updateBookNode(deps, id, updates);
    },
    deleteNode: async (id: string) => {
      await ensureDb();
      return deleteBookNode(deps, id);
    },
    _deps: deps,
  }), [deps, ensureDb]);
}
