import { create } from 'zustand';
import type { Storyline } from '../domain/storyline';
import type { BookNode, BookNodeEdge } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';

interface DataState {
  storylines: Storyline[];
  /** storyline.id → nodeId[] */
  storylineNodeMapping: Record<string, string[]>;
  /** node.id → storylineId[]; reverse of storylineNodeMapping, kept in sync by reducers */
  nodeStorylineMapping: Record<string, string[]>;
  setStorylines: (storylines: Storyline[]) => void;
  addStoryline: (storyline: Storyline) => void;
  updateStoryline: (id: string, updates: Partial<Storyline>) => void;
  removeStoryline: (id: string) => void;
  setStorylineNodeMapping: (mapping: Record<string, string[]>) => void;
  addNodeToStorylineMapping: (storylineId: string, nodeId: string) => void;
  removeNodeFromStorylineMapping: (storylineId: string, nodeId: string) => void;
  setNodeStorylinesMapping: (nodeId: string, storylineIds: string[]) => void;

  bookNodes: BookNode[];
  setBookNodes: (nodes: BookNode[]) => void;
  addBookNode: (node: BookNode) => void;
  updateBookNode: (id: string, updates: Partial<BookNode>) => void;
  removeBookNode: (id: string) => void;

  nodeEdges: BookNodeEdge[];
  setNodeEdges: (edges: BookNodeEdge[]) => void;

  bookElementCategories: BookElementCategory[];
  setBookElementCategories: (categories: BookElementCategory[]) => void;
  addBookElementCategory: (category: BookElementCategory) => void;
  updateBookElementCategory: (id: string, updates: Partial<BookElementCategory>) => void;
  removeBookElementCategory: (id: string) => void;

  bookElements: BookElement[];
  setBookElements: (elements: BookElement[]) => void;
  addBookElement: (element: BookElement) => void;
  updateBookElement: (id: string, updates: Partial<BookElement>) => void;
  removeBookElement: (id: string) => void;
}

function deriveNodeStorylineMapping(
  forward: Record<string, string[]>,
): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  Object.entries(forward).forEach(([storylineId, nodeIds]) => {
    nodeIds.forEach((nodeId) => {
      const arr = reverse[nodeId] || [];
      if (!arr.includes(storylineId)) {
        reverse[nodeId] = [...arr, storylineId];
      } else {
        reverse[nodeId] = arr;
      }
    });
  });
  return reverse;
}

export const useDataStore = create<DataState>((set) => ({
  storylines: [],
  storylineNodeMapping: {},
  nodeStorylineMapping: {},
  addStoryline: (storyline) => set((state) => ({ storylines: [...state.storylines, storyline] })),
  setStorylines: (storylines) => set({ storylines }),
  updateStoryline: (id, updates) =>
    set((state) => ({
      storylines: state.storylines.map((storyline) =>
        storyline.id === id ? { ...storyline, ...updates } : storyline,
      ),
    })),
  removeStoryline: (id) =>
    set((state) => {
      const remainingForward = { ...state.storylineNodeMapping };
      delete remainingForward[id];
      return {
        storylines: state.storylines.filter((storyline) => storyline.id !== id),
        storylineNodeMapping: remainingForward,
        nodeStorylineMapping: deriveNodeStorylineMapping(remainingForward),
      };
    }),
  setStorylineNodeMapping: (mapping) =>
    set({
      storylineNodeMapping: mapping,
      nodeStorylineMapping: deriveNodeStorylineMapping(mapping),
    }),
  addNodeToStorylineMapping: (storylineId, nodeId) =>
    set((state) => {
      const existingForward = state.storylineNodeMapping[storylineId] || [];
      if (existingForward.includes(nodeId)) return state;
      const forward = {
        ...state.storylineNodeMapping,
        [storylineId]: [...existingForward, nodeId],
      };
      const existingReverse = state.nodeStorylineMapping[nodeId] || [];
      const reverse = existingReverse.includes(storylineId)
        ? state.nodeStorylineMapping
        : { ...state.nodeStorylineMapping, [nodeId]: [...existingReverse, storylineId] };
      return { storylineNodeMapping: forward, nodeStorylineMapping: reverse };
    }),
  removeNodeFromStorylineMapping: (storylineId, nodeId) =>
    set((state) => {
      const forward = {
        ...state.storylineNodeMapping,
        [storylineId]: (state.storylineNodeMapping[storylineId] || []).filter(
          (id) => id !== nodeId,
        ),
      };
      const reverse = {
        ...state.nodeStorylineMapping,
        [nodeId]: (state.nodeStorylineMapping[nodeId] || []).filter((id) => id !== storylineId),
      };
      return { storylineNodeMapping: forward, nodeStorylineMapping: reverse };
    }),
  setNodeStorylinesMapping: (nodeId, storylineIds) =>
    set((state) => {
      const forward = { ...state.storylineNodeMapping };
      // Remove nodeId from all storylines where it shouldn't be
      Object.keys(forward).forEach((slId) => {
        if (!storylineIds.includes(slId)) {
          forward[slId] = forward[slId].filter((id) => id !== nodeId);
        }
      });
      // Add nodeId to all storylines where it should be
      storylineIds.forEach((slId) => {
        const existingNodes = forward[slId] || [];
        if (!existingNodes.includes(nodeId)) {
          forward[slId] = [...existingNodes, nodeId];
        }
      });
      const reverse = {
        ...state.nodeStorylineMapping,
        [nodeId]: [...storylineIds],
      };
      return { storylineNodeMapping: forward, nodeStorylineMapping: reverse };
    }),

  bookNodes: [],
  nodeEdges: [],
  setBookNodes: (bookNodes) => set({ bookNodes }),
  addBookNode: (bookNode) => set((state) => ({ bookNodes: [...state.bookNodes, bookNode] })),
  updateBookNode: (id, updates) =>
    set((state) => ({
      bookNodes: state.bookNodes.map((node) => {
        if (node.id !== id) return node;
        const position = updates.position
          ? { ...node.position, ...updates.position }
          : node.position;
        return {
          ...node,
          ...updates,
          position,
        };
      }),
    })),
  removeBookNode: (id) =>
    set((state) => ({ bookNodes: state.bookNodes.filter((node) => node.id !== id) })),
  setNodeEdges: (edges) => set({ nodeEdges: edges }),

  bookElementCategories: [],
  setBookElementCategories: (elementCategories) =>
    set({ bookElementCategories: elementCategories }),
  addBookElementCategory: (category) =>
    set((state) => ({ bookElementCategories: [...state.bookElementCategories, category] })),
  updateBookElementCategory: (id, updates) =>
    set((state) => ({
      bookElementCategories: state.bookElementCategories.map((category) =>
        category.id === id ? { ...category, ...updates } : category,
      ),
    })),
  removeBookElementCategory: (id) =>
    set((state) => ({
      bookElementCategories: state.bookElementCategories.filter((category) => category.id !== id),
    })),

  bookElements: [],
  setBookElements: (bookElements) => set({ bookElements }),
  addBookElement: (element) => set((state) => ({ bookElements: [...state.bookElements, element] })),
  updateBookElement: (id, updates) =>
    set((state) => ({
      bookElements: state.bookElements.map((element) =>
        element.id === id ? { ...element, ...updates } : element,
      ),
    })),
  removeBookElement: (id) =>
    set((state) => ({ bookElements: state.bookElements.filter((element) => element.id !== id) })),
}));
