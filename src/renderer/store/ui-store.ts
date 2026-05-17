import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarType = 'left' | 'right';

export type TabEntityType = 'node' | 'storyline' | 'element' | 'category';

export interface TabRef {
  entityType: TabEntityType;
  id: string;
}

export interface Tab extends TabRef {
  isPreview: boolean;
}

export interface ProjectTabsState {
  openTabs: Tab[];
  activeTabKey: string | null;
}

export function tabKey(ref: TabRef): string {
  return `${ref.entityType}:${ref.id}`;
}

const EMPTY_PROJECT_TABS: ProjectTabsState = Object.freeze({
  openTabs: [] as Tab[],
  activeTabKey: null,
}) as ProjectTabsState;

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
  | 'element-editor'
  | 'category-editor'
  | 'unknown';

interface EntitySelectionState {
  selectedId: string | null;
  selectedFrom: SelectionSource | null;
  selectedAt: number | null;
}

interface NodeUiContextState extends EntitySelectionState {
  activeStorylineId: string | null;
}

interface ElementUiContextState extends EntitySelectionState {
  activeCategoryId: string | null;
}

interface EditorRuntimeState {
  view: EditorShellView;
  activeEntityType: 'node' | 'element' | 'none';
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
  clearNodeUiContext: () => void;

  elementUi: ElementUiContextState;
  setElementSelection: (id: string | null, source?: SelectionSource) => void;
  setElementActiveCategoryId: (categoryId: string | null) => void;
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

  activeLeftPanel: 'nodes' | 'elements' | 'drift';
  setActiveLeftPanel: (panel: 'nodes' | 'elements' | 'drift') => void;
  /**
   * NodesPanel layout — 'global' lists every storyline-anchored node sorted by
   * timeline start; 'storyline' groups nodes under their parent storylines.
   * Lifted to the store so the sub-meta toolbar (LeftSidebarSubHeader) can
   * drive it from outside the panel.
   */
  nodesPanelViewMode: 'global' | 'storyline';
  setNodesPanelViewMode: (mode: 'global' | 'storyline') => void;
  activeRightPanel: 'fragments' | 'stats' | 'shadow';
  setActiveRightPanel: (panel: 'fragments' | 'stats' | 'shadow') => void;

  shadowMode: boolean;
  setShadowMode: (active: boolean) => void;
  toggleShadowMode: () => void;

  activeSuperView: 'none' | 'element' | 'graph' | 'reference';
  setActiveSuperView: (view: 'none' | 'element' | 'graph' | 'reference') => void;
  lastActiveSuperView: 'element' | 'graph' | 'reference' | null;
  setLastActiveSuperView: (view: 'element' | 'graph' | 'reference' | null) => void;

  tabsByProject: Record<string, ProjectTabsState>;
  openEntityTab: (projectId: string, ref: TabRef, options?: { preview?: boolean }) => void;
  promoteTab: (projectId: string, ref?: TabRef) => void;
  closeTab: (projectId: string, ref: TabRef) => { nextActive: Tab | null };
  reorderTabs: (projectId: string, fromIndex: number, toIndex: number) => void;
  setActiveTab: (projectId: string, ref: TabRef | null) => void;
  clearProjectTabs: (projectId: string) => void;
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
      clearNodeUiContext: () =>
        set((state) => ({
          selectedNodeId: null,
          nodeUi: {
            ...state.nodeUi,
            selectedId: null,
            selectedFrom: null,
            selectedAt: null,
            activeStorylineId: null,
          },
        })),

      elementUi: {
        selectedId: null,
        selectedFrom: null,
        selectedAt: null,
        activeCategoryId: null,
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
      clearElementUiContext: () =>
        set((state) => ({
          selectedElementId: null,
          elementUi: {
            ...state.elementUi,
            selectedId: null,
            selectedFrom: null,
            selectedAt: null,
            activeCategoryId: null,
          },
        })),

      editorRuntime: {
        view: 'unknown',
        activeEntityType: 'none',
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
      nodesPanelViewMode: 'storyline',
      setNodesPanelViewMode: (mode) => set({ nodesPanelViewMode: mode }),
      activeRightPanel: 'fragments',
      setActiveRightPanel: (panel) => set({ activeRightPanel: panel }),

      shadowMode: false,
      setShadowMode: (active) =>
        set((state) => {
          // Auto-focus the Shadow tab when entering shadow mode; restore the
          // default tab if the user leaves shadow mode while on Shadow.
          if (active) {
            return { shadowMode: true, activeRightPanel: 'shadow' };
          }
          return {
            shadowMode: false,
            activeRightPanel: state.activeRightPanel === 'shadow' ? 'fragments' : state.activeRightPanel,
          };
        }),
      toggleShadowMode: () =>
        set((state) => {
          const next = !state.shadowMode;
          if (next) return { shadowMode: true, activeRightPanel: 'shadow' };
          return {
            shadowMode: false,
            activeRightPanel: state.activeRightPanel === 'shadow' ? 'fragments' : state.activeRightPanel,
          };
        }),

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

      tabsByProject: {},

      openEntityTab: (projectId, ref, options) =>
        set((state) => {
          const preview = options?.preview ?? true;
          const project = state.tabsByProject[projectId] ?? EMPTY_PROJECT_TABS;
          const key = tabKey(ref);
          const existingIdx = project.openTabs.findIndex((t) => tabKey(t) === key);

          let nextOpenTabs: Tab[];
          if (existingIdx >= 0) {
            // Already open — just activate. Preserve isPreview (don't demote dedicated → preview).
            nextOpenTabs = project.openTabs;
          } else if (preview) {
            // Replace existing preview tab in place, or append new preview tab.
            const previewIdx = project.openTabs.findIndex((t) => t.isPreview);
            const newTab: Tab = { ...ref, isPreview: true };
            if (previewIdx >= 0) {
              nextOpenTabs = project.openTabs.slice();
              nextOpenTabs[previewIdx] = newTab;
            } else {
              nextOpenTabs = [...project.openTabs, newTab];
            }
          } else {
            // Dedicated tab — append.
            nextOpenTabs = [...project.openTabs, { ...ref, isPreview: false }];
          }

          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: key },
            },
          };
        }),

      promoteTab: (projectId, ref) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const targetKey = ref ? tabKey(ref) : project.activeTabKey;
          if (!targetKey) return {};
          const idx = project.openTabs.findIndex((t) => tabKey(t) === targetKey);
          if (idx < 0 || !project.openTabs[idx].isPreview) return {};
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs[idx] = { ...nextOpenTabs[idx], isPreview: false };
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      closeTab: (projectId, ref) => {
        let nextActive: Tab | null = null;
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          const key = tabKey(ref);
          const idx = project.openTabs.findIndex((t) => tabKey(t) === key);
          if (idx < 0) return {};
          const nextOpenTabs = project.openTabs.slice();
          nextOpenTabs.splice(idx, 1);

          let nextActiveTabKey: string | null = project.activeTabKey;
          if (project.activeTabKey === key) {
            if (nextOpenTabs.length === 0) {
              nextActiveTabKey = null;
            } else {
              // Prefer right neighbor (now at `idx`), else fall back to new last.
              const successor =
                idx < nextOpenTabs.length ? nextOpenTabs[idx] : nextOpenTabs[nextOpenTabs.length - 1];
              nextActiveTabKey = tabKey(successor);
              nextActive = successor;
            }
          }
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { openTabs: nextOpenTabs, activeTabKey: nextActiveTabKey },
            },
          };
        });
        return { nextActive };
      },

      reorderTabs: (projectId, fromIndex, toIndex) =>
        set((state) => {
          const project = state.tabsByProject[projectId];
          if (!project) return {};
          if (
            fromIndex === toIndex ||
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= project.openTabs.length ||
            toIndex >= project.openTabs.length
          ) {
            return {};
          }
          const nextOpenTabs = project.openTabs.slice();
          const [moved] = nextOpenTabs.splice(fromIndex, 1);
          nextOpenTabs.splice(toIndex, 0, moved);
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, openTabs: nextOpenTabs },
            },
          };
        }),

      setActiveTab: (projectId, ref) =>
        set((state) => {
          const project = state.tabsByProject[projectId] ?? EMPTY_PROJECT_TABS;
          const nextKey = ref ? tabKey(ref) : null;
          if (project.activeTabKey === nextKey) return {};
          return {
            tabsByProject: {
              ...state.tabsByProject,
              [projectId]: { ...project, activeTabKey: nextKey },
            },
          };
        }),

      clearProjectTabs: (projectId) =>
        set((state) => {
          if (!state.tabsByProject[projectId]) return {};
          const rest = { ...state.tabsByProject };
          delete rest[projectId];
          return { tabsByProject: rest };
        }),
    }),
    {
      name: 'ui-storage', // unique name
      partialize: (state) => ({
        theme: state.theme,
        sidebars: state.sidebars,
        activeLeftPanel: state.activeLeftPanel,
        nodesPanelViewMode: state.nodesPanelViewMode,
        activeRightPanel: state.activeRightPanel,
        activeSuperView: state.activeSuperView,
        lastActiveSuperView: state.lastActiveSuperView,
        shadowMode: state.shadowMode,
        tabsByProject: state.tabsByProject,
      }),
      // Older persisted state used 'references' | 'inspirations' | 'ai' for
      // activeRightPanel. Coerce any unknown value back to the default so the
      // first render after upgrade doesn't crash the right panel.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<UiState>) };
        const allowed = new Set(['fragments', 'stats', 'shadow']);
        if (!allowed.has(merged.activeRightPanel as string)) {
          merged.activeRightPanel = 'fragments';
        }
        return merged;
      },
    },
  ),
);

export function useProjectTabs(projectId: string | undefined | null): ProjectTabsState {
  return useUiStore((s) => (projectId ? s.tabsByProject[projectId] : undefined) ?? EMPTY_PROJECT_TABS);
}

export function usePromoteCurrentTab(projectId: string | undefined | null): () => void {
  return useCallback(() => {
    if (projectId) useUiStore.getState().promoteTab(projectId);
  }, [projectId]);
}
