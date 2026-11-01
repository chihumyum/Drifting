import { useCallback } from 'react';

import { events } from '../../lib/events';
import { useOpenSignIn } from '../auth/auth-dialog-store';
import { productSyncRuntimeControl } from '../../sync/product-runtime-control';
import type { SyncProblem } from '../../sync/sync-health';

/** What the paper's sync card and the bell's pinned row can do about a sync state. */
export type SyncStatusAction = 'retry' | 'sign-in' | 'open-settings';

/** The actions a state offers, in the order the card lists them. */
export function syncActionsFor(state: SyncProblem | 'retrying' | 'offline'): readonly SyncStatusAction[] {
  if (state === 'reauth') return ['sign-in'];
  if (state === 'quota') return ['open-settings', 'retry'];
  return ['retry'];
}

/**
 * Retry runs a fresh cycle for the SyncGenerations in trouble (all of them
 * when none is named), or activates sync again when it could not start;
 * sign-in opens the account dialog; open-settings opens the workspace's
 * Settings on Account, where Hosted storage and sync progress are.
 */
export function useSyncStatusActions() {
  const openSignIn = useOpenSignIn();
  return useCallback(
    (action: SyncStatusAction, target: { problem?: SyncProblem; syncGenerationIds?: readonly string[] } = {}) => {
      if (action === 'sign-in') {
        openSignIn();
        return;
      }
      if (action === 'open-settings') {
        events.emit('settings:open', { railId: 'account' });
        return;
      }
      if (target.problem === 'not-started') {
        productSyncRuntimeControl.retryActivation();
        return;
      }
      try {
        const ids = target.syncGenerationIds ?? [];
        if (ids.length === 0) productSyncRuntimeControl.triggerManual();
        else for (const id of ids) productSyncRuntimeControl.triggerManual(id);
      } catch {
        // No coordinator yet: the next activation runs a cycle on its own.
      }
    },
    [openSignIn],
  );
}
