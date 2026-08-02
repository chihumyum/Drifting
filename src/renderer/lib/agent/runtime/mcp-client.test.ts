import { describe, expect, it, vi } from 'vitest';

import { connectAgentMcpClient } from './mcp-client';
import {
  DRIFTING_MCP_PROTOCOL_VERSION,
  type AgentMcpJsonRpcTransport,
  type AgentMcpRequestMethod,
} from './mcp-transport';

function scriptedTransport(
  handler: (method: AgentMcpRequestMethod, params?: Record<string, unknown>) => unknown,
): AgentMcpJsonRpcTransport & { close: ReturnType<typeof vi.fn> } {
  return {
    kind: 'stdio',
    connect: vi.fn(async () => undefined),
    request: vi.fn(async ({ method, params }) => handler(method, params)),
    notify: vi.fn(async () => undefined),
    setProtocolVersion: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

describe('MCP client lifecycle and discovery', () => {
  it('initializes, paginates discovery, calls a tool, pings, and closes', async () => {
    const transport = scriptedTransport((method, params) => {
      if (method === 'initialize') {
        return {
          protocolVersion: DRIFTING_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fixture', version: '1.0.0' },
        };
      }
      if (method === 'tools/list') {
        return params?.cursor
          ? {
              tools: [
                {
                  name: 'write-note',
                  description: 'Write a note.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            }
          : {
              tools: [
                {
                  name: 'search',
                  description: 'Search notes.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
              nextCursor: 'page-2',
            };
      }
      if (method === 'tools/call') {
        return { content: [{ type: 'text', text: 'done' }] };
      }
      return {};
    });
    const client = await connectAgentMcpClient({ transport, signal: new AbortController().signal });

    await expect(client.listTools({ signal: new AbortController().signal })).resolves.toHaveLength(2);
    await expect(
      client.callTool({
        name: 'search',
        arguments: { query: 'rain' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ content: { content: [{ type: 'text', text: 'done' }] } });
    await client.ping(new AbortController().signal);
    await client.close();

    expect(transport.setProtocolVersion).toHaveBeenCalledWith(DRIFTING_MCP_PROTOCOL_VERSION);
    expect(transport.notify).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'notifications/initialized' }),
    );
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('fails closed and closes when a server negotiates an unsupported version', async () => {
    const transport = scriptedTransport(() => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'old', version: '1' },
    }));
    await expect(
      connectAgentMcpClient({ transport, signal: new AbortController().signal }),
    ).rejects.toThrow('unsupported protocol version');
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate names across discovery pages', async () => {
    let page = 0;
    const transport = scriptedTransport((method) => {
      if (method === 'initialize') {
        return {
          protocolVersion: DRIFTING_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
      }
      page += 1;
      return {
        tools: [{ name: 'same', inputSchema: { type: 'object' } }],
        ...(page === 1 ? { nextCursor: 'next' } : {}),
      };
    });
    const client = await connectAgentMcpClient({ transport, signal: new AbortController().signal });
    await expect(client.listTools({ signal: new AbortController().signal })).rejects.toThrow(
      'duplicate tool',
    );
  });
});
