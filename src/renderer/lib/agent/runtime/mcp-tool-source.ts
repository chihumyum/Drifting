import {
  DynamicAgentToolRegistry,
  type DynamicAgentToolApproval,
  type DynamicAgentToolSourceHandle,
} from './dynamic-tool-runtime';

export interface AgentMcpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: object;
  /**
   * MCP annotations are intentionally retained only for a host policy to
   * inspect. They are untrusted hints, not an authorization decision.
   */
  annotations?: Readonly<Record<string, unknown>>;
}

export interface AgentMcpToolCallResult {
  content: unknown;
  isError?: boolean;
}

export interface AgentMcpClient {
  listTools(input: {
    signal: AbortSignal;
  }): Promise<readonly AgentMcpToolDescriptor[]>;
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<AgentMcpToolCallResult>;
}

export interface AgentMcpToolLocalPolicy {
  access: 'read' | 'write';
  approval: DynamicAgentToolApproval;
}

export interface RegisterAgentMcpToolSourceOptions {
  registry: DynamicAgentToolRegistry;
  client: AgentMcpClient;
  serverId: string;
  projectId: string;
  /** Stable persisted MCP configuration fingerprint. */
  sourceRevision?: string;
  signal: AbortSignal;
  /** Already validated discovery from the connection handshake. */
  discoveredTools?: readonly AgentMcpToolDescriptor[];
  /**
   * Mandatory local authority. Returning null keeps the discovered tool
   * hidden. Never derive write permission solely from MCP annotations.
   */
  classify(
    tool: AgentMcpToolDescriptor,
  ): AgentMcpToolLocalPolicy | null;
}

/**
 * Transport-neutral MCP discovery bridge.
 *
 * Desktop stdio, Streamable HTTP and future mobile transports can implement
 * `AgentMcpClient` without changing the Agent Runtime. This layer only imports
 * locally classified tools into the dynamic registry.
 */
export async function registerAgentMcpToolSource(
  options: RegisterAgentMcpToolSourceOptions,
): Promise<DynamicAgentToolSourceHandle> {
  // Refresh is a trust-boundary transition. Disable the previous generation
  // first so an invalid/new server cannot keep executing through stale schema
  // and approval metadata if discovery fails.
  options.registry.unregisterSource({
    sourceId: options.serverId,
    sourceKind: 'mcp',
    projectId: options.projectId,
  });
  if (options.signal.aborted) {
    throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  const discovered =
    options.discoveredTools ??
    (await options.client.listTools({
      signal: options.signal,
    }));
  if (options.signal.aborted) {
    throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  const seen = new Set<string>();
  const tools = discovered.flatMap((tool) => {
    if (seen.has(tool.name)) {
      throw new Error(
        `MCP server "${options.serverId}" returned duplicate tool "${tool.name}"`,
      );
    }
    seen.add(tool.name);
    const policy = options.classify(tool);
    if (!policy) return [];
    return [
      {
        remoteName: tool.name,
        description:
          tool.description?.trim() ||
          `Tool "${tool.name}" from MCP server "${options.serverId}".`,
        inputSchema: tool.inputSchema,
        access: policy.access,
        approval: policy.approval,
        execute: async ({
          remoteName,
          arguments: argumentsValue,
          signal,
        }: {
          remoteName: string;
          arguments: Record<string, unknown>;
          signal: AbortSignal;
        }) => {
          const result = await options.client.callTool({
            name: remoteName,
            arguments: argumentsValue,
            signal,
          });
          if (result.isError) {
            throw new Error(mcpErrorMessage());
          }
          return result.content;
        },
      },
    ];
  });
  return options.registry.registerSource({
    sourceId: options.serverId,
    sourceKind: 'mcp',
    projectId: options.projectId,
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    tools,
  });
}

function mcpErrorMessage(): string {
  // External error payloads may contain credentials, request headers, or huge
  // diagnostics. Keep them out of the canonical journal/model transcript.
  return 'MCP tool returned an error; inspect the configured server logs.';
}
