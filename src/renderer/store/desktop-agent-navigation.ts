import { sidebarFitsBeside } from '../lib/layout-geometry';
import type { RightSidebarTab, SidebarPaneId, SidebarTabs } from '../lib/sidebar-tabs';
import { useAgentChatStore } from './agent-chat-store';
import { useSidebarMetricsStore } from './sidebar-metrics-store';
import { useUiStore } from './ui-store';

/** Resolve the destination before loading a task, including an unmounted pane. */
export function revealDesktopAgentView(): string {
  const ui = useUiStore.getState();
  ui.setSidebarOpen('right', true);
  ui.setRightPanelGroup('agent');
  const paneId = useUiStore.getState().desktopSidebarTabs.right.focusedPane;
  const paneKey = `sidebar:${paneId}`;
  useAgentChatStore.getState().bindView(paneKey);
  const viewId = useAgentChatStore.getState().viewBindings[paneKey];
  useAgentChatStore.getState().focusView(viewId);
  return viewId;
}

/**
 * The right-sidebar pane a dispatched task opens in: the first pane already
 * showing an Agent tab, otherwise the focused pane (which switches to Agent).
 */
export function agentTaskPane(tabs: SidebarTabs<RightSidebarTab>): SidebarPaneId {
  return (
    tabs.panes.find((pane) => pane.tab === 'companion') ??
    tabs.panes.find((pane) => pane.id === tabs.focusedPane) ??
    tabs.panes[0]
  ).id;
}

/**
 * Shows a background task the author just dispatched (the ⁂ chapter review)
 * in the right sidebar: the first Agent tab switches to it, or an open pane
 * becomes the Agent tab. A closed sidebar opens only when it fits beside the
 * content — or when the author asked to see the task (`force`); otherwise
 * the task keeps running unseen. Returns the Agent view, or null.
 */
export async function showAgentTaskInRightSidebar(
  conversationId: string,
  {
    force = false,
    viewportWidth = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
  }: { force?: boolean; viewportWidth?: number } = {},
): Promise<string | null> {
  const ui = useUiStore.getState();
  if (!ui.sidebars.right.isOpen) {
    const left = ui.sidebars.left;
    const fits = sidebarFitsBeside(
      viewportWidth,
      left.isOpen ? left.width : 0,
      useSidebarMetricsStore.getState().minimumWidths.right,
    );
    if (!force && !fits) return null;
    ui.setSidebarOpen('right', true);
  }
  const paneId = agentTaskPane(useUiStore.getState().desktopSidebarTabs.right);
  useUiStore.getState().focusSidebarPane('right', paneId);
  // Keeps an Agent pane as it is; turns the chosen pane into Agent otherwise.
  useUiStore.getState().setRightPanelGroup('agent');
  const paneKey = `sidebar:${paneId}`;
  useAgentChatStore.getState().bindView(paneKey);
  const viewId = useAgentChatStore.getState().viewBindings[paneKey];
  useAgentChatStore.getState().focusView(viewId);
  await useAgentChatStore.getState().loadConversation(conversationId, viewId);
  return viewId;
}
