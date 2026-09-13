import { useMemo, useState } from 'react';
import { AgentChatTranscript } from '../../domain/agent-chat-transcript';
import type { AgentChatMessage } from '../../domain/agent-conversation';

export const AGENT_MESSAGE_BLOCK_SIZE = 64;
export interface AgentMessageBlock { readonly start: number; readonly messages: readonly AgentChatMessage[] }

/** One view's bounded cache of its latest immutable display snapshot. Checking
 * array identities remains O(history); tree inputs compare leaf identities first.
 * Unchanged blocks avoid JSX creation and React
 * reconciliation. No old-snapshot chain, global registry, or DOM windowing. */
export function createAgentMessageBlockProjection() {
  let source: readonly AgentChatMessage[] | AgentChatTranscript | undefined;
  let leaves: readonly (readonly AgentChatMessage[])[] = [];
  let blocks: readonly AgentMessageBlock[] = [];
  return (messages: readonly AgentChatMessage[] | AgentChatTranscript): readonly AgentMessageBlock[] => {
    if (messages === source) return blocks;
    if (messages instanceof AgentChatTranscript) {
      const nextLeaves: (readonly AgentChatMessage[])[] = [];
      messages.forEachLeaf(rows => nextLeaves.push(rows));
      const next: AgentMessageBlock[] = [];
      let unchanged = Math.ceil(messages.length / AGENT_MESSAGE_BLOCK_SIZE) === blocks.length;
      // Transcript leaves are 32 rows; preserve the existing 64-row React keys.
      for (let i = 0; i < nextLeaves.length; i += 2) {
        const first = nextLeaves[i]; const second = nextLeaves[i + 1];
        const previous = blocks[next.length]; const size = first.length + (second?.length ?? 0);
        let same = previous?.messages.length === size;
        if (same && (leaves[i] !== first || leaves[i + 1] !== second)) {
          // Full hydration or abandoned renders may replace leaves while keeping
          // individual message identities. Retain the array path's reuse rule.
          for (let offset = 0; same && offset < size; offset++) same = previous.messages[offset] === (offset < first.length ? first[offset] : second![offset - first.length]);
        }
        next.push(same ? previous : { start: next.length * AGENT_MESSAGE_BLOCK_SIZE, messages: second ? [...first, ...second] : [...first] });
        unchanged &&= same;
      }
      source = messages; leaves = nextLeaves;
      if (!unchanged) blocks = next;
      return blocks;
    }
    leaves = [];
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

export function useAgentMessageBlocks(messages: readonly AgentChatMessage[] | AgentChatTranscript) {
  const [project] = useState(createAgentMessageBlockProjection);
  // An abandoned render may replace the cache, but content equality is checked
  // on every call; the cache never owns conversation or interaction state.
  return useMemo(() => project(messages), [messages, project]);
}
