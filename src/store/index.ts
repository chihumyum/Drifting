import { create } from 'zustand';
import type { BookElement, BookElementCategory } from '../domain/book_element';
import type { BookNode, BookNodeEdge } from '../domain/book_node';

type UiSlice = {
  theme: 'light' | 'dark';
  currentView: 'graph' | 'tree' | 'timeline' | 'editor';
  chapterPanelOpen: boolean;
  setChapterPanelOpen: (isOpen: boolean) => void;
  elementPanelOpen: boolean;
  setBookElementPanelOpen: (isOpen: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setCurrentView: (view: UiSlice['currentView']) => void;

  rightPanelOpen: boolean;
  rightPanelType: 'snippet' | 'todo' | 'statistics' | 'format' | 'ai';
  setRightPanelOpen: (isOpen: boolean) => void;
  setRightPanelType: (rightPanelType: 'snippet' | 'todo' | 'statistics' | 'format' | 'ai') => void;
};

type SelectionSlice = {
  selectedChapterId: string | null;
  selectedBlockId: string | null;
  selectedElement: BookElement | null;
  selectedBookElementId: string | null;
  selectedBookElementCategory: BookElementCategory | null;
  multiSelectedNodeIds: string[];
  setSelectedChapterId: (id: string | null) => void;
  setSelectedBlockId: (id: string | null) => void;
  setSelectedBookElement: (element: BookElement | null) => void;
  setSelectedBookElementCategory: (category: BookElementCategory | null) => void;
  setSelectedBookElementId: (id: string | null) => void;
  setMultiSelectedNodeIds: (ids: string[]) => void;
  clearSelection: () => void;
};


type BookElementSlice = {
  bookElements: BookElement[];
  bookElementCategories: BookElementCategory[];
  setBookElements: (elements: BookElement[]) => void;
  setBookElementCategories: (categories: BookElementCategory[]) => void;
};

type BookNodeSlice = {
  bookNodes: BookNode[];
  nodeEdges: BookNodeEdge[];
  setBookNodes: (nodes: BookNode[]) => void;
  addBookNode: (node: BookNode) => void;
  updateBookNode: (id: string, updates: Partial<BookNode>) => void;
  removeBookNode: (id: string) => void;
  setNodeEdges: (edges: BookNodeEdge[]) => void;
};

type JobsSlice = {
  runningJobs: string[];
  completedJobs: string[];
  jobResults: Record<string, unknown>;
  addJob: (jobId: string) => void;
  completeJob: (jobId: string, result?: unknown) => void;
  removeJob: (jobId: string) => void;
  setJobResult: (jobId: string, result: unknown) => void;
};

export type AppState = UiSlice & SelectionSlice & BookElementSlice & BookNodeSlice & JobsSlice;


export const useAppStore = create<AppState>((set) => ({
  theme: 'dark',
  currentView: 'graph',
  chapterPanelOpen: false,
  elementPanelOpen: false,
  rightPanelOpen: false,
  rightPanelType: 'snippet',
  setTheme: (theme) => set({ theme }),
  setCurrentView: (currentView) => set({ currentView }),
  setChapterPanelOpen: (isOpen) => set({ chapterPanelOpen: isOpen }),
  setBookElementPanelOpen: (open) => set({ elementPanelOpen: open }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  setRightPanelType: (type) => set({ rightPanelType: type }),


  selectedChapterId: null,
  selectedBookElementId: null,
  selectedElement: null,
  selectedBookElement: null,
  selectedBookElementCategory: null,
  selectedBlockId: null,
  multiSelectedNodeIds: [],
  setSelectedChapterId: (selectedChapterId) => set({ selectedChapterId }),
  setSelectedBookElementId: (selectedBookElementId) => set({ selectedBookElementId }),
  setSelectedBookElement: (selectedElement) => set({ selectedElement }),
  setSelectedBlockId: (selectedBlockId) => set({ selectedBlockId }),
  setSelectedBookElementCategory: (selectedBookElementCategory) => set({ selectedBookElementCategory }),

  setMultiSelectedNodeIds: (multiSelectedNodeIds) => set({ multiSelectedNodeIds }),
  clearSelection: () => set({
    selectedChapterId: null,
    selectedBookElementId: null,
    selectedElement: null,
    selectedBlockId: null,
    multiSelectedNodeIds: []
  }),
  // bookElements: mockBookElements,
  bookElements: [],
  setBookElements: (bookElements) => set({ bookElements }),
  // bookElementCategories: mockBookElementCategories,
  bookElementCategories: [],
  setBookElementCategories: (elementCategories) => set({ bookElementCategories: elementCategories }),

  bookNodes: [],
  nodeEdges: [],
  setBookNodes: (bookNodes) => set({ bookNodes }),
  addBookNode: (bookNode) => set((state) => ({ bookNodes: [...state.bookNodes, bookNode] })),
  updateBookNode: (id, updates) => set((state) => ({
    bookNodes: state.bookNodes.map((node) => {
      if (node.id !== id) return node;
      const position = updates.position ? { ...node.position, ...updates.position } : node.position;
      return {
        ...node,
        ...updates,
        position,
      };
    }),
  })),
  removeBookNode: (id) => set((state) => ({ bookNodes: state.bookNodes.filter((node) => node.id !== id) })),
  setNodeEdges: (edges) => set({ nodeEdges: edges }),


  runningJobs: [],
  completedJobs: [],
  jobResults: {},
  addJob: (jobId) => set((state) => ({
    runningJobs: [...state.runningJobs, jobId]
  })),
  completeJob: (jobId, result) => set((state) => ({
    runningJobs: state.runningJobs.filter(id => id !== jobId),
    completedJobs: [...state.completedJobs, jobId],
    jobResults: result ? { ...state.jobResults, [jobId]: result } : state.jobResults
  })),
  removeJob: (jobId) => set((state) => ({
    runningJobs: state.runningJobs.filter(id => id !== jobId),
    completedJobs: state.completedJobs.filter(id => id !== jobId)
  })),
  setJobResult: (jobId, result) => set((state) => ({
    jobResults: { ...state.jobResults, [jobId]: result }
  })),
}));
