import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type { AgentRuntimeEvent } from './types';

// Presentation scheduling metadata follows immutable message-array identity.
// It is neither transcript content nor a durable/runtime event queue.
const deferred = new WeakSet<AgentChatMessage[]>();

export function markAgentChatMessagePublication(messages: AgentChatMessage[], type: AgentRuntimeEvent['type']): void {
  if (type === 'text_delta' || type === 'thinking_delta' || type === 'tool_args_delta') deferred.add(messages);
  else deferred.delete(messages);
}

export function mayDeferAgentChatMessages(messages: AgentChatMessage[]): boolean {
  return deferred.has(messages);
}
