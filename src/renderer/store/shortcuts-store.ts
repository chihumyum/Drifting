import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ShortcutActionId =
  | 'closeActiveTab'
  | 'findInEditor'
  | 'globalSearch'
  | 'saveCurrentEditor'
  | 'goBack'
  | 'goForward'
  | 'prevTab'
  | 'nextTab'
  | 'toggleBottomTimeline';

export interface ShortcutActionDef {
  id: ShortcutActionId;
  label: string;
  description: string;
  defaultAccelerator: string;
}

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  {
    id: 'closeActiveTab',
    label: 'Close active tab',
    description: 'Close the active entity editor tab in the top timeline',
    defaultAccelerator: 'Mod+W',
  },
  {
    id: 'findInEditor',
    label: 'Find in current editor',
    description: 'Find text in the currently open editor',
    defaultAccelerator: 'Mod+F',
  },
  {
    id: 'globalSearch',
    label: 'Global search',
    description: 'Search across chapters, storylines, elements, and categories',
    defaultAccelerator: 'Mod+Shift+F',
  },
  {
    id: 'saveCurrentEditor',
    label: 'Save current editor',
    description: 'Force the current editor to persist to the local database',
    defaultAccelerator: 'Mod+S',
  },
  {
    id: 'goBack',
    label: 'Go back',
    description: 'Return to the previous editor page, like browser back',
    defaultAccelerator: 'Mod+[',
  },
  {
    id: 'goForward',
    label: 'Go forward',
    description: 'Go to the next editor page, like browser forward',
    defaultAccelerator: 'Mod+]',
  },
  {
    id: 'prevTab',
    label: 'Previous tab',
    description: 'Switch left among open top tabs',
    defaultAccelerator: 'Mod+Alt+ArrowLeft',
  },
  {
    id: 'nextTab',
    label: 'Next tab',
    description: 'Switch right among open top tabs',
    defaultAccelerator: 'Mod+Alt+ArrowRight',
  },
  {
    id: 'toggleBottomTimeline',
    label: 'Toggle bottom timeline',
    description: 'Show or hide the bottom timeline',
    defaultAccelerator: 'Mod+J',
  },
];

const DEFAULT_BINDINGS: Record<ShortcutActionId, string> = SHORTCUT_ACTIONS.reduce(
  (acc, action) => {
    acc[action.id] = action.defaultAccelerator;
    return acc;
  },
  {} as Record<ShortcutActionId, string>,
);

interface ShortcutsState {
  bindings: Record<ShortcutActionId, string>;
  setBinding: (id: ShortcutActionId, accelerator: string) => void;
  resetBinding: (id: ShortcutActionId) => void;
  resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set) => ({
      bindings: { ...DEFAULT_BINDINGS },
      setBinding: (id, accelerator) =>
        set((state) => ({ bindings: { ...state.bindings, [id]: accelerator } })),
      resetBinding: (id) =>
        set((state) => ({
          bindings: { ...state.bindings, [id]: DEFAULT_BINDINGS[id] },
        })),
      resetAll: () => set({ bindings: { ...DEFAULT_BINDINGS } }),
    }),
    {
      name: 'shortcuts-storage',
      storage: createJSONStorage(() => localStorage),
      // Merge persisted bindings on top of defaults so newly-added actions
      // don't end up undefined for existing users.
      merge: (persisted, current) => {
        const persistedState = (persisted ?? {}) as Partial<ShortcutsState>;
        return {
          ...current,
          ...persistedState,
          bindings: {
            ...DEFAULT_BINDINGS,
            ...(persistedState.bindings ?? {}),
          },
        };
      },
    },
  ),
);

export function getDefaultAccelerator(id: ShortcutActionId): string {
  return DEFAULT_BINDINGS[id];
}
