import { create } from 'zustand';

interface SettingsState {
  autoElementLinkEnabled: boolean;
  setAutoElementLinkEnabled: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  autoElementLinkEnabled: true,
  setAutoElementLinkEnabled: (enabled) => set({ autoElementLinkEnabled: enabled }),
}));
