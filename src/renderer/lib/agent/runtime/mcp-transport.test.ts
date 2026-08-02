import { describe, expect, it, vi } from 'vitest';

import type { McpHttpPlatformApi, McpStdioPlatformApi } from '../../../platform';
import {
  createHttpAgentMcpTransport,
  createStdioAgentMcpTransport,
  DRIFTING_MCP_PROTOCOL_VERSION,
} from './mcp-transport';

const signal = () => new AbortController().signal;

function responseFor(request: RequestInit | undefined, result: unknown): Response {
  const body = JSON.parse(String(request?.body)) as { id: string };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MCP JSON-RPC transports', () => {
  it('owns one stdio process, validates the exact response id, and stops it', async () => {
    const platform: McpStdioPlatformApi = {
      start: vi.fn(async (input) => ({ processId: input.processId, pid: 42 })),
      request: vi.fn(async (input) => {
        const request = JSON.parse(input.message) as { id: string; method: string };
        return JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { method: request.method },
        });
      }),
      notify: vi.fn(async () => undefined),
      stop: vi.fn(async () => true),
      status: vi.fn(async (processId) => ({
        processId,
        running: true,
        pid: 42,
        configRevision: 'sha256:revision',
        fatalError: null,
        stderrLines: [],
      })),
    };
    const transport = createStdioAgentMcpTransport({
      platform,
      processId: 'mcp:test:1',
      command: '/usr/bin/node',
      args: ['/tmp/server.mjs'],
      cwd: '/tmp',
      env: {},
      configRevision: 'sha256:revision',
    });

    await expect(
      transport.request({ method: 'ping', signal: signal() }),
    ).resolves.toEqual({ method: 'ping' });
    await transport.notify({ method: 'notifications/initialized', signal: signal() });
    await transport.close();

    expect(platform.start).toHaveBeenCalledTimes(1);
    expect(platform.request).toHaveBeenCalledTimes(1);
    expect(platform.notify).toHaveBeenCalledTimes(1);
    expect(platform.stop).toHaveBeenCalledWith('mcp:test:1');
  });

  it('carries the negotiated HTTP session and protocol without replaying an expired request', async () => {
    const requests: Array<{ method: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        const response = responseFor(init, { protocolVersion: DRIFTING_MCP_PROTOCOL_VERSION });
        response.headers.set('Mcp-Session-Id', 'session-1');
        return response;
      }
      if (requests.length === 2) return new Response('', { status: 202 });
      if (requests.length === 3) return new Response('', { status: 404 });
      return new Response('', { status: 204 });
    });
    const transport = createHttpAgentMcpTransport({
      url: 'http://127.0.0.1:31415/mcp',
      fetch: fetchMock,
    });
    const controller = new AbortController();

    await transport.request({
      method: 'initialize',
      params: {},
      signal: controller.signal,
    });
    transport.setProtocolVersion(DRIFTING_MCP_PROTOCOL_VERSION);
    await transport.notify({
      method: 'notifications/initialized',
      signal: controller.signal,
    });
    await expect(
      transport.request({ method: 'ping', signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'session_expired' });

    expect(requests[1]?.headers.get('mcp-session-id')).toBe('session-1');
    expect(requests[1]?.headers.get('mcp-protocol-version')).toBe(
      DRIFTING_MCP_PROTOCOL_VERSION,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await transport.close();
  });

  it('parses SSE while rejecting foreign ids and reserved caller headers', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        'data: {"jsonrpc":"2.0","id":"rpc:foreign","result":{}}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const transport = createHttpAgentMcpTransport({
      url: 'https://example.test/mcp',
      fetch: fetchMock,
    });
    await expect(
      transport.request({ method: 'ping', signal: signal() }),
    ).rejects.toThrow('foreign request id');
    expect(() =>
      createHttpAgentMcpTransport({
        url: 'https://example.test/mcp',
        headers: { 'Mcp-Session-Id': 'caller-owned' },
        fetch: fetchMock,
      }),
    ).toThrow('reserved');
  });

  it('rejects insecure non-loopback endpoints before network access', () => {
    expect(() => createHttpAgentMcpTransport({ url: 'http://example.test/mcp' })).toThrow(
      'must use HTTPS',
    );
  });

  it('uses the native HTTP host and propagates cancellation without WebView fetch', async () => {
    const pending = new Promise<never>(() => undefined);
    const platform: McpHttpPlatformApi = {
      request: vi.fn(async (input) => {
        const request = JSON.parse(input.body ?? '{}') as { id: string; method: string };
        if (request.method === 'ping') return pending;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { protocolVersion: DRIFTING_MCP_PROTOCOL_VERSION },
          }),
        };
      }),
      cancel: vi.fn(async () => true),
    };
    const transport = createHttpAgentMcpTransport({
      url: 'http://127.0.0.1:31415/mcp',
      platform,
    });

    await expect(
      transport.request({ method: 'initialize', signal: signal() }),
    ).resolves.toEqual({ protocolVersion: DRIFTING_MCP_PROTOCOL_VERSION });
    const controller = new AbortController();
    const ping = transport.request({ method: 'ping', signal: controller.signal });
    controller.abort('test cancellation');
    await expect(ping).rejects.toMatchObject({ kind: 'aborted' });

    expect(platform.request).toHaveBeenCalledTimes(2);
    expect(platform.cancel).toHaveBeenCalledWith(expect.stringMatching(/^mcp-http:/u));
  });
});
