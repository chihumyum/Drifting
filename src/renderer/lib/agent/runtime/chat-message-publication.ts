import type { AgentChatTranscript } from '../../../domain/agent-chat-transcript';
import type { AgentRuntimeEvent } from './types';

// Presentation scheduling metadata follows immutable transcript identity.
// It is neither transcript content nor a durable/runtime event queue.
const deferred = new WeakSet<AgentChatTranscript>();

export function markAgentChatMessagePublication(messages: AgentChatTranscript, type: AgentRuntimeEvent['type']): void {
  if (type === 'text_delta' || type === 'thinking_delta' || type === 'tool_args_delta') deferred.add(messages);
  else deferred.delete(messages);
}

export function mayDeferAgentChatMessages(messages: AgentChatTranscript): boolean {
  return deferred.has(messages);
}
