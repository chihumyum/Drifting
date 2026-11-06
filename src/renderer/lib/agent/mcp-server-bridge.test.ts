import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerEvent, McpServerGrant, McpServerRequest } from '../../platform/mcp-server-contract';
import { isExternalMcpConversationIdentity } from '../../domain/agent-conversation-source';

const harness = vi.hoisted(() => ({
  listeners: [] as ((event: McpServerEvent) => void)[],
  epochs: [] as string[],
  completed: [] as unknown[],
  sessionIds: [] as string[],
  sessionProjects: [] as string[],
}));

vi.mock('../../platform', () => ({
  platform: {
    mcpServer: {
      attach: async (_projectId: string, onEvent: (event: McpServerEvent) => void) => {
        harness.listeners.push(onEvent);
        return harness.epochs[harness.listeners.length - 1]!;
      },
      detach: async () => undefined,
      complete: async (_epoch: string, _requestId: string, response: unknown) => {
        harness.completed.push(response);
      },
    },
  },
}));
vi.mock('../db', () => ({ getDb: () => ({}) }));
vi.mock('./useDriftingAgentRuntime', () => ({ getDriftingAgentProductComposition: () => ({}) }));
vi.mock('./runtime/external-tool-session', () => ({
  ExternalToolSession: class {
    readonly connectionId: string;
    constructor(options: { sessionId: string; projectId: string; grant: { id: string } }) {
      harness.sessionIds.push(options.sessionId);
      harness.sessionProjects.push(options.projectId);
      this.connectionId = options.grant.id;
    }
    async handle() {
      return { content: [] };
    }
    async close() {}
  },
}));

const { installMcpServerBridge } = await import('./mcp-server-bridge');

const grant: McpServerGrant = {
  id: 'synthetic-connection',
  name: 'Synthetic client',
};

function request(epoch: string, id: number, scope: McpServerGrant = grant): McpServerRequest {
  return {
    type: 'request',
    requestId: `request-${id}`,
    sessionId: 'mcp:native-session',
    epoch,
    grant: scope,
    request: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_chapters' } },
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('MCP server bridge', () => {
  beforeEach(() => {
    harness.listeners.length = 0;
    harness.completed.length = 0;
    harness.sessionIds.length = 0;
    harness.sessionProjects.length = 0;
    harness.epochs = ['a'.repeat(64), 'b'.repeat(64)];
  });

  it('gives a native session that outlives a bridge remount a fresh durable identity', async () => {
    const disposeFirst = await installMcpServerBridge('synthetic-project');
    harness.listeners[0]!(request(harness.epochs[0]!, 1));
    harness.listeners[0]!(request(harness.epochs[0]!, 2));
    await settle();
    disposeFirst();
    // The native connection stays open while the project runtime remounts.
    const disposeSecond = await installMcpServerBridge('synthetic-project');
    harness.listeners[1]!(request(harness.epochs[1]!, 3));
    await settle();
    disposeSecond();

    expect(harness.sessionIds).toHaveLength(2);
    expect(new Set(harness.sessionIds).size).toBe(2);
    for (const sessionId of harness.sessionIds) {
      expect(sessionId.startsWith('mcp:native-session:')).toBe(true);
      expect(isExternalMcpConversationIdentity(`${sessionId}:conversation`)).toBe(true);
    }
    expect(harness.completed).toHaveLength(3);
    expect(harness.completed.every((response) => !(response as { error?: unknown }).error)).toBe(true);
  });

  it('serves a connection in whichever book is open, and keeps a book-limited one to its book', async () => {
    const disposeFirst = await installMcpServerBridge('first-book');
    harness.listeners[0]!(request(harness.epochs[0]!, 1));
    harness.listeners[0]!(request(harness.epochs[0]!, 2, { ...grant, id: 'book', projectId: 'second-book' }));
    await settle();
    disposeFirst();
    const disposeSecond = await installMcpServerBridge('second-book');
    harness.listeners[1]!(request(harness.epochs[1]!, 3));
    await settle();
    disposeSecond();

    expect(harness.sessionProjects).toEqual(['first-book', 'second-book']);
    const refused = (id: number) => Boolean((harness.completed.find((response) =>
      (response as { id?: number }).id === id) as { error?: unknown }).error);
    expect([1, 2, 3].map(refused)).toEqual([false, true, false]);
  });
});
