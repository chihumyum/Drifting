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

export type AgentControlStatus =
  | 'running'
  | 'waiting_permission'
  | 'waiting_user'
  | 'cancelling'
  | 'committing';

export type AgentPermissionScope = 'once' | 'session' | 'project';

export interface AgentPermissionRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  toolName: string;
  access: 'read' | 'write';
  arguments: Record<string, unknown>;
  argumentsHash: string;
  revision: string | null;
  /**
   * Local executable-definition generation. Dynamic tools use this to bind an
   * approval request to the exact handler/schema shown to the user.
   */
  toolDefinitionRevision?: string;
  reason?: string;
  allowedScopes: readonly AgentPermissionScope[];
}

export interface AgentPermissionResolutionInput {
  requestId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  argumentsHash: string;
  revision: string | null;
  decision: 'allow' | 'deny';
  scope: AgentPermissionScope;
  reason?: string;
}

export interface AgentUserInputRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  prompt: string;
}

export interface AgentUserInputResponseInput {
  requestId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  text: string;
}

export interface AgentSteeringInput {
  turnId: string;
  text: string;
}

export interface AgentStopAfterToolInput {
  turnId: string;
}

export interface AgentPendingControl {
  sessionId: string;
  turnId: string;
  status: 'waiting_permission' | 'waiting_user';
  permissionRequest?: AgentPermissionRequest;
  userInputRequest?: AgentUserInputRequest;
  /**
   * True when the renderer process that owned the original execution stack is
   * gone. The control may be displayed or safely cancelled, but must not be
   * presented as directly resumable.
   */
  requiresContinuation: boolean;
}

export interface AgentListPendingControlsInput {
  sessionId: string;
}

export interface AgentCancelPendingControlInput {
  sessionId: string;
  turnId: string;
  requestId: string;
  reason?: string;
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
  | { type: 'control_state'; status: AgentControlStatus }
  | { type: 'permission_request'; request: AgentPermissionRequest }
  | {
      type: 'permission_resolved';
      resolution: AgentPermissionResolutionInput;
    }
  | { type: 'user_input_request'; request: AgentUserInputRequest }
  | {
      type: 'user_input_received';
      response: AgentUserInputResponseInput;
    }
  | { type: 'steering_received'; messageId: string; text: string }
  | { type: 'stop_after_tool_requested' }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface AgentEventEnvelope {
  turnId: string;
  event: AgentEvent;
}

export type AgentMode = 'oauth' | 'apikey' | 'hosted';
export type AgentProviderChoice = 'deepseek' | 'anthropic' | 'openai';
export type AgentModelChoice = string;
export type AgentEffortChoice = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentThinkingChoice = 'adaptive' | 'off';
export type AgentToolSearchChoice = 'off' | 'auto' | 'on';
export type AgentPromptSource = 'author' | 'runtime_continuation';

export type AgentStartRoute =
  | { kind: 'chat'; projectId: string; conversationId?: string }
  | { kind: 'goal'; projectId: string; goalRunId?: string; chapterId?: string };

export interface AgentStartInput {
  prompt: string;
  /** Runtime continuation prompts steer the model but are not author messages. */
  promptSource?: AgentPromptSource;
  /** Canonical destination for runtime events and tool execution. */
  route?: AgentStartRoute;
  /** Legacy compatibility field. Prefer `route.projectId` in new transports. */
  projectId?: string;
  mode?: AgentMode;
  /** Immutable provider route captured when the author submits this turn. */
  provider?: AgentProviderChoice;
  newConversation?: boolean;
  resume?: string;
  turnId?: string;
  model?: AgentModelChoice;
  effort?: AgentEffortChoice;
  thinking?: AgentThinkingChoice;
  toolSearch?: AgentToolSearchChoice;
  /** Canonical author-visible project name, never inferred from `projectId`. */
  projectName?: string;
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
