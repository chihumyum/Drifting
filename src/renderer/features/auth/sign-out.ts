import loglevel from 'loglevel';
import { create } from 'zustand';
import { useAuthStore } from '../../store/auth';
import { countHostedUnuploadedChanges, disconnectHosted } from '../../sync/hosted/disconnect';

const log = loglevel.getLogger('SignOut');

interface SignOutDialogState {
  /** A fresh id per request so reopening always starts a clean dialog. */
  request: { id: number; unuploaded: number; afterSignOut?: () => void } | null;
  close(): void;
}

let nextRequestId = 0;

export const useSignOutDialogStore = create<SignOutDialogState>()((set) => ({
  request: null,
  close: () => set({ request: null }),
}));

/**
 * Signs out from the account menu or Account settings. While this Mac holds
 * changes the cloud lacks, it opens the sign-out dialog instead, which can
 * upload them first; with nothing pending it signs out at once.
 */
export async function requestSignOut(afterSignOut?: () => void): Promise<void> {
  const unuploaded = await countHostedUnuploadedChanges().catch((error: unknown) => {
    log.warn('Could not count unuploaded changes before signing out:', error);
    return 0;
  });
  if (unuploaded > 0) {
    useSignOutDialogStore.setState({ request: { id: ++nextRequestId, unuploaded, afterSignOut } });
    return;
  }
  await useAuthStore.getState().logout();
  afterSignOut?.();
}

/**
 * The dialog's last step: disconnect the library's Hosted sync when the author
 * asked (to switch accounts), then sign out. What has not uploaded by now
 * stays on this Mac.
 */
export async function finishSignOut(signal: AbortSignal, options: { disconnect: boolean }): Promise<void> {
  if (options.disconnect) await disconnectHosted(signal, { uploadFirst: false });
  if (signal.aborted) throw signal.reason;
  await useAuthStore.getState().logout();
}
