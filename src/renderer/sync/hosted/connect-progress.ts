import { create } from 'zustand';
import type { CloudRestoreProgress } from '../restore/cloud-restore';

/** The running Hosted connect, if any; null when no connect is in flight. */
export const useHostedConnectProgress = create<{ progress: CloudRestoreProgress | null }>(() => ({
  progress: null,
}));

export function reportHostedConnectProgress(progress: CloudRestoreProgress | null): void {
  useHostedConnectProgress.setState({ progress });
}
