/**
 * Agent conversation domain types.
 *
 * `AgentChatMessage` is the rendered chat model the right-sidebar Agent panel
 * builds from the streamed events; it's persisted verbatim as the conversation's
 * messages_json, so display and storage stay in lockstep. `streaming` is a
 * transient UI flag (true only while a block streams) — persisted rows are
 * always finalized.
 */
export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item in the agent's working plan (from the built-in TodoWrite tool). */
export interface AgentTodoItem {
  content: string;
  status: AgentTodoStatus;
  /** Present-continuous form shown while the item is in progress. */
  activeForm?: string;
}

export type AgentChatMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming?: boolean }
  | { kind: 'thinking'; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input?: unknown;
      status: 'running' | 'ok' | 'error';
      result?: string;
    }
  // The agent's evolving plan — replaced in place as TodoWrite is called.
  | { kind: 'todos'; items: AgentTodoItem[] }
  | { kind: 'error'; text: string };

export type AgentConvMode = 'byok' | 'hosted';

/** A full conversation including its transcript (returned by `get`). */
export interface AgentConversation {
  id: string;
  projectId: string;
  title: string;
  /** SDK session to resume for context; null until the first turn reports one. */
  sdkSessionId: string | null;
  mode: AgentConvMode;
  messages: AgentChatMessage[];
  createdAt: string;
  updatedAt: string;
}

/** A lightweight list row (returned by `listByProject`) — no transcript. */
export interface AgentConversationSummary {
  id: string;
  title: string;
  mode: AgentConvMode;
  updatedAt: string;
}
