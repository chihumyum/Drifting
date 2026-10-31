import { create } from 'zustand';
import type { CrashFollowUp } from '../../services/diagnostics/crash-reporter';

/**
 * Whether the feedback dialog is open (Settings → About, the account menu, a
 * crash follow-up in the notification center), and the crash it explains.
 */
export const useFeedbackDialogStore = create<{
  open: boolean;
  followUp: CrashFollowUp | null;
  show(followUp?: CrashFollowUp | null): void;
  close(): void;
}>((set) => ({
  open: false,
  followUp: null,
  show: (followUp = null) => set({ open: true, followUp }),
  close: () => set({ open: false, followUp: null }),
}));
