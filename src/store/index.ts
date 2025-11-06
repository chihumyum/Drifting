import { create } from 'zustand';
import type { BookElement, BookElementCategory } from '../domain/book_element';
import type { BookNode, BookNodeEdge } from '../domain/book_node';
import type { BookContent } from '../domain/book_content';

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
  
  // Timeline 高度状态
  timelineHeight: number;
  setTimelineHeight: (height: number) => void;
};

type SelectionSlice = {
  selectedNodeId: string | null;
  selectedElementId: string | null;

  selectedElement: BookElement | null;
  selectedBookElementCategory: BookElementCategory | null;
  multiSelectedNodeIds: string[];
  setSelectedNodeId: (id: string | null) => void;
  setSelectedElementId: (id: string | null) => void;
  setSelectedElement: (element: BookElement | null) => void;
  setSelectedElementCategory: (category: BookElementCategory | null) => void;
  setMultiSelectedNodeIds: (ids: string[]) => void;
  
  clearSelection: () => void;
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

type BookContentSlice = { // book content 根据当前的 node Id拿
  bookContent: BookContent | null;
  setBookContent: (content: BookContent | null) => void;
  updateBookContent: (updates: Partial<BookContent>) => void;
};

type BookElementSlice = {
  bookElements: BookElement[];
  bookElementCategories: BookElementCategory[];
  setBookElements: (elements: BookElement[]) => void;
  setBookElementCategories: (categories: BookElementCategory[]) => void;
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

export type AppState = UiSlice & SelectionSlice & BookElementSlice & BookContentSlice & BookNodeSlice & JobsSlice;


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
  
  // Timeline 高度
  timelineHeight: 30, // 默认高度（假设3个threads，收起状态）
  setTimelineHeight: (height) => set({ timelineHeight: height }),


  selectedNodeId: null,
  selectedElementId: null,
  selectedElement: null,
  selectedBookElement: null,
  selectedBookElementCategory: null,
  multiSelectedNodeIds: [],
  setSelectedNodeId: (selectedChapterId) => set({ selectedNodeId: selectedChapterId }),
  setSelectedElementId: (selectedBookElementId) => set({ selectedElementId: selectedBookElementId }),
  setSelectedElement: (selectedElement) => set({ selectedElement }),
  setSelectedElementCategory: (selectedBookElementCategory) => set({ selectedBookElementCategory }),

  setMultiSelectedNodeIds: (multiSelectedNodeIds) => set({ multiSelectedNodeIds }),
  clearSelection: () => set({
    selectedNodeId: null,
    selectedElementId: null,
    selectedElement: null,
    multiSelectedNodeIds: []
  }),
  // bookElements: mockBookElements,
  bookElements: [],
  setBookElements: (bookElements) => set({ bookElements }),
  // bookElementCategories: mockBookElementCategories,
  bookElementCategories: [],
  setBookElementCategories: (elementCategories) => set({ bookElementCategories: elementCategories }),

  bookContent: {} as BookContent,
  setBookContent: (content) => set({ bookContent: content }),
  updateBookContent: (updates) => set((state) => ({
    bookContent: state.bookContent ? { ...state.bookContent, ...updates } : state.bookContent,
  })),

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
