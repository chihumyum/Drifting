import { useCallback, useMemo, useRef } from 'react';
import { useAppStore } from '../store';
import { createBookNodeSqliteRepository, createBookNodeEdgeSqliteRepository } from '../repositories/book_node_sqlite';
import type { BookNodeUsecaseDeps } from '../usecase/book_node';
import {
  createBookNode,
  loadBookNodeEdges,
  loadBookNodes,
  renameBookNode,
  reorderBookNode,
  updateBookNodePosition,
  updateBookNodeSummary,
  type CreateBookNodeInput,
} from '../usecase/book_node';
import { initDatabase } from '../lib/db';

const PROJECT_ID = 'default-project';

export function useBookNodeUsecases() {
  const store = useAppStore;
  const depsRef = useRef<BookNodeUsecaseDeps | null>(null);

  if (!depsRef.current) {
    depsRef.current = {
      nodeRepo: createBookNodeSqliteRepository(PROJECT_ID),
      edgeRepo: createBookNodeEdgeSqliteRepository(PROJECT_ID),
      getNodesState: () => store.getState().bookNodes,
      setNodesState: (nodes) => store.getState().setBookNodes(nodes),
      updateNodeState: (id, updates) => store.getState().updateBookNode(id, updates),
      setEdgesState: (edges) => store.getState().setNodeEdges(edges),
      now: () => new Date(),
    };
  }

  const deps = depsRef.current!;
  const ensureDb = useCallback((projectId?: string) => initDatabase(projectId ?? PROJECT_ID), []);

  return useMemo(() => ({
    loadNodes: async (options?: { projectId?: string; type?: CreateBookNodeInput['type'] }) => {
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
    _deps: deps,
  }), [deps, ensureDb]);
}
