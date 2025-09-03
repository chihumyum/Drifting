import { create } from 'zustand';
import type { StoryNode, NodeEdge, Entry, NodeBlock } from '../lib/schema';

type UiSlice = {
  theme: 'light' | 'dark';
  currentView: 'graph' | 'tree' | 'timeline' | 'editor' | 'codex';
  sidecarOpen: boolean;
  sidecarTab: 'inspector' | 'todo' | 'snippets';
  commandPaletteOpen: boolean;
  setTheme: (theme: 'light' | 'dark') => void;
  setCurrentView: (view: UiSlice['currentView']) => void;
  setSidecarOpen: (open: boolean) => void;
  setSidecarTab: (tab: UiSlice['sidecarTab']) => void;
  setCommandPaletteOpen: (open: boolean) => void;
};

type SelectionSlice = {
  selectedNodeId: string | null;
  selectedEntryId: string | null;
  selectedBlockId: string | null;
  multiSelectedNodeIds: string[];
  setSelectedNodeId: (id: string | null) => void;
  setSelectedEntryId: (id: string | null) => void;
  setSelectedBlockId: (id: string | null) => void;
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
  blocks: NodeBlock[];
  editorContent: string;
  setCurrentNodeId: (id: string | null) => void;
  setBlocks: (blocks: NodeBlock[]) => void;
  updateBlock: (id: string, updates: Partial<NodeBlock>) => void;
  addBlock: (block: NodeBlock) => void;
  removeBlock: (id: string) => void;
  setEditorContent: (content: string) => void;
};

type CodexSlice = {
  entries: Entry[];
  selectedEntryType: Entry['type'] | 'all';
  searchQuery: string;
  setEntries: (entries: Entry[]) => void;
  addEntry: (entry: Entry) => void;
  updateEntry: (id: string, updates: Partial<Entry>) => void;
  removeEntry: (id: string) => void;
  setSelectedEntryType: (type: Entry['type'] | 'all') => void;
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

export type AppState = UiSlice & SelectionSlice & GraphSlice & EditorSlice & CodexSlice & JobsSlice;

export const useAppStore = create<AppState>((set) => ({
  theme: 'dark',
  currentView: 'graph',
  sidecarOpen: true,
  sidecarTab: 'inspector',
  commandPaletteOpen: false,
  setTheme: (theme) => set({ theme }),
  setCurrentView: (currentView) => set({ currentView }),
  setSidecarOpen: (sidecarOpen) => set({ sidecarOpen }),
  setSidecarTab: (sidecarTab) => set({ sidecarTab }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),

  selectedNodeId: null,
  selectedEntryId: null,
  selectedBlockId: null,
  multiSelectedNodeIds: [],
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setSelectedEntryId: (selectedEntryId) => set({ selectedEntryId }),
  setSelectedBlockId: (selectedBlockId) => set({ selectedBlockId }),
  setMultiSelectedNodeIds: (multiSelectedNodeIds) => set({ multiSelectedNodeIds }),
  clearSelection: () => set({ 
    selectedNodeId: null, 
    selectedEntryId: null, 
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

  entries: [],
  selectedEntryType: 'all',
  searchQuery: '',
  setEntries: (entries) => set({ entries }),
  addEntry: (entry) => set((state) => ({ entries: [...state.entries, entry] })),
  updateEntry: (id, updates) => set((state) => ({
    entries: state.entries.map(entry => entry.id === id ? { ...entry, ...updates } : entry)
  })),
  removeEntry: (id) => set((state) => ({
    entries: state.entries.filter(entry => entry.id !== id)
  })),
  setSelectedEntryType: (selectedEntryType) => set({ selectedEntryType }),
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



