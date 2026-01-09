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

  isGraphViewOpen: boolean;
  setGraphViewOpen: (isOpen: boolean) => void;
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

      isGraphViewOpen: false,
      setGraphViewOpen: (isOpen) => set({ isGraphViewOpen: isOpen }),
    }),
    {
      name: 'ui-storage', // unique name
      partialize: (state) => ({ 
        theme: state.theme,
        sidebars: state.sidebars,
        // We can choose what to persist
      }),
    }
  )
);
