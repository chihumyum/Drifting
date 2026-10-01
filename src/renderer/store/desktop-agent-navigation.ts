import { useAgentChatStore } from './agent-chat-store';
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
