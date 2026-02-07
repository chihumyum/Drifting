import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarType = 'left' | 'right';

export interface SidebarState {
  isOpen: boolean;
  width: number;
}

type SelectionSource = 'route' | 'ui' | 'system';
export type EditorShellView =
  | 'project-home'
  | 'project-dashboard'
  | 'node-editor'
  | 'storyline-editor'
  | 'all-nodes-editor'
  | 'element-editor'
  | 'category-editor'
  | 'all-elements-editor'
  | 'unknown';

interface EntitySelectionState {
  selectedId: string | null;
  selectedFrom: SelectionSource | null;
  selectedAt: number | null;
}

interface NodeUiContextState extends EntitySelectionState {
  activeStorylineId: string | null;
  tagFilterIds: string[];
}

interface ElementUiContextState extends EntitySelectionState {
  activeCategoryId: string | null;
  tagFilterIds: string[];
}

interface EditorRuntimeState {
  view: EditorShellView;
  activeEntityType: 'node' | 'element' | 'none';
  isAllNodesEditor: boolean;
  isAllElementsEditor: boolean;
  shouldNavigateOnNodeSelect: boolean;
  shouldNavigateOnElementSelect: boolean;
}

interface UiState {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;

  sidebars: Record<SidebarType, SidebarState>;

  toggleSidebar: (type: SidebarType) => void;
  setSidebarOpen: (type: SidebarType, isOpen: boolean) => void;
  setSidebarWidth: (type: SidebarType, width: number) => void;


  nodeUi: NodeUiContextState;
  setNodeSelection: (id: string | null, source?: SelectionSource) => void;
  setNodeActiveStorylineId: (storylineId: string | null) => void;
  setNodeTagFilters: (tagIds: string[]) => void;
  toggleNodeTagFilter: (tagId: string) => void;
  clearNodeUiContext: () => void;

  elementUi: ElementUiContextState;
  setElementSelection: (id: string | null, source?: SelectionSource) => void;
  setElementActiveCategoryId: (categoryId: string | null) => void;
  setElementTagFilters: (tagIds: string[]) => void;
  toggleElementTagFilter: (tagId: string) => void;
  clearElementUiContext: () => void;

  editorRuntime: EditorRuntimeState;
  setEditorRuntime: (runtime: EditorRuntimeState) => void;

  selectedElementId: string | null;
  setSelectedElementId: (id: string | null) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  timelineHeight: number;
  setTimelineHeight: (height: number) => void;

  resizingSidebar: SidebarType | null;
  setResizingSidebar: (type: SidebarType | null) => void;

  activeLeftPanel: 'nodes' | 'elements';
  setActiveLeftPanel: (panel: 'nodes' | 'elements') => void;

  activeSuperView: 'none' | 'element' | 'graph' | 'reference';
  setActiveSuperView: (view: 'none' | 'element' | 'graph' | 'reference') => void;
  lastActiveSuperView: 'element' | 'graph' | 'reference' | null;
  setLastActiveSuperView: (view: 'element' | 'graph' | 'reference' | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',

      sidebars: {
        left: {
          isOpen: true,
          width: 280,
        },
        right: {
          isOpen: false,
          width: 300,
        },
      },

      setTheme: (theme) => set({ theme }),

      toggleSidebar: (type) =>
        set((state) => ({
          sidebars: {
            ...state.sidebars,
            [type]: {
              ...state.sidebars[type],
              isOpen: !state.sidebars[type].isOpen,
            },
          },
        })),

      setSidebarOpen: (type, isOpen) =>
        set((state) => ({
          sidebars: {
            ...state.sidebars,
            [type]: {
              ...state.sidebars[type],
              isOpen,
            },
          },
        })),

      setSidebarWidth: (type, width) =>
        set((state) => ({
          sidebars: {
            ...state.sidebars,
            [type]: {
              ...state.sidebars[type],
              width,
            },
          },
        })),

      nodeUi: {
        selectedId: null,
        selectedFrom: null,
        selectedAt: null,
        activeStorylineId: null,
        tagFilterIds: [],
      },
      setNodeSelection: (id, source = 'ui') =>
        set((state) => ({
          selectedNodeId: id,
          nodeUi: {
            ...state.nodeUi,
            selectedId: id,
            selectedFrom: id ? source : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      setNodeActiveStorylineId: (storylineId) =>
        set((state) => ({
          nodeUi: {
            ...state.nodeUi,
            activeStorylineId: storylineId,
          },
        })),
      setNodeTagFilters: (tagIds) =>
        set((state) => ({
          nodeUi: {
            ...state.nodeUi,
            tagFilterIds: tagIds,
          },
        })),
      toggleNodeTagFilter: (tagId) =>
        set((state) => {
          const exists = state.nodeUi.tagFilterIds.includes(tagId);
          return {
            nodeUi: {
              ...state.nodeUi,
              tagFilterIds: exists
                ? state.nodeUi.tagFilterIds.filter((id) => id !== tagId)
                : [...state.nodeUi.tagFilterIds, tagId],
            },
          };
        }),
      clearNodeUiContext: () =>
        set((state) => ({
          selectedNodeId: null,
          nodeUi: {
            ...state.nodeUi,
            selectedId: null,
            selectedFrom: null,
            selectedAt: null,
            activeStorylineId: null,
            tagFilterIds: [],
          },
        })),

      elementUi: {
        selectedId: null,
        selectedFrom: null,
        selectedAt: null,
        activeCategoryId: null,
        tagFilterIds: [],
      },
      setElementSelection: (id, source = 'ui') =>
        set((state) => ({
          selectedElementId: id,
          elementUi: {
            ...state.elementUi,
            selectedId: id,
            selectedFrom: id ? source : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      setElementActiveCategoryId: (categoryId) =>
        set((state) => ({
          elementUi: {
            ...state.elementUi,
            activeCategoryId: categoryId,
          },
        })),
      setElementTagFilters: (tagIds) =>
        set((state) => ({
          elementUi: {
            ...state.elementUi,
            tagFilterIds: tagIds,
          },
        })),
      toggleElementTagFilter: (tagId) =>
        set((state) => {
          const exists = state.elementUi.tagFilterIds.includes(tagId);
          return {
            elementUi: {
              ...state.elementUi,
              tagFilterIds: exists
                ? state.elementUi.tagFilterIds.filter((id) => id !== tagId)
                : [...state.elementUi.tagFilterIds, tagId],
            },
          };
        }),
      clearElementUiContext: () =>
        set((state) => ({
          selectedElementId: null,
          elementUi: {
            ...state.elementUi,
            selectedId: null,
            selectedFrom: null,
            selectedAt: null,
            activeCategoryId: null,
            tagFilterIds: [],
          },
        })),

      editorRuntime: {
        view: 'unknown',
        activeEntityType: 'none',
        isAllNodesEditor: false,
        isAllElementsEditor: false,
        shouldNavigateOnNodeSelect: true,
        shouldNavigateOnElementSelect: true,
      },
      setEditorRuntime: (runtime) => set({ editorRuntime: runtime }),

      selectedElementId: null,
      setSelectedElementId: (id) =>
        set((state) => ({
          selectedElementId: id,
          elementUi: {
            ...state.elementUi,
            selectedId: id,
            selectedFrom: id ? 'ui' : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      selectedNodeId: null,
      setSelectedNodeId: (id) =>
        set((state) => ({
          selectedNodeId: id,
          nodeUi: {
            ...state.nodeUi,
            selectedId: id,
            selectedFrom: id ? 'ui' : null,
            selectedAt: id ? Date.now() : null,
          },
        })),
      timelineHeight: 200,
      setTimelineHeight: (height) => set({ timelineHeight: height }),

      resizingSidebar: null,
      setResizingSidebar: (type) => set({ resizingSidebar: type }),

      activeLeftPanel: 'elements',
      setActiveLeftPanel: (panel) => set({ activeLeftPanel: panel }),

      activeSuperView: 'none',
      setActiveSuperView: (view) => {
        set(() => {
          const updates: Partial<UiState> = { activeSuperView: view };
          if (view !== 'none') {
            updates.lastActiveSuperView = view;
          }
          return updates;
        });
      },
      lastActiveSuperView: null,
      setLastActiveSuperView: (view) => set({ lastActiveSuperView: view }),
    }),
    {
      name: 'ui-storage', // unique name
      partialize: (state) => ({
        theme: state.theme,
        sidebars: state.sidebars,
        activeLeftPanel: state.activeLeftPanel,
        activeSuperView: state.activeSuperView,
        lastActiveSuperView: state.lastActiveSuperView,
      }),
    }
  )
);
