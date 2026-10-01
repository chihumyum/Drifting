import { useEffect, useSyncExternalStore } from 'react';
import { codexModelCatalog } from '../../lib/agent/codex-model-catalog';
import { events } from '../../lib/events';

export function useCodexModelCatalog(modelMenuOpen: boolean) {
  const snapshot = useSyncExternalStore(codexModelCatalog.subscribe, codexModelCatalog.getSnapshot);
  useEffect(() => {
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
  }, []);
  useEffect(() => {
    if (modelMenuOpen) void codexModelCatalog.refresh(true);
  }, [modelMenuOpen]);
  return snapshot;
}
