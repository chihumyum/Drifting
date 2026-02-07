import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarType = 'left' | 'right';

export interface SidebarState {
  isOpen: boolean;
  width: number;
}

interface UiState {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;

  sidebars: Record<SidebarType, SidebarState>;

  toggleSidebar: (type: SidebarType) => void;
  setSidebarOpen: (type: SidebarType, isOpen: boolean) => void;
  setSidebarWidth: (type: SidebarType, width: number) => void;


  selectedElementId: string | null;
  setSelectedElementId: (id: string | null) => void;
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

      selectedElementId: null,
      setSelectedElementId: (id) => set({ selectedElementId: id }),
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
