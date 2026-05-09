import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SettingsState {
  autoElementLinkEnabled: boolean;
  setAutoElementLinkEnabled: (enabled: boolean) => void;
  recentEntitiesLimit: number;
  setRecentEntitiesLimit: (count: number) => void;
}

function sanitizeRecentEntitiesLimit(count: number): number {
  if (!Number.isFinite(count)) return 10;
  return Math.max(1, Math.min(50, Math.floor(count)));
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoElementLinkEnabled: true,
      setAutoElementLinkEnabled: (enabled) => set({ autoElementLinkEnabled: enabled }),
      recentEntitiesLimit: 10,
      setRecentEntitiesLimit: (count) =>
        set({ recentEntitiesLimit: sanitizeRecentEntitiesLimit(count) }),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        autoElementLinkEnabled: state.autoElementLinkEnabled,
        recentEntitiesLimit: state.recentEntitiesLimit,
      }),
    },
  ),
);
