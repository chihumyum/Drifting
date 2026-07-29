/**
 * Renderer-owned General Agent protocol.
 *
 * The Tauri renderer must not import types from the former Electron main
 * process. A future desktop sidecar or remote-agent transport can implement
 * this protocol without reintroducing a renderer -> shell dependency.
 */

export interface AgentTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type AgentEvent =
  | { type: 'system'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | { type: 'todos'; items: AgentTodoItem[] }
  | { type: 'tool_result'; id: string; ok: boolean; text: string }
  | { type: 'result'; ok: boolean; text: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      turns: number;
      durationMs: number;
      durationApiMs: number;
    }
  | { type: 'session'; id: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface AgentEventEnvelope {
  turnId: string;
  event: AgentEvent;
}

export type AgentMode = 'oauth' | 'apikey' | 'hosted';
export type AgentModelChoice = string;
export type AgentEffortChoice = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentThinkingChoice = 'adaptive' | 'off';
export type AgentToolSearchChoice = 'off' | 'auto' | 'on';

export type AgentStartRoute =
  | { kind: 'chat'; projectId: string; conversationId?: string }
  | { kind: 'goal'; projectId: string; goalRunId?: string; chapterId?: string };

export interface AgentStartInput {
  prompt: string;
  /** Canonical destination for runtime events and tool execution. */
  route?: AgentStartRoute;
  /** Legacy compatibility field. Prefer `route.projectId` in new transports. */
  projectId?: string;
  mode?: AgentMode;
  newConversation?: boolean;
  resume?: string;
  turnId?: string;
  model?: AgentModelChoice;
  effort?: AgentEffortChoice;
  thinking?: AgentThinkingChoice;
  toolSearch?: AgentToolSearchChoice;
  writingLanguage?: string;
  projectFacts?: { key: string; value: string }[];
  memories?: { kind: string; body: string }[];
}

export interface GeneralAgentAuthStatus {
  byokConnected: boolean;
  apiKeyConnected: boolean;
  hostedAvailable: boolean;
}

export interface ToolExecRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ToolExecResult =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string };
