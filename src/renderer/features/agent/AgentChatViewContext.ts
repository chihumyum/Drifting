import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { useAgentChatStore } from '../../store/agent-chat-store';
import type { AgentChatViewSource } from '../../store/agent-chat-view-source';

export const AgentChatViewContext = createContext<AgentChatViewSource>(useAgentChatStore);
export const useAgentChatViewSource = () => useContext(AgentChatViewContext);
export function useAgentChatViewStore<T>(selector: (state: ReturnType<AgentChatViewSource['getState']>) => T): T {
  return useStore(useAgentChatViewSource(), selector);
}
