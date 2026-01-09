import { create } from 'zustand';

interface UiState {
  theme: 'light' | 'dark';
  currentView: 'graph' | 'tree' | 'timeline' | 'editor';
  chapterPanelOpen: boolean;
  setChapterPanelOpen: (isOpen: boolean) => void;
  elementPanelOpen: boolean;
  setBookElementPanelOpen: (isOpen: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setCurrentView: (view: UiState['currentView']) => void;

  rightPanelOpen: boolean;
  rightPanelType: 'snippet' | 'todo' | 'statistics' | 'format' | 'ai';
  setRightPanelOpen: (isOpen: boolean) => void;
  setRightPanelType: (rightPanelType: 'snippet' | 'todo' | 'statistics' | 'format' | 'ai') => void;

  // Graph View
  isGraphViewOpen: boolean;
  setGraphViewOpen: (isOpen: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
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

  // Graph View
  isGraphViewOpen: false,
  setGraphViewOpen: (isOpen) => set({ isGraphViewOpen: isOpen }),
}));
