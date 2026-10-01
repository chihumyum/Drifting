/** A view owns navigation and its draft; transcripts and execution belong to conversations. */
export interface AgentChatViewState {
  activeConvId: string | null;
  prompt: string;
  starting: boolean;
}

export interface AgentChatViewRegistry extends AgentChatViewState {
  focusedViewId: string;
  viewBindings: Record<string, string>;
  views: Record<string, AgentChatViewState>;
}

export const DEFAULT_AGENT_CHAT_VIEW = 'default';
export const EMPTY_AGENT_CHAT_VIEW: AgentChatViewState = {
  activeConvId: null, prompt: '', starting: false,
};

export function readAgentChatView(state: AgentChatViewRegistry, viewId = state.focusedViewId): AgentChatViewState {
  return viewId === state.focusedViewId ? state : state.views[viewId] ?? EMPTY_AGENT_CHAT_VIEW;
}

export function projectAgentChatView<T extends AgentChatViewRegistry>(state: T, viewId: string): T {
  return viewId === state.focusedViewId ? state : { ...state, ...readAgentChatView(state, viewId) };
}

export function patchAgentChatView(state: AgentChatViewRegistry, viewId: string, patch: Partial<AgentChatViewState>): Partial<AgentChatViewRegistry> {
  const { activeConvId, prompt, starting } = readAgentChatView(state, viewId);
  return {
    views: { ...state.views, [viewId]: { activeConvId, prompt, starting, ...patch } },
    ...(viewId === state.focusedViewId ? patch : {}),
  };
}

export function bindAgentChatView(state: AgentChatViewRegistry, paneId: string): Partial<AgentChatViewRegistry> {
  if (state.viewBindings[paneId]) return state;
  // The first pane keeps the existing conversation, even if it is the right
  // half. Subsequent panes start empty. Stable bindings survive tab unmounts.
  const viewId = Object.keys(state.viewBindings).length === 0 ? DEFAULT_AGENT_CHAT_VIEW : paneId;
  return { viewBindings: { ...state.viewBindings, [paneId]: viewId } };
}

export function focusAgentChatView(state: AgentChatViewRegistry, viewId: string): Partial<AgentChatViewRegistry> {
  if (viewId === state.focusedViewId) return state;
  const { activeConvId, prompt, starting } = state;
  const next = readAgentChatView(state, viewId);
  return {
    views: { ...state.views, [state.focusedViewId]: { activeConvId, prompt, starting } },
    focusedViewId: viewId,
    activeConvId: next.activeConvId, prompt: next.prompt, starting: next.starting,
  };
}

export function agentChatViewIds(state: AgentChatViewRegistry): string[] {
  return [...new Set([state.focusedViewId, ...Object.keys(state.views), ...Object.values(state.viewBindings)])];
}

export function agentConversationViewIds(state: AgentChatViewRegistry, conversationId: string): string[] {
  return agentChatViewIds(state).filter(id => readAgentChatView(state, id).activeConvId === conversationId);
}
