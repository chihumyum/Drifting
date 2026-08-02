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
  | {
      kind: 'user';
      text: string;
      /** ISO timestamp captured when the author prompt entered the transcript. */
      at?: string;
    }
  | { kind: 'assistant'; text: string; streaming?: boolean }
  | { kind: 'thinking'; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input?: unknown;
      /** Raw canonical argument buffer while the provider is still streaming it. */
      inputText?: string;
      /** Fine-grained runtime phase shown before the terminal tool result. */
      phase?: 'arguments' | 'ready' | 'executing';
      status: 'running' | 'ok' | 'error';
      result?: string;
      /**
       * Durable editor-review identity returned by a prose write. The chat
       * panel does not expose settlement controls; this journal projection lets
       * recovery/context code retain canonical provenance while the editor owns
       * the inline accept/reject surface.
       */
      review?: {
        id: string;
        status: string;
        provenance?: {
          sessionId: string;
          turnId: string;
          callId: string;
          toolName: string;
        };
      };
    }
  // The agent's evolving plan — replaced in place as TodoWrite is called.
  | { kind: 'todos'; items: AgentTodoItem[] }
  // Per-turn token usage + cost, appended after each turn. Persisted in the
  // transcript so session totals survive reload (summed across these rows).
  // `at` (ISO, set when the turn completed) lets usage be scoped by time window
  // (e.g. this-month vs all-time); absent on rows written before it was added.
  | {
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      turns: number;
      at?: string;
      // Turn timing (SDK duration_ms / duration_api_ms). Optional: absent on
      // rows persisted before timing was added. The gap durationMs − durationApiMs
      // is local overhead (transport + tool execution) vs time in the model API.
      durationMs?: number;
      durationApiMs?: number;
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
  /** Provider-neutral canonical runtime session used for crash recovery. */
  runtimeSessionId: string | null;
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
