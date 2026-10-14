import { useEffect } from 'react';
import { create } from 'zustand';
import loglevel from 'loglevel';

import { openLocationHref } from './open-location-link';
import type { WorkspaceNavigator } from './workspace-target';

interface PendingLocationLinkState {
  pending: { projectId: string; href: string } | null;
  request(projectId: string, href: string): void;
  take(projectId: string): string | null;
}

/**
 * An operating-system `drifting://open/<project>/...` link waits here until the
 * named project's workspace is mounted (its data is loaded by then).
 */
export const usePendingLocationLinkStore = create<PendingLocationLinkState>((set, get) => ({
  pending: null,
  request: (projectId, href) => set({ pending: { projectId, href } }),
  take: (projectId) => {
    const pending = get().pending;
    if (!pending || pending.projectId !== projectId) return null;
    set({ pending: null });
    return pending.href;
  },
}));

/** Open this project's pending deep link once its workspace navigator exists. */
export function usePendingLocationLinkConsumer(navigator: Pick<WorkspaceNavigator, 'projectId' | 'open'>): void {
  const pendingProject = usePendingLocationLinkStore((state) => state.pending?.projectId ?? null);
  useEffect(() => {
    if (pendingProject !== navigator.projectId) return;
    const href = usePendingLocationLinkStore.getState().take(navigator.projectId);
    if (!href) return;
    void openLocationHref(navigator, href).then((result) => {
      if (!result.ok) loglevel.getLogger('LocationDeepLink').warn(result.error);
    });
  }, [navigator, pendingProject]);
}
