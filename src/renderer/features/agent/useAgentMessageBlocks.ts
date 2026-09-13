import { useMemo, useState } from 'react';
import type { AgentChatMessage } from '../../domain/agent-conversation';

export const AGENT_MESSAGE_BLOCK_SIZE = 64;
export interface AgentMessageBlock { readonly start: number; readonly messages: readonly AgentChatMessage[] }

/** One view's bounded cache of its latest immutable display snapshot. Checking
 * identities remains O(history); unchanged blocks avoid JSX creation and React
 * reconciliation. No old-snapshot chain, global registry, or DOM windowing. */
export function createAgentMessageBlockProjection() {
  let source: readonly AgentChatMessage[] | undefined;
  let blocks: readonly AgentMessageBlock[] = [];
  return (messages: readonly AgentChatMessage[]): readonly AgentMessageBlock[] => {
    if (messages === source) return blocks;
    const next: AgentMessageBlock[] = [];
    let unchanged = Math.ceil(messages.length / AGENT_MESSAGE_BLOCK_SIZE) === blocks.length;
    for (let start = 0; start < messages.length; start += AGENT_MESSAGE_BLOCK_SIZE) {
      const previous = blocks[next.length];
      const size = Math.min(AGENT_MESSAGE_BLOCK_SIZE, messages.length - start);
      let same = previous?.messages.length === size;
      for (let offset = 0; same && offset < size; offset++) same = previous.messages[offset] === messages[start + offset];
      next.push(same ? previous : { start, messages: messages.slice(start, start + size) });
      unchanged &&= same;
    }
    source = messages;
    if (!unchanged) blocks = next;
    return blocks;
  };
}

export function useAgentMessageBlocks(messages: readonly AgentChatMessage[]) {
  const [project] = useState(createAgentMessageBlockProjection);
  // An abandoned render may replace the cache, but content equality is checked
  // on every call; the cache never owns conversation or interaction state.
  return useMemo(() => project(messages), [messages, project]);
}
