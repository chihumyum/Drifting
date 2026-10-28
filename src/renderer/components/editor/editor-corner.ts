import { createContext, useContext, useEffect } from 'react';
import { create } from 'zustand';
import { useEditorSurfaceLifecycle } from './editor-surface-lifecycle-context';

/**
 * The paper's lower-right corner holds the Bottom Timeline toggle and, to its
 * right, the editor's toolbar. With a split editor only the right-hand pane's
 * corner carries the toggle; the stage keeps its own toggle for when no
 * visible editor carries one (Project Home, a new-entity tab).
 */
export const TrailingEditorPaneContext = createContext(false);

const useCornerHosts = create<{ hosts: number }>(() => ({ hosts: 0 }));

/** True when this editor's corner should carry the timeline toggle. */
export function useEditorCornerHostsTimelineToggle(): boolean {
  const trailing = useContext(TrailingEditorPaneContext);
  const { isVisible } = useEditorSurfaceLifecycle();
  const hosts = trailing && isVisible;
  useEffect(() => {
    if (!hosts) return undefined;
    useCornerHosts.setState((state) => ({ hosts: state.hosts + 1 }));
    return () => useCornerHosts.setState((state) => ({ hosts: state.hosts - 1 }));
  }, [hosts]);
  return hosts;
}

/** True when some visible editor corner already carries the timeline toggle. */
export function useTimelineToggleHostedByEditor(): boolean {
  return useCornerHosts((state) => state.hosts > 0);
}
