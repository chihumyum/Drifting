import { getDbIfInitialized } from '../../lib/db';
import { events } from '../../lib/events';
import { platform } from '../../platform';
import { SyncGenerationProvisionSupervisor } from '../../sync/provision/supervisor';
import { syncShareInbox } from './share-inbox';
import { canShareLinks, useShareLinkStore } from './share-link-store';
import { notifyReaderComments } from './share-comment-notifications';

/** Readers' comments arrive within this long while Drifting is in front. */
export const SHARE_INBOX_FOREGROUND_MS = 15_000;
/** ...and within this long while it is in the background. */
export const SHARE_INBOX_BACKGROUND_MS = 60_000;

const foreground = () =>
  typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus());

/** App-wide: polls the account's share inbox while signed in. */
export function installShareInboxRuntime(): () => void {
  let lastRunAt = 0;
  const supervisor = new SyncGenerationProvisionSupervisor({
    canUseProvider: () => getDbIfInitialized() !== null && canShareLinks(),
    async runOnce(signal) {
      lastRunAt = Date.now();
      const result = await syncShareInbox(signal);
      if (result?.arrived.length) {
        const shares = useShareLinkStore.getState().shares;
        notifyReaderComments(result.arrived, shareId => shares.find(link => link.id === shareId)?.title ?? null);
      }
    },
    onError(error) {
      console.warn('[share-links] Inbox will retry', error);
    },
  });
  const request = () => supervisor.requestRun();
  const tick = () => {
    const interval = foreground() ? SHARE_INBOX_FOREGROUND_MS : SHARE_INBOX_BACKGROUND_MS;
    if (Date.now() - lastRunAt >= interval - 1000) request();
  };
  events.on('db:ready', request);
  events.on('sync:authority-changed', request);
  globalThis.addEventListener?.('focus', request);
  globalThis.addEventListener?.('online', request);
  const unsubscribeResume = platform.lifecycle.onReadyOrResume(request);
  const timer = globalThis.setInterval(tick, SHARE_INBOX_FOREGROUND_MS);
  return () => {
    globalThis.clearInterval(timer);
    unsubscribeResume();
    globalThis.removeEventListener?.('focus', request);
    globalThis.removeEventListener?.('online', request);
    events.off('db:ready', request);
    events.off('sync:authority-changed', request);
    supervisor.stop();
  };
}
