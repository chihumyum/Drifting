import type { McpServerGrant, McpServerRequest } from '../../../platform/mcp-server-contract';
import type { DriftingAgentProductComposition } from './drifting-product-composition';
import type {
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentRuntimeContext,
} from './types';
import { isDriftingDomainProviderToolName } from './drifting-workspace-tool-contract';
import { createDriftingAgentPermissionPolicy } from './drifting-permission-policy';
import { hashAgentPermissionArguments } from './control-plane';
import { sharedAgentRuntimeScheduler } from './scheduler';
import { throwIfAgentAborted } from './errors';

/** `_meta` key carrying local presentation metadata (for example a write review). */
export const MCP_PRESENTATION_META_KEY = 'cc.drifting/presentation';

export interface ExternalToolSessionOptions {
  sessionId: string;
  grant: McpServerGrant;
  composition: DriftingAgentProductComposition;
  /** Ensures the conversation exists in the same database as the composition. */
  ensureConversation(id: string, grant: McpServerGrant): Promise<void>;
}

/** Direct tool entry point: no model invocation, provider credentials or prompt loop.
 * Shares the product's validation, permission policy, scheduler and tool owners. */
export class ExternalToolSession {
  private readonly context: AgentRuntimeContext;
  private ordinal = 0;
  private initialized: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private grantRevision = 0;

  constructor(private readonly options: ExternalToolSessionOptions) {
    this.context = {
      route: {
        kind: 'chat',
        projectId: options.grant.projectId,
        conversationId: `${options.sessionId}:conversation`,
      },
    };
  }

  get connectionId(): string {
    return this.options.grant.id;
  }

  updateGrant(grant: McpServerGrant): void {
    const previous = this.options.grant;
    if (grant.id !== previous.id || grant.projectId !== previous.projectId)
      throw new Error('Cannot change an MCP connection scope');
    if (grant.access !== previous.access || grant.allowDangerous !== previous.allowDangerous) {
      this.grantRevision++;
      this.options.grant = grant;
    }
  }

  private definitions() {
    const { composition, grant } = this.options;
    return [
      ...composition.workspaceTools.listDefinitions(this.context),
      ...composition.tools.listDefinitions(this.context),
    ].filter(
      (tool) =>
        (isDriftingDomainProviderToolName(tool.name) || tool.name === 'read_tool_result') &&
        (tool.access === 'read' || grant.access === 'write'),
    );
  }

  handle(request: McpServerRequest['request'], signal: AbortSignal): Promise<unknown> {
    const revision = this.grantRevision;
    const assertAuthorized = () => {
      throwIfAgentAborted(signal);
      if (this.closed) throw new Error('MCP connection closed; reconnect and read again');
      if (revision !== this.grantRevision)
        throw new Error('MCP permissions changed; inspect any interrupted write before retrying');
    };
    // Stable ordering within an external conversation keeps read handles and
    // turn ordinals coherent; other conversations use the shared scheduler.
    const work = this.tail.then(async () => {
      assertAuthorized();
      if (request.method === 'tools/list') {
        if (request.params?.cursor) throw new Error('Invalid tool-list cursor');
        return {
          tools: this.definitions().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.access === 'read', openWorldHint: false },
          })),
        };
      }
      if (request.method !== 'tools/call') throw new Error('Unsupported MCP method');
      try {
        const result = await this.call(request, signal, assertAuthorized);
        const text = result.ok
          ? typeof result.modelData === 'string'
            ? result.modelData
            : JSON.stringify(result.modelData ?? result.data)
          : result.error;
        return {
          content: [{ type: 'text', text }],
          // No structuredContent: clients such as Claude Code show it to the
          // model instead of content, hiding the result. Presentation is
          // client metadata that must stay out of model context.
          ...(result.ok && result.presentation
            ? { _meta: { [MCP_PRESENTATION_META_KEY]: result.presentation } }
            : {}),
          isError: !result.ok,
        };
      } catch (error) {
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : 'MCP tool failed' },
          ],
          isError: true,
        };
      }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    this.options.composition.workspaceTools.releaseExternalSession(this.options.sessionId);
    if (!this.initialized) return;
    await this.initialized;
    const at = new Date().toISOString();
    await this.options.composition.repositories.runtime.updateSession(this.options.sessionId, {
      status: 'closed',
      endedAt: at,
      updatedAt: at,
    });
  }

  private async initialize(): Promise<void> {
    const { grant, sessionId, composition, ensureConversation } = this.options;
    const conversationId = `${sessionId}:conversation`;
    await ensureConversation(conversationId, grant);
    const at = new Date().toISOString();
    await composition.repositories.runtime.createSession({
      id: sessionId,
      projectId: grant.projectId,
      routeKind: 'chat',
      conversationId,
      goalRunId: null,
      chapterId: null,
      provider: 'mcp',
      model: null,
      providerEpoch: 0,
      status: 'idle',
      createdAt: at,
      updatedAt: at,
      endedAt: null,
    });
  }

  private async call(
    message: McpServerRequest['request'],
    signal: AbortSignal,
    assertAuthorized: () => void,
  ): Promise<AgentToolExecutionResult> {
    const { composition, grant, sessionId } = this.options;
    const definition = this.definitions().find((tool) => tool.name === message.params?.name);
    if (!definition)
      throw new Error(
        'Tool is unavailable for this connection; check its project and read/write permissions',
      );
    const args = message.params?.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args))
      throw new Error('Tool arguments must be an object');
    const validation = definition.validateInput(args);
    if (!validation.ok) throw new Error(validation.error);
    // Do not cache a failed initialization: it would fail every later call.
    this.initialized ??= this.initialize().catch((error: unknown) => {
      this.initialized = null;
      throw error;
    });
    await this.initialized;
    throwIfAgentAborted(signal);
    const ordinal = ++this.ordinal;
    const turnId = `${sessionId}:turn:${ordinal}`;
    const callId = String(message.id);
    const idempotencyKey = `${sessionId}:${turnId}:${callId}`;
    const request: AgentToolExecutionRequest = {
      sessionId,
      turnId,
      callId,
      idempotencyKey,
      name: definition.name,
      arguments: validation.value,
      access: definition.access,
      context: this.context,
      signal,
    };
    if (definition.access === 'write') {
      const argumentsHash = await hashAgentPermissionArguments(validation.value);
      const requestId = `mcp-grant:${grant.id}:${turnId}`;
      const policy = createDriftingAgentPermissionPolicy({
        allowDangerousOperations: () => grant.allowDangerous,
      });
      const decision = await policy.decide({
        requestId,
        sessionId,
        turnId,
        callId,
        toolName: definition.name,
        access: definition.access,
        arguments: validation.value,
        argumentsHash,
        revision: null,
        allowedScopes: ['once'],
        context: this.context,
      });
      if (decision.decision !== 'allow')
        throw new Error(
          decision.decision === 'ask'
            ? 'This operation requires the connection’s destructive-operation permission. Change authorization in Drifting.'
            : decision.reason,
        );
      request.authorization = { kind: 'author_approved', requestId, argumentsHash };
    }
    const persistence = composition.repositories.runtime;
    const at = new Date().toISOString();
    await persistence.createTurn({
      id: turnId,
      sessionId,
      ordinal,
      status: 'running',
      promptMessageId: null,
      acceptedAt: at,
      startedAt: at,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: at,
    });
    const toolCallId = `agent-tool:${sessionId}:${turnId}:${callId}`;
    await persistence.createToolCall({
      id: toolCallId,
      sessionId,
      turnId,
      callId,
      name: definition.name,
      access: definition.access,
      status: 'running',
      idempotencyKey,
      arguments: validation.value,
      result: null,
      errorCode: null,
      createdAt: at,
      startedAt: at,
      completedAt: null,
    });
    let result: AgentToolExecutionResult;
    try {
      const execute = () => {
        // Permission may have changed while persistence or the shared writer
        // scheduler was awaited. Never execute with that stale authorization.
        assertAuthorized();
        return definition.access === 'read'
          ? composition.workspaceTools.execute(request)
          : composition.tools.execute(request);
      };
      result =
        definition.access === 'read'
          ? await sharedAgentRuntimeScheduler.runRead(request, execute)
          : await sharedAgentRuntimeScheduler.runWrite(request, execute);
    } catch (error) {
      const end = new Date().toISOString();
      await persistence.updateToolCall(toolCallId, {
        status: 'interrupted',
        errorCode: 'MCP_INTERRUPTED',
        completedAt: end,
      });
      await persistence.updateTurn(turnId, {
        status: 'interrupted',
        errorCode: 'MCP_INTERRUPTED',
        endedAt: end,
        updatedAt: end,
      });
      throw error;
    }
    const end = new Date().toISOString();
    await persistence.updateToolCall(toolCallId, {
      status: result.ok ? 'completed' : 'failed',
      result,
      errorCode: result.ok ? null : 'MCP_TOOL_FAILED',
      completedAt: end,
    });
    await persistence.updateTurn(turnId, {
      status: result.ok ? 'completed' : 'failed',
      endedAt: end,
      updatedAt: end,
      errorCode: result.ok ? null : 'MCP_TOOL_FAILED',
    });
    return result;
  }
}
