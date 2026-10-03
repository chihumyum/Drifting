import { createContext, useCallback, useContext, useState, type Dispatch, type SetStateAction, type UIEvent } from 'react';
import { useSidebarPanelStore, useSidebarPanelSessionStore, type SidebarPreferences } from '../store/sidebar-panel-store';
import { useUiStore } from '../store/ui-store';
import type { WorkspaceTarget } from '../features/workspace/navigation/workspace-target';

/** Set by desktop shells; mobile and standalone panels keep their existing owners. */
export const SidebarPanelStateContext = createContext<string | null>(null);
export const useSidebarPanelKey = () => useContext(SidebarPanelStateContext);

/** undefined retains pane-local selection; null explicitly clears the highlight. */
export const SidebarEditorSelectionContext = createContext<WorkspaceTarget | null | undefined>(undefined);

export function useSidebarPanelState<T>(field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const key = useSidebarPanelKey();
  const [local, setLocal] = useState(initial);
  const value = useSidebarPanelSessionStore(state => {
    const fields = key ? state.session[key] : undefined;
    return fields && Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] as T : local;
  });
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(update => {
    if (key) useSidebarPanelSessionStore.getState().setSession(key, field, update, local);
    else setLocal(update);
  }, [key, field, local]);
  return [value, setValue];
}

/** Legacy preferences seed each desktop view; subsequent changes belong to that view. */
export function useSidebarPreference<K extends keyof SidebarPreferences>(field: K): [SidebarPreferences[K], (value: SidebarPreferences[K]) => void] {
  const key = useSidebarPanelKey();
  const shared = useUiStore(state => state[field]);
  const [initial] = useState(shared);
  const value = useSidebarPanelStore(state => key ? state.preferences[key]?.[field] : undefined);
  const setValue = useCallback((next: SidebarPreferences[K]) => {
    if (key) useSidebarPanelStore.getState().setPreference(key, field, next);
    else useUiStore.setState({ [field]: next });
  }, [key, field]);
  return [key ? value ?? initial : shared, setValue];
}

export function useSidebarSelection(fallback: WorkspaceTarget | null) {
  const key = useSidebarPanelKey();
  const editorSelection = useContext(SidebarEditorSelectionContext);
  const [selected, select] = useSidebarPanelState<WorkspaceTarget | null>('selection', fallback);
  if (editorSelection !== undefined) return [editorSelection, select] as const;
  return [key ? selected : fallback, select] as const;
}

export function useSidebarPanelScroll() {
  const key = useSidebarPanelKey();
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node && key) node.scrollTop = (useSidebarPanelSessionStore.getState().session[key]?.scrollTop as number | undefined) ?? 0;
  }, [key]);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (key && event.target === event.currentTarget) useSidebarPanelSessionStore.getState().setSession(key, 'scrollTop', event.currentTarget.scrollTop, 0);
  }, [key]);
  return { ref, onScroll };
}
