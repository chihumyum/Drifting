import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  BYOK_MODEL_LIST_PROVIDERS,
  byokModelLists,
  refreshByokModelLists,
} from '../../lib/agent/byok-model-catalog';

/** Changes whenever a provider list publishes, so the open menu re-reads its models. */
const listsVersion = () => BYOK_MODEL_LIST_PROVIDERS
  .map((provider) => {
    const { state, updatedAt } = byokModelLists[provider].getSnapshot();
    return `${state}:${updatedAt ?? ''}`;
  })
  .join('|');

/**
 * Keeps the API-key providers' own model lists fresh while the model menu is
 * open: on open, on window focus (within the refresh window) and when the
 * network returns. Key changes invalidate the lists in byok-model-catalog.
 */
export function useByokModelLists(modelMenuOpen: boolean): string {
  const subscribe = useCallback((listener: () => void) => {
    if (!modelMenuOpen) return () => undefined;
    const unsubscribe = BYOK_MODEL_LIST_PROVIDERS.map((provider) =>
      byokModelLists[provider].subscribe(listener));
    return () => { for (const off of unsubscribe) off(); };
  }, [modelMenuOpen]);
  const version = useSyncExternalStore(subscribe, listsVersion);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const refresh = () => { void refreshByokModelLists(); };
    const forceRefresh = () => { void refreshByokModelLists(true); };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', forceRefresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', forceRefresh);
    };
  }, [modelMenuOpen]);
  return version;
}
