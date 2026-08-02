import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { connectAgentMcpClient } from './mcp-client';
import { createHttpAgentMcpTransport } from './mcp-transport';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

describe('MCP Streamable HTTP real socket', () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((stop) => stop()));
  });

  it('runs initialize, initialized, discovery, call, ping and DELETE on one negotiated session', async () => {
    const observed: Array<{
      method: string;
      session: string | null;
      protocol: string | null;
    }> = [];
    const fixture = await listen(async (request, response, message) => {
      observed.push({
        method: request.method ?? '',
        session: request.headers['mcp-session-id']?.toString() ?? null,
        protocol: request.headers['mcp-protocol-version']?.toString() ?? null,
      });
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      if (!message) throw new Error('missing message');
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (message.method === 'initialize') {
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'real-http-fixture', version: '1' },
        };
        response.setHeader('Mcp-Session-Id', 'fixture-session');
      } else if (message.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Echo input.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          ],
        };
      } else if (message.method === 'tools/call') {
        result = { structuredContent: { echo: message.params?.arguments } };
      }
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    close.push(fixture.close);
    const transport = createHttpAgentMcpTransport({ url: fixture.url });
    const client = await connectAgentMcpClient({
      transport,
      signal: new AbortController().signal,
    });

    await expect(client.listTools({ signal: new AbortController().signal })).resolves.toMatchObject([
      { name: 'echo' },
    ]);
    await expect(
      client.callTool({
        name: 'echo',
        arguments: { text: 'rain' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      content: { structuredContent: { echo: { text: 'rain' } } },
    });
    await client.ping(new AbortController().signal);
    await client.close();

    expect(observed.map((entry) => entry.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(observed[0]).toMatchObject({ session: null, protocol: null });
    for (const entry of observed.slice(1)) {
      expect(entry.session).toBe('fixture-session');
      expect(entry.protocol).toBe('2025-06-18');
    }
  });

  it('aborts a hanging real HTTP request at the local timeout', async () => {
    const fixture = await listen(async (_request, _response, _message) => {
      await new Promise(() => undefined);
    });
    close.push(fixture.close);
    const transport = createHttpAgentMcpTransport({ url: fixture.url });
    await expect(
      transport.request({
        method: 'ping',
        signal: new AbortController().signal,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    await transport.close();
  });
});

async function listen(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    message: RpcRequest | null,
  ) => Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const message = body ? (JSON.parse(body) as RpcRequest) : null;
      await handler(request, response, message);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
