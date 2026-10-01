import { useAgentChatStore } from './agent-chat-store';
import { projectAgentChatView } from '../lib/agent/runtime/chat-view-state';

type State = ReturnType<typeof useAgentChatStore.getState>;
export type AgentChatViewSource = Pick<typeof useAgentChatStore, 'getState' | 'getInitialState' | 'subscribe'>;

/** A read/action facade, never a second runtime store or journal subscription. */
export function createAgentChatViewSource(viewId: string): AgentChatViewSource {
  const actions: Partial<State> = {
    setPrompt: prompt => useAgentChatStore.getState().setPrompt(prompt, viewId),
    send: options => useAgentChatStore.getState().send({ ...options, viewId }),
    newConversation: () => useAgentChatStore.getState().newConversation(viewId),
    loadConversation: id => useAgentChatStore.getState().loadConversation(id, viewId),
    continueTask: () => useAgentChatStore.getState().continueTask(viewId),
    respondPermission: (decision, scope) => useAgentChatStore.getState().respondPermission(decision, scope, viewId),
    stopAfterTool: () => useAgentChatStore.getState().stopAfterTool(viewId),
    cancelRecoveredControl: () => useAgentChatStore.getState().cancelRecoveredControl(viewId),
    abort: () => useAgentChatStore.getState().abort(viewId),
  };
  const cache = new WeakMap<State, State>();
  const project = (state: State): State => {
    let snapshot = cache.get(state);
    if (!snapshot) {
      snapshot = { ...projectAgentChatView(state, viewId), ...actions };
      cache.set(state, snapshot);
    }
    return snapshot;
  };
  return {
    getState: () => project(useAgentChatStore.getState()),
    getInitialState: () => project(useAgentChatStore.getInitialState()),
    subscribe: listener => useAgentChatStore.subscribe((next, previous) => listener(project(next), project(previous))),
  };
}
