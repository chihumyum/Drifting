/**
 * Agent conversation domain types.
 *
 * `AgentChatMessage` is the rendered chat model the right-sidebar Agent panel
 * builds from the streamed events; it's persisted verbatim as the conversation's
 * messages_json, so display and storage stay in lockstep. `streaming` is a
 * transient UI flag (true only while a block streams) — persisted rows are
 * always finalized.
 */
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
