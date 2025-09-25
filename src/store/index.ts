import { create } from 'zustand';
import type { StoryNode, NodeEdge, ContentBlock, EntityCategory } from '../schema/table';
import type { Entity } from '../model/domain';

type UiSlice = {
  theme: 'light' | 'dark';
  currentView: 'graph' | 'tree' | 'timeline' | 'editor';
  chapterPanelOpen: boolean;
  setChapterPanelOpen: (isOpen: boolean) => void;
  entityPanelOpen: boolean;
  setEntityPanelOpen: (isOpen: boolean) => void;
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
  selectedEntity: Entity | null;
  selectedEntityId: string | null;
  selectedEntityCategory: EntityCategory | null;
  multiSelectedNodeIds: string[];
  setSelectedChapterId: (id: string | null) => void;
  setSelectedBlockId: (id: string | null) => void;
  setSelectedEntity: (entity: Entity | null) => void;
  setSelectedEntityCategory: (category: EntityCategory | null) => void;
  setSelectedEntityId: (id: string | null) => void;
  setMultiSelectedNodeIds: (ids: string[]) => void;
  clearSelection: () => void;
};

type GraphSlice = {
  nodes: StoryNode[];
  edges: NodeEdge[];
  graphPosition: { x: number; y: number };
  graphZoom: number;
  setNodes: (nodes: StoryNode[]) => void;
  setEdges: (edges: NodeEdge[]) => void;
  addNode: (node: StoryNode) => void;
  updateNode: (id: string, updates: Partial<StoryNode>) => void;
  removeNode: (id: string) => void;
  addEdge: (edge: NodeEdge) => void;
  removeEdge: (id: string) => void;
  setGraphPosition: (position: { x: number; y: number }) => void;
  setGraphZoom: (zoom: number) => void;
};



type EditorSlice = {
  currentNodeId: string | null;
  blocks: ContentBlock[];
  editorContent: string;
  setCurrentNodeId: (id: string | null) => void;
  setBlocks: (blocks: ContentBlock[]) => void;
  updateBlock: (id: string, updates: Partial<ContentBlock>) => void;
  addBlock: (block: ContentBlock) => void;
  removeBlock: (id: string) => void;
  setEditorContent: (content: string) => void;
};

// 先Entity整体丢进来，日后优化为domain + meta
type EntitySlice = {
  entities: Entity[];
  searchQuery: string;
  setEntities: (entities: Entity[]) => void;
  addEntity: (entity: Entity) => void;
  updateEntity: (id: string, updates: Partial<Entity>) => void;
  removeEntity: (id: string) => void;
  entityCategories: EntityCategory[];
  setEntityCategories: (categories: EntityCategory[]) => void;
  addEntityCategory: (category: EntityCategory) => void;
  updateEntityCategory: (name: string, updates: Partial<EntityCategory>) => void;
  removeEntityCategory: (name: string) => void;


  setSearchQuery: (query: string) => void;
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

export type AppState = UiSlice & SelectionSlice & GraphSlice & EditorSlice & EntitySlice & JobsSlice;

// create Zustand store之后需要先拉取一次state，确保所有的初始值都被正确设置
export const useAppStore = create<AppState>((set) => ({
  theme: 'dark',
  currentView: 'graph',
  chapterPanelOpen: false,
  entityPanelOpen: false,
  rightPanelOpen: false,
  rightPanelType: 'snippet',
  setTheme: (theme) => set({ theme }),
  setCurrentView: (currentView) => set({ currentView }),
  setChapterPanelOpen: (isOpen) => set({ chapterPanelOpen: isOpen }),
  setEntityPanelOpen: (open) => set({ entityPanelOpen: open }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  setRightPanelType: (type) => set({ rightPanelType: type }),


  selectedChapterId: null,
  selectedEntityId: null,
  selectedEntity: null,
  selectedEntityCategory: null,
  selectedBlockId: null,
  multiSelectedNodeIds: [],
  setSelectedChapterId: (selectedNodeId) => set({ selectedChapterId: selectedNodeId }),
  setSelectedEntityId: (selectedEntityId) => set({ selectedEntityId }),
  setSelectedEntity: (selectedEntity) => set({ selectedEntity }),
  setSelectedBlockId: (selectedBlockId) => set({ selectedBlockId }),
  setSelectedEntityCategory: (selectedEntityCategory) => set({ selectedEntityCategory }),

  setMultiSelectedNodeIds: (multiSelectedNodeIds) => set({ multiSelectedNodeIds }),
  clearSelection: () => set({ 
    selectedChapterId: null, 
    selectedEntityId: null, 
    selectedBlockId: null, 
    multiSelectedNodeIds: [] 
  }),

  nodes: [],
  edges: [],
  graphPosition: { x: 0, y: 0 },
  graphZoom: 1,
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node] })),
  updateNode: (id, updates) => set((state) => ({
    nodes: state.nodes.map(node => node.id === id ? { ...node, ...updates } : node)
  })),
  removeNode: (id) => set((state) => ({
    nodes: state.nodes.filter(node => node.id !== id),
    edges: state.edges.filter(edge => edge.src_node_id !== id && edge.dst_node_id !== id)
  })),
  addEdge: (edge) => set((state) => ({ edges: [...state.edges, edge] })),
  removeEdge: (id) => set((state) => ({
    edges: state.edges.filter(edge => edge.id !== id)
  })),
  setGraphPosition: (graphPosition) => set({ graphPosition }),
  setGraphZoom: (graphZoom) => set({ graphZoom }),

  currentNodeId: null,
  blocks: [],
  editorContent: '',
  setCurrentNodeId: (currentNodeId) => set({ currentNodeId }),
  setBlocks: (blocks) => set({ blocks }),
  updateBlock: (id, updates) => set((state) => ({
    blocks: state.blocks.map(block => block.id === id ? { ...block, ...updates } : block)
  })),
  addBlock: (block) => set((state) => ({ blocks: [...state.blocks, block] })),
  removeBlock: (id) => set((state) => ({
    blocks: state.blocks.filter(block => block.id !== id)
  })),
  setEditorContent: (editorContent) => set({ editorContent }),

  entities: [],
  searchQuery: '',
  setEntities: (entities) => set({ entities }),
  addEntity: (entity) => set((state) => ({ entities: [...state.entities, entity] })),
  updateEntity: (id, updates) => set((state) => ({
    entities: state.entities.map(entity => entity.id === id ? { ...entity, ...updates } : entity)
  })),
  removeEntity: (id) => set((state) => ({
    entities: state.entities.filter(entity => entity.id !== id)
  })),
  entityCategories: [],
  setEntityCategories: (entityCategories) => set({ entityCategories }),
  addEntityCategory: (category) => set((state) => ({ entityCategories: [...state.entityCategories, category] })),
  updateEntityCategory: (name, updates) => set((state) => ({
    entityCategories: state.entityCategories.map((cat) => cat.name === name ? { ...cat, ...updates } : cat)
  })),
  removeEntityCategory: (name) => set((state) => ({
    entityCategories: state.entityCategories.filter((cat) => cat.name !== name)
  })),
  setSearchQuery: (searchQuery) => set({ searchQuery }),

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
