import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { codexModelCatalog } from '../../lib/agent/codex-model-catalog';
import { events } from '../../lib/events';

export function useCodexModelCatalog(modelMenuOpen: boolean) {
  const subscribe = useCallback((listener: () => void) => modelMenuOpen
    ? codexModelCatalog.subscribe(listener) : () => undefined, [modelMenuOpen]);
  const snapshot = useSyncExternalStore(subscribe, codexModelCatalog.getSnapshot);
  useEffect(() => {
    // Login/logout invalidation belongs to codex-subscription; a closed menu
    // needs neither account IPC on window focus nor React catalog updates.
    if (!modelMenuOpen) return;
    const refresh = () => { void codexModelCatalog.refresh(true); };
    const authChanged = () => { codexModelCatalog.invalidate(); refresh(); };
    refresh();
    events.on('agent:auth-changed', authChanged);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      events.off('agent:auth-changed', authChanged);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [modelMenuOpen]);
  return snapshot;
}
