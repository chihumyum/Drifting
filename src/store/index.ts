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


// Mock data for testing
const mockBookElementCategories: BookElementCategory[] = [
  {
    id: '1',
    name: '人物',
    description_json: JSON.stringify({ description: '小说中的人物角色' }),
    color: '#3B82F6'
  },
  {
    id: '2',
    name: '地点',
    description_json: JSON.stringify({ description: '故事发生的场所' }),
    color: '#10B981'
  },
  {
    id: '3',
    name: '物品',
    description_json: JSON.stringify({ description: '重要的道具或物品' }),
    color: '#F59E0B'
  },
  {
    id: '4',
    name: '概念',
    description_json: JSON.stringify({ description: '抽象概念或设定' }),
    color: '#8B5CF6'
  }
];

const mockBookElements: BookElement[] = [
  {
    id: '1',
    category: '人物',
    name: '主角',
    tags: ['主角', '男性', '年轻'],
    content_json: JSON.stringify({
      appearance: '黑发黑眼，身材中等',
      personality: '勇敢、善良、有正义感',
      background: '普通家庭出身'
    }),
    summary_json: JSON.stringify({ summary: '故事的主人公，性格坚韧不拔' }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: [
      {
        id: '1-1',
        elementId: '1',
        stage_index: 1,
        start_node_id: 1,
        end_node_id: 5,
        cur_stage_tags: ['初期'],
        cur_stage_content_json: JSON.stringify({ stage_description: '初次登场，展现基本性格' }),
        cur_stage_summary_json: JSON.stringify({ stage_summary: '角色初期设定' }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  },
  {
    id: '2',
    category: '地点',
    name: '神秘森林',
    tags: ['森林', '神秘', '危险'],
    content_json: JSON.stringify({
      description: '古老而神秘的森林，充满未知的危险',
      features: ['古树参天', '雾气弥漫', '野兽出没']
    }),
    summary_json: JSON.stringify({ summary: '故事中重要的冒险场所' }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: []
  },
  {
    id: '3',
    category: '物品',
    name: '魔法剑',
    tags: ['武器', '魔法', '传说'],
    content_json: JSON.stringify({
      appearance: '银色剑身，镶嵌蓝色宝石',
      power: '能够释放冰霜魔法',
      history: '古代英雄的佩剑'
    }),
    summary_json: JSON.stringify({ summary: '主角的重要武器，具有强大魔力' }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: []
  }
];

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
