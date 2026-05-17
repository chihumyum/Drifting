import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SettingsState {
  autoElementLinkEnabled: boolean;
  setAutoElementLinkEnabled: (enabled: boolean) => void;
  recentEntitiesLimit: number;
  setRecentEntitiesLimit: (count: number) => void;
  // Max number of undoable operations kept by ProseMirror's history extension.
  // Higher = more memory; lower = fewer steps recoverable.
  editorUndoDepth: number;
  setEditorUndoDepth: (count: number) => void;
}

function sanitizeRecentEntitiesLimit(count: number): number {
  if (!Number.isFinite(count)) return 10;
  return Math.max(1, Math.min(50, Math.floor(count)));
}

// Lower bound 10 is enough to survive a brief typing burst; upper bound 1000
// keeps memory bounded for very long sessions.
function sanitizeUndoDepth(count: number): number {
  if (!Number.isFinite(count)) return 100;
  return Math.max(10, Math.min(1000, Math.floor(count)));
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoElementLinkEnabled: true,
      setAutoElementLinkEnabled: (enabled) => set({ autoElementLinkEnabled: enabled }),
      recentEntitiesLimit: 10,
      setRecentEntitiesLimit: (count) =>
        set({ recentEntitiesLimit: sanitizeRecentEntitiesLimit(count) }),
      editorUndoDepth: 100,
      setEditorUndoDepth: (count) => set({ editorUndoDepth: sanitizeUndoDepth(count) }),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        autoElementLinkEnabled: state.autoElementLinkEnabled,
        recentEntitiesLimit: state.recentEntitiesLimit,
        editorUndoDepth: state.editorUndoDepth,
      }),
    },
  ),
);
