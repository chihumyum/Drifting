import { clonePortableData } from './portable-data';
import type {
  AgentMcpClient,
  AgentMcpToolCallResult,
  AgentMcpToolDescriptor,
} from './mcp-tool-source';
import {
  DRIFTING_MCP_PROTOCOL_VERSION,
  type AgentMcpJsonRpcTransport,
} from './mcp-transport';

const MAX_LIST_PAGES = 16;
const MAX_TOOLS = 256;
const MAX_TOOL_RESULT_BYTES = 4 * 1024 * 1024;

export interface ConnectedAgentMcpClient extends AgentMcpClient {
  readonly serverInfo: Readonly<Record<string, unknown>>;
  close(): Promise<void>;
  ping(signal: AbortSignal): Promise<void>;
}

export async function connectAgentMcpClient(input: {
  transport: AgentMcpJsonRpcTransport;
  signal: AbortSignal;
}): Promise<ConnectedAgentMcpClient> {
  await input.transport.connect(input.signal);
  const initialized = requireRecord(
    await input.transport.request({
      method: 'initialize',
      params: {
        protocolVersion: DRIFTING_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Drifting', version: '1' },
      },
      signal: input.signal,
    }),
    'MCP initialize result',
  );
  if (initialized.protocolVersion !== DRIFTING_MCP_PROTOCOL_VERSION) {
    await input.transport.close();
    throw new Error(
      `MCP server negotiated unsupported protocol version "${String(initialized.protocolVersion)}"`,
    );
  }
  const capabilities = requireRecord(initialized.capabilities, 'MCP server capabilities');
  if (!hasOwn(capabilities, 'tools')) {
    await input.transport.close();
    throw new Error('MCP server does not advertise tools capability');
  }
  const serverInfo = normalizeServerInfo(initialized.serverInfo);
  input.transport.setProtocolVersion(DRIFTING_MCP_PROTOCOL_VERSION);
  await input.transport.notify({
    method: 'notifications/initialized',
    signal: input.signal,
  });

  return {
    serverInfo,
    async listTools({ signal }) {
      const tools: AgentMcpToolDescriptor[] = [];
      const seenNames = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = requireRecord(
          await input.transport.request({
            method: 'tools/list',
            ...(cursor ? { params: { cursor } } : {}),
            signal,
          }),
          'MCP tools/list result',
        );
        if (!Array.isArray(result.tools)) throw new Error('MCP tools/list omitted tools');
        for (const raw of result.tools) {
          const tool = normalizeTool(raw);
          if (seenNames.has(tool.name)) {
            throw new Error(`MCP server returned duplicate tool "${tool.name}"`);
          }
          seenNames.add(tool.name);
          tools.push(tool);
          if (tools.length > MAX_TOOLS) throw new Error('MCP server exceeds 256 tools');
        }
        if (result.nextCursor == null) return tools;
        if (
          typeof result.nextCursor !== 'string' ||
          !result.nextCursor ||
          result.nextCursor.length > 1_000 ||
          seenCursors.has(result.nextCursor)
        ) {
          throw new Error('MCP tools/list returned an invalid pagination cursor');
        }
        cursor = result.nextCursor;
        seenCursors.add(cursor);
      }
      throw new Error('MCP tools/list exceeded 16 pages');
    },
    async callTool({ name, arguments: argumentsValue, signal }) {
      if (!name || name.length > 300) throw new Error('MCP tool name is invalid');
      const result = requireRecord(
        await input.transport.request({
          method: 'tools/call',
          params: {
            name,
            arguments: clonePortableData(argumentsValue),
          },
          signal,
          timeoutMs: 300_000,
        }),
        'MCP tools/call result',
      );
      return normalizeToolResult(result);
    },
    async ping(signal) {
      const result = await input.transport.request({ method: 'ping', signal });
      requireRecord(result, 'MCP ping result');
    },
    close: () => input.transport.close(),
  };
}

function normalizeTool(value: unknown): AgentMcpToolDescriptor {
  const tool = requireRecord(value, 'MCP tool');
  if (typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 300) {
    throw new Error('MCP tool name is invalid');
  }
  if (
    tool.description != null &&
    (typeof tool.description !== 'string' || tool.description.length > 4_000)
  ) {
    throw new Error(`MCP tool "${tool.name}" description is invalid`);
  }
  const inputSchema = requireRecord(tool.inputSchema, `MCP tool "${tool.name}" inputSchema`);
  const annotations =
    tool.annotations == null
      ? undefined
      : requireRecord(tool.annotations, `MCP tool "${tool.name}" annotations`);
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: clonePortableData(inputSchema),
    ...(annotations
      ? { annotations: clonePortableData(annotations) }
      : {}),
  };
}

function normalizeToolResult(value: Record<string, unknown>): AgentMcpToolCallResult {
  if (value.isError != null && typeof value.isError !== 'boolean') {
    throw new Error('MCP tools/call returned an invalid isError flag');
  }
  if (!Array.isArray(value.content) && value.structuredContent == null) {
    throw new Error('MCP tools/call returned neither content nor structuredContent');
  }
  const content = clonePortableData(
    {
      ...(Array.isArray(value.content) ? { content: value.content } : {}),
      ...(value.structuredContent != null
        ? { structuredContent: value.structuredContent }
        : {}),
    },
  );
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > MAX_TOOL_RESULT_BYTES) {
    throw new Error('MCP tool result exceeded the 4 MiB limit');
  }
  return { content, ...(value.isError === true ? { isError: true } : {}) };
}

function normalizeServerInfo(value: unknown): Readonly<Record<string, unknown>> {
  const info = requireRecord(value, 'MCP serverInfo');
  if (
    typeof info.name !== 'string' ||
    !info.name.trim() ||
    info.name.length > 200 ||
    typeof info.version !== 'string' ||
    !info.version.trim() ||
    info.version.length > 200
  ) {
    throw new Error('MCP serverInfo is invalid');
  }
  return clonePortableData(info);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
