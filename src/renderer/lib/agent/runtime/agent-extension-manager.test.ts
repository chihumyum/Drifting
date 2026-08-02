import { describe, expect, it, vi } from 'vitest';

import type {
  AgentMcpServerConfig,
  AgentPermissionGrant,
} from '../../../domain/agent-extension';
import type { McpStdioPlatformApi } from '../../../platform';
import type { AgentExtensionRepository } from '../../../sqlite-repo/agent-extension-repo';
import { AgentExtensionManager } from './agent-extension-manager';
import {
  DynamicAgentToolRegistry,
  dynamicAgentToolProviderName,
} from './dynamic-tool-runtime';
import type { AgentRuntimeContext } from './types';

const project: AgentRuntimeContext = {
  route: { kind: 'chat', projectId: 'project-a' },
};

function server(
  id: string,
  overrides: Partial<AgentMcpServerConfig> = {},
): AgentMcpServerConfig {
  return {
    id,
    projectId: 'project-a',
    name: id,
    transport: 'stdio',
    enabled: true,
    command: '/usr/bin/node',
    args: ['/tmp/server.mjs'],
    cwd: '/tmp',
    publicEnv: {},
    secretEnv: {},
    url: null,
    publicHeaders: {},
    secretHeaders: {},
    toolPolicy: {
      search: { access: 'read', approval: 'automatic' },
    },
    configRevision: `sha256:${id.padEnd(64, '0').slice(0, 64)}`,
    healthStatus: 'connecting',
    healthMessage: '',
    serverInfo: {},
    discoveredTools: [],
    lastCheckedAt: null,
    lastConnectedAt: null,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function repositoryFixture(initial: AgentMcpServerConfig[]): {
  repository: AgentExtensionRepository;
  servers: AgentMcpServerConfig[];
  health: Array<{ serverId: string; status: string; message?: string }>;
} {
  const state = {
    servers: [...initial],
    health: [] as Array<{ serverId: string; status: string; message?: string }>,
  };
  const repository: AgentExtensionRepository = {
    listServers: vi.fn(async (projectId) =>
      state.servers.filter((item) => item.projectId === projectId),
    ),
    getServer: vi.fn(async (projectId, serverId) =>
      state.servers.find((item) => item.projectId === projectId && item.id === serverId) ?? null,
    ),
    saveServer: vi.fn(async () => {
      throw new Error('not used');
    }),
    deleteServer: vi.fn(async () => false),
    updateServerHealth: vi.fn(async (input) => {
      state.health.push({
        serverId: input.serverId,
        status: input.status,
        ...(input.message ? { message: input.message } : {}),
      });
    }),
    findGrant: vi.fn(async () => null),
    createGrant: vi.fn(async () => {
      throw new Error('not used');
    }),
    listGrants: vi.fn(async () => [] as AgentPermissionGrant[]),
    revokeGrant: vi.fn(async () => false),
    revokeSourceGrants: vi.fn(async () => 0),
  };
  return { repository, servers: state.servers, health: state.health };
}

function stdioFixture(options: { badCommand?: string; failInitializeCount?: number } = {}): {
  platform: McpStdioPlatformApi;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
  const commands = new Map<string, string>();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let remainingInitializeFailures = options.failInitializeCount ?? 0;
  return {
    calls,
    platform: {
      start: vi.fn(async (input) => {
        commands.set(input.processId, input.command);
        return { processId: input.processId, pid: commands.size + 100 };
      }),
      request: vi.fn(async (input) => {
        const request = JSON.parse(input.message) as {
          id: string;
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (
          request.method === 'initialize' &&
          (commands.get(input.processId) === options.badCommand || remainingInitializeFailures-- > 0)
        ) {
          return '{malformed';
        }
        let result: unknown = {};
        if (request.method === 'initialize') {
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          };
        } else if (request.method === 'tools/list') {
          result = {
            tools: [
              {
                name: 'search',
                description: 'Search the fixture.',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query'],
                  additionalProperties: false,
                },
              },
            ],
          };
        } else if (request.method === 'tools/call') {
          calls.push({
            name: request.params?.name ?? '',
            arguments: request.params?.arguments ?? {},
          });
          result = { structuredContent: { hits: ['rain'] } };
        }
        return JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
      }),
      notify: vi.fn(async () => undefined),
      stop: vi.fn(async (processId) => commands.delete(processId)),
      status: vi.fn(async (processId) => ({
        processId,
        running: commands.has(processId),
        pid: commands.has(processId) ? 101 : null,
        configRevision: null,
        fatalError: null,
        stderrLines: [],
      })),
    },
  };
}

describe('Agent extension manager', () => {
  it('discovers, registers, executes and removes one project-scoped MCP generation', async () => {
    const registry = new DynamicAgentToolRegistry();
    const repo = repositoryFixture([server('research')]);
    const stdio = stdioFixture();
    const manager = new AgentExtensionManager({
      repository: repo.repository,
      registry,
      stdioPlatform: stdio.platform,
      readSecret: async () => null,
      retryDelaysMs: [],
      createProcessId: () => 'mcp:fixture:1',
    });

    await manager.activateProject('project-a');
    const name = dynamicAgentToolProviderName('mcp', 'research', 'search');
    const definition = registry.listDefinitions(project).find((item) => item.name === name);
    expect(definition?.access).toBe('read');
    expect(manager.getSnapshot()).toMatchObject([
      { serverId: 'research', status: 'healthy', message: '1 tools available' },
    ]);
    const result = await registry.execute({
      sessionId: 'session-a',
      turnId: 'turn-a',
      callId: 'call-a',
      idempotencyKey: 'session-a:turn-a:call-a',
      name,
      arguments: { query: 'rain' },
      access: 'read',
      definitionRevision: definition?.executionRevision,
      context: project,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: true,
      data: { structuredContent: { hits: ['rain'] } },
    });
    expect(stdio.calls).toEqual([{ name: 'search', arguments: { query: 'rain' } }]);

    await manager.deactivateProject('project-a');
    expect(registry.listDefinitions(project)).toEqual([]);
    expect(stdio.platform.stop).toHaveBeenCalledTimes(1);
  });

  it('isolates a malformed server so another server still becomes healthy', async () => {
    const registry = new DynamicAgentToolRegistry();
    const repo = repositoryFixture([
      server('broken', { command: '/bad' }),
      server('healthy', { command: '/good' }),
    ]);
    const stdio = stdioFixture({ badCommand: '/bad' });
    let process = 0;
    const manager = new AgentExtensionManager({
      repository: repo.repository,
      registry,
      stdioPlatform: stdio.platform,
      readSecret: async () => null,
      retryDelaysMs: [],
      createProcessId: () => `mcp:fixture:${++process}`,
    });

    await manager.activateProject('project-a');
    expect(manager.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'broken', status: 'failed' }),
        expect.objectContaining({ serverId: 'healthy', status: 'healthy' }),
      ]),
    );
    expect(
      registry.listDefinitions(project).map((definition) => definition.name),
    ).toContain(dynamicAgentToolProviderName('mcp', 'healthy', 'search'));
    expect(
      registry.listDefinitions(project).map((definition) => definition.name),
    ).not.toContain(dynamicAgentToolProviderName('mcp', 'broken', 'search'));
  });

  it('fails closed when a referenced secret is missing and never persists its name or value', async () => {
    const registry = new DynamicAgentToolRegistry();
    const repo = repositoryFixture([
      server('secret', { secretEnv: { TOKEN: 'keychain:mcp:secret' } }),
    ]);
    const stdio = stdioFixture();
    const manager = new AgentExtensionManager({
      repository: repo.repository,
      registry,
      stdioPlatform: stdio.platform,
      readSecret: async () => null,
      retryDelaysMs: [],
    });

    await manager.activateProject('project-a');
    expect(manager.getSnapshot()).toMatchObject([
      { serverId: 'secret', status: 'failed', message: 'Connection or discovery failed' },
    ]);
    expect(JSON.stringify(repo.health)).not.toContain('TOKEN');
    expect(JSON.stringify(repo.health)).not.toContain('keychain:mcp:secret');
    expect(stdio.platform.start).not.toHaveBeenCalled();
  });

  it('retries only the handshake with a fresh process generation and never replays a tool call', async () => {
    const registry = new DynamicAgentToolRegistry();
    const repo = repositoryFixture([server('retry')]);
    const stdio = stdioFixture({ failInitializeCount: 1 });
    let process = 0;
    const manager = new AgentExtensionManager({
      repository: repo.repository,
      registry,
      stdioPlatform: stdio.platform,
      readSecret: async () => null,
      retryDelaysMs: [1],
      wait: async () => undefined,
      createProcessId: () => `mcp:retry:${++process}`,
    });

    await manager.activateProject('project-a');
    expect(stdio.platform.start).toHaveBeenCalledTimes(2);
    expect(stdio.platform.stop).toHaveBeenCalledTimes(1);
    expect(stdio.calls).toEqual([]);
    expect(manager.getSnapshot()).toMatchObject([
      { serverId: 'retry', status: 'healthy', message: '1 tools available' },
    ]);
  });

  it('cancels a stale handshake before registration when the project deactivates', async () => {
    const registry = new DynamicAgentToolRegistry();
    const repo = repositoryFixture([server('slow')]);
    const stdio = stdioFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(stdio.platform.request).mockImplementation(async (input) => {
      const request = JSON.parse(input.message) as { id: string; method: string };
      if (request.method === 'initialize') await blocked;
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'slow', version: '1' },
        },
      });
    });
    const manager = new AgentExtensionManager({
      repository: repo.repository,
      registry,
      stdioPlatform: stdio.platform,
      readSecret: async () => null,
      retryDelaysMs: [],
    });

    const activation = manager.activateProject('project-a');
    await vi.waitFor(() => expect(stdio.platform.request).toHaveBeenCalled());
    const deactivation = manager.deactivateProject('project-a');
    release();
    await Promise.all([activation, deactivation]);

    expect(registry.listDefinitions(project)).toEqual([]);
    expect(manager.getSnapshot()).toEqual([]);
    expect(stdio.platform.stop).toHaveBeenCalledTimes(1);
  });
});
