import { create } from 'zustand';

/** Whether the account's share link list is open (user menu, Settings → Account). */
export const useShareLinksDialogStore = create<{ open: boolean; show(): void; close(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
