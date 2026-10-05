import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerEvent, McpServerRequest } from '../../platform/mcp-server-contract';
import { isExternalMcpConversationIdentity } from '../../domain/agent-conversation-source';

const harness = vi.hoisted(() => ({
  listeners: [] as ((event: McpServerEvent) => void)[],
  epochs: [] as string[],
  completed: [] as unknown[],
  sessionIds: [] as string[],
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
    constructor(options: { sessionId: string; grant: { id: string } }) {
      harness.sessionIds.push(options.sessionId);
      this.connectionId = options.grant.id;
    }
    updateGrant() {}
    async handle() {
      return { content: [] };
    }
    async close() {}
  },
}));

const { installMcpServerBridge } = await import('./mcp-server-bridge');

const grant = {
  id: 'synthetic-connection',
  name: 'Synthetic client',
  projectId: 'synthetic-project',
  access: 'read' as const,
  allowDangerous: false,
};

function request(epoch: string, id: number): McpServerRequest {
  return {
    type: 'request',
    requestId: `request-${id}`,
    sessionId: 'mcp:native-session',
    epoch,
    grant,
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
    harness.epochs = ['a'.repeat(64), 'b'.repeat(64)];
  });

  it('gives a native session that outlives a bridge remount a fresh durable identity', async () => {
    const disposeFirst = await installMcpServerBridge(grant.projectId);
    harness.listeners[0]!(request(harness.epochs[0]!, 1));
    harness.listeners[0]!(request(harness.epochs[0]!, 2));
    await settle();
    disposeFirst();
    // The native connection stays open while the project runtime remounts.
    const disposeSecond = await installMcpServerBridge(grant.projectId);
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
});
