import { describe, expect, it, vi } from 'vitest';

import {
  CompositeAgentToolRuntime,
  DynamicAgentToolRegistry,
  createDynamicAwareAgentPermissionPolicy,
  dynamicAgentToolProviderName,
  type DynamicAgentToolHandlerInput,
} from './dynamic-tool-runtime';
import { registerAgentMcpToolSource } from './mcp-tool-source';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from './types';

const projectA: AgentRuntimeContext = {
  route: { kind: 'chat', projectId: 'project-a' },
};
const projectB: AgentRuntimeContext = {
  route: { kind: 'chat', projectId: 'project-b' },
};

function request(
  name: string,
  context = projectA,
  argumentsValue: Record<string, unknown> = { query: 'rain' },
  definitionRevision?: string,
): AgentToolExecutionRequest {
  return {
    sessionId: 'session-a',
    turnId: 'turn-a',
    callId: 'call-a',
    idempotencyKey: 'session-a:turn-a:call-a',
    name,
    arguments: argumentsValue,
    access: 'read',
    ...(definitionRevision ? { definitionRevision } : {}),
    context,
    signal: new AbortController().signal,
  };
}

function searchTool(
  execute: (
    input: DynamicAgentToolHandlerInput,
  ) => Promise<unknown> = vi.fn(async () => ({ hits: ['rain'] })),
) {
  return {
    remoteName: 'search-web',
    description: 'Search a locally configured source.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    access: 'read' as const,
    approval: 'ask' as const,
    execute,
  };
}

describe('dynamic Agent tool registry', () => {
  it('namespaces tools, isolates projects, validates arguments, and removes only its own generation', async () => {
    const execute = vi.fn(async () => ({ hits: ['rain'] }));
    const registry = new DynamicAgentToolRegistry({
      reservedNames: ['read_node'],
    });
    const first = registry.registerSource({
      sourceId: 'writer research',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool(execute)],
    });
    const name = dynamicAgentToolProviderName(
      'mcp',
      'writer research',
      'search-web',
    );

    expect(first.providerNames).toEqual([name]);
    expect(registry.listDefinitions(projectA).map((tool) => tool.name)).toEqual([
      name,
    ]);
    expect(registry.listDefinitions(projectB)).toEqual([]);
    const revision =
      registry.describe(name, projectA)?.definitionRevision;
    await expect(
      registry.execute(request(name, projectA, {}, revision)),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('/query'),
    });
    await expect(
      registry.execute(request(name, projectA, { query: 'rain' }, revision)),
    ).resolves.toEqual({
      ok: true,
      data: { hits: ['rain'] },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'writer research',
        remoteName: 'search-web',
        arguments: { query: 'rain' },
      }),
    );

    const replacement = registry.registerSource({
      sourceId: 'writer research',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [],
    });
    first.unregister();
    expect(replacement.generation).not.toBe(first.generation);
    expect(registry.listDefinitions(projectA)).toEqual([]);
  });

  it('forbids automatic external writes and asks once through the central policy', async () => {
    const registry = new DynamicAgentToolRegistry();
    expect(() =>
      registry.registerSource({
        sourceId: 'unsafe',
        sourceKind: 'mcp',
        projectId: 'project-a',
        tools: [
          {
            ...searchTool(),
            remoteName: 'delete-everything',
            access: 'write',
            approval: 'automatic',
          },
        ],
      }),
    ).toThrow(/cannot bypass per-call approval/);

    const handle = registry.registerSource({
      sourceId: 'safe',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    const builtIn = {
      decide: vi.fn(async () => ({ decision: 'allow' as const })),
    };
    const policy = createDynamicAwareAgentPermissionPolicy(
      builtIn,
      registry,
    );
    await expect(
      policy.decide({
        requestId: 'permission-a',
        sessionId: 'session-a',
        turnId: 'turn-a',
        callId: 'call-a',
        toolName: handle.providerNames[0]!,
        access: 'read',
        arguments: { query: 'rain' },
        argumentsHash: `sha256:${'a'.repeat(64)}`,
        revision: null,
        toolDefinitionRevision:
          registry.describe(handle.providerNames[0]!, projectA)!
            .definitionRevision,
        allowedScopes: ['once'],
        context: projectA,
      }),
    ).resolves.toEqual({
      decision: 'ask',
      reason: 'MCP source "safe" requests read access.',
      allowedScopes: ['once'],
    });
    expect(builtIn.decide).not.toHaveBeenCalled();
  });

  it('composes with built-ins without allowing external shadowing', async () => {
    const builtIn: AgentToolRuntime = {
      listDefinitions: () => [
        {
          name: 'read_node',
          description: 'read',
          inputSchema: { type: 'object' },
          access: 'read',
          validateInput: (value) => ({ ok: true, value }),
        },
      ],
      execute: async () => ({ ok: true, data: 'built-in' }),
    };
    const registry = new DynamicAgentToolRegistry();
    const handle = registry.registerSource({
      sourceId: 'research',
      sourceKind: 'plugin',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    const composite = new CompositeAgentToolRuntime(builtIn, registry);

    expect(
      composite.listDefinitions(projectA).map((definition) => definition.name),
    ).toEqual(['read_node', handle.providerNames[0]]);
    await expect(
      composite.execute(request('read_node')),
    ).resolves.toEqual({ ok: true, data: 'built-in' });
    await expect(
      composite.execute(
        request(
          handle.providerNames[0]!,
          projectA,
          { query: 'rain' },
          registry.describe(handle.providerNames[0]!, projectA)!
            .definitionRevision,
        ),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('composes multiple built-in runtimes and exposes recovery access', async () => {
    const runtime = (name: string, data: string): AgentToolRuntime => ({
      listDefinitions: () => [
        {
          name,
          description: name,
          inputSchema: { type: 'object' },
          access: 'read',
          validateInput: (value) => ({ ok: true, value }),
        },
      ],
      execute: async () => ({ ok: true, data }),
    });
    const registry = new DynamicAgentToolRegistry();
    const handle = registry.registerSource({
      sourceId: 'research',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    const composite = new CompositeAgentToolRuntime(
      [runtime('first', 'one'), runtime('second', 'two')],
      registry,
    );

    expect(
      composite.listDefinitions(projectA).map((definition) => definition.name),
    ).toEqual(['first', 'second', handle.providerNames[0]]);
    await expect(
      composite.execute(request('second')),
    ).resolves.toEqual({ ok: true, data: 'two' });
    expect(
      registry.resolveAccess(handle.providerNames[0]!, 'project-a'),
    ).toBe('read');
  });

  it('binds built-in execution to the exact definition leased for the turn', async () => {
    let description = 'read v1';
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: 'should not execute',
    }));
    const builtIn: AgentToolRuntime = {
      listDefinitions: () => [
        {
          name: 'read_node',
          description,
          inputSchema: { type: 'object', additionalProperties: false },
          access: 'read',
          validateInput: (value) => ({ ok: true, value }),
        },
      ],
      execute,
    };
    const composite = new CompositeAgentToolRuntime(
      builtIn,
      new DynamicAgentToolRegistry(),
    );
    const leased = composite.listDefinitions(projectA)[0]!;

    description = 'read v2';

    await expect(
      composite.execute(
        request('read_node', projectA, {}, leased.executionRevision),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'Tool "read_node" definition changed before execution',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves only a built-in executable alias owned by the same runtime', () => {
    const builtIn: AgentToolRuntime = {
      listDefinitions: () => [
        {
          name: 'set_entity_body',
          description: 'write',
          inputSchema: { type: 'object' },
          access: 'write',
          validateInput: (value) => ({ ok: true, value }),
        },
      ],
      resolveCanonicalName: (name) =>
        name === 'set_element_body' ? 'set_entity_body' : undefined,
      execute: async () => ({ ok: true, data: null }),
    };
    const composite = new CompositeAgentToolRuntime(
      builtIn,
      new DynamicAgentToolRegistry(),
    );

    expect(
      composite.resolveCanonicalName('set_element_body', projectA),
    ).toBe('set_entity_body');
    expect(composite.resolveCanonicalName('human label', projectA)).toBeUndefined();
  });

  it('forwards one built-in durable selection hint through the composite', async () => {
    const withoutHints: AgentToolRuntime = {
      listDefinitions: () => [],
      execute: async () => ({ ok: false, error: 'unused' }),
    };
    const withHints: AgentToolRuntime = {
      listDefinitions: () => [],
      loadSelectionHints: async () => ({
        longTask: {
          status: 'active',
          scopeKind: 'whole_book_chapters',
          objective: '逐章润色整本小说',
        },
      }),
      execute: async () => ({ ok: false, error: 'unused' }),
    };
    const composite = new CompositeAgentToolRuntime(
      [withoutHints, withHints],
      new DynamicAgentToolRegistry(),
    );

    await expect(
      composite.loadSelectionHints?.({
        sessionId: 'session-a',
        turnId: 'turn-a',
        context: projectA,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      longTask: {
        status: 'active',
        scopeKind: 'whole_book_chapters',
        objective: '逐章润色整本小说',
      },
    });
  });

  it('imports only locally classified MCP tools and forwards the original remote name', async () => {
    const registry = new DynamicAgentToolRegistry();
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'result' }],
    }));
    const handle = await registerAgentMcpToolSource({
      registry,
      serverId: 'research-server',
      projectId: 'project-a',
      signal: new AbortController().signal,
      client: {
        listTools: async () => [
          {
            name: 'lookup',
            description: 'Lookup references.',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
          {
            name: 'mutate',
            description: 'Not locally trusted.',
            inputSchema: { type: 'object' },
          },
        ],
        callTool,
      },
      classify: (tool) =>
        tool.name === 'lookup'
          ? { access: 'read', approval: 'ask' }
          : null,
    });

    expect(handle.providerNames).toHaveLength(1);
    await expect(
      registry.execute(
        request(
          handle.providerNames[0]!,
          projectA,
          { query: 'rain' },
          registry.describe(handle.providerNames[0]!, projectA)!
            .definitionRevision,
        ),
      ),
    ).resolves.toEqual({
      ok: true,
      data: [{ type: 'text', text: 'result' }],
    });
    expect(callTool).toHaveBeenCalledWith({
      name: 'lookup',
      arguments: { query: 'rain' },
      signal: expect.any(AbortSignal),
    });
  });

  it('keys sources by kind and project instead of letting another project replace them', () => {
    const registry = new DynamicAgentToolRegistry();
    const a = registry.registerSource({
      sourceId: 'shared-server-id',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    const b = registry.registerSource({
      sourceId: 'shared-server-id',
      sourceKind: 'mcp',
      projectId: 'project-b',
      tools: [
        {
          ...searchTool(),
          access: 'write',
          approval: 'ask',
        },
      ],
    });
    const plugin = registry.registerSource({
      sourceId: 'shared-server-id',
      sourceKind: 'plugin',
      projectId: 'project-a',
      tools: [searchTool()],
    });

    expect(registry.listDefinitions(projectA).map((tool) => tool.name)).toEqual(
      [a.providerNames[0], plugin.providerNames[0]].sort(),
    );
    expect(registry.listDefinitions(projectB).map((tool) => tool.name)).toEqual([
      b.providerNames[0],
    ]);
    expect(registry.resolveAccess(a.providerNames[0]!, 'project-b')).toBe(
      'write',
    );
    b.unregister();
    expect(registry.listDefinitions(projectA)).toHaveLength(2);
    expect(registry.listDefinitions(projectB)).toEqual([]);
  });

  it('rejects prototype keys and malformed or unsafe schemas fail closed', async () => {
    const registry = new DynamicAgentToolRegistry();
    const handle = registry.registerSource({
      sourceId: 'schema-server',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    const name = handle.providerNames[0]!;
    const revision = registry.describe(name, projectA)!.definitionRevision;

    await expect(
      registry.execute(
        request(name, projectA, {
          query: 'rain',
          constructor: 'smuggled',
        }, revision),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('/constructor'),
    });
    await expect(
      registry.execute(
        request(
          name,
          projectA,
          JSON.parse('{"query":"rain","__proto__":"smuggled"}') as Record<
            string,
            unknown
          >,
          revision,
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('/__proto__'),
    });

    for (const inputSchema of [
      {
        type: 'object',
        properties: { query: { type: {} } },
      },
      {
        type: 'object',
        properties: { query: { type: [] } },
      },
      {
        type: 'object',
        properties: {
          values: { type: 'array', uniqueItems: 'yes' },
        },
      },
      {
        type: 'object',
        properties: {
          query: { type: 'string', pattern: '(a+)+$' },
        },
      },
    ]) {
      expect(() =>
        registry.registerSource({
          sourceId: `invalid-${JSON.stringify(inputSchema).length}`,
          sourceKind: 'mcp',
          projectId: 'project-a',
          tools: [{ ...searchTool(), inputSchema }],
        }),
      ).toThrow(/inputSchema is unsupported/);
    }
  });

  it('binds permission and execution to one source generation', async () => {
    const firstExecute = vi.fn(async () => ({ generation: 1 }));
    const secondExecute = vi.fn(async () => ({ generation: 2 }));
    const registry = new DynamicAgentToolRegistry();
    const first = registry.registerSource({
      sourceId: 'replaceable',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool(firstExecute)],
    });
    const name = first.providerNames[0]!;
    const firstRevision =
      registry.describe(name, projectA)!.definitionRevision;

    registry.registerSource({
      sourceId: 'replaceable',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool(secondExecute)],
    });
    const policy = createDynamicAwareAgentPermissionPolicy(
      { decide: async () => ({ decision: 'allow' as const }) },
      registry,
    );
    await expect(
      policy.decide({
        requestId: 'permission-old',
        sessionId: 'session-a',
        turnId: 'turn-a',
        callId: 'call-a',
        toolName: name,
        access: 'read',
        arguments: { query: 'rain' },
        argumentsHash: `sha256:${'a'.repeat(64)}`,
        revision: null,
        toolDefinitionRevision: firstRevision,
        allowedScopes: ['once'],
        context: projectA,
      }),
    ).resolves.toEqual({
      decision: 'deny',
      reason: 'Dynamic tool definition changed before approval.',
    });
    await expect(
      registry.execute(
        request(name, projectA, { query: 'rain' }, firstRevision),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('definition changed'),
    });
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it('enforces bounded source and project tool counts', () => {
    const registry = new DynamicAgentToolRegistry({
      maxSources: 1,
      maxToolsPerSource: 1,
      maxVisibleToolsPerProject: 1,
    });
    expect(() =>
      registry.registerSource({
        sourceId: 'too-many-tools',
        sourceKind: 'mcp',
        projectId: 'project-a',
        tools: [searchTool(), { ...searchTool(), remoteName: 'second' }],
      }),
    ).toThrow(/exceeds 1 tools/);
    registry.registerSource({
      sourceId: 'one',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    expect(() =>
      registry.registerSource({
        sourceId: 'two',
        sourceKind: 'mcp',
        projectId: 'project-a',
        tools: [searchTool()],
      }),
    ).toThrow(/visible tools|registry exceeds/);
  });

  it('disables a stale MCP generation on failed refresh and hides server errors', async () => {
    const registry = new DynamicAgentToolRegistry();
    registry.registerSource({
      sourceId: 'refreshing-server',
      sourceKind: 'mcp',
      projectId: 'project-a',
      tools: [searchTool()],
    });
    await expect(
      registerAgentMcpToolSource({
        registry,
        serverId: 'refreshing-server',
        projectId: 'project-a',
        signal: new AbortController().signal,
        client: {
          listTools: async () => {
            throw new Error('new server cannot be trusted');
          },
          callTool: async () => ({ content: null }),
        },
        classify: () => ({ access: 'read', approval: 'ask' }),
      }),
    ).rejects.toThrow('new server cannot be trusted');
    expect(registry.listDefinitions(projectA)).toEqual([]);

    const handle = await registerAgentMcpToolSource({
      registry,
      serverId: 'error-server',
      projectId: 'project-a',
      signal: new AbortController().signal,
      client: {
        listTools: async () => [
          {
            name: 'lookup',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
        ],
        callTool: async () => ({
          isError: true,
          content: 'Authorization: Bearer secret-value',
        }),
      },
      classify: () => ({ access: 'read', approval: 'ask' }),
    });
    const name = handle.providerNames[0]!;
    await expect(
      registry.execute(
        request(
          name,
          projectA,
          { query: 'rain' },
          registry.describe(name, projectA)!.definitionRevision,
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      error:
        'MCP tool returned an error; inspect the configured server logs.',
    });
  });
});
