import { describe, expect, it, vi } from 'vitest';

import type {
  AgentPermissionGrant,
  AgentPermissionGrantMatch,
} from '../../../domain/agent-extension';
import type { AgentExtensionRepository } from '../../../sqlite-repo/agent-extension-repo';
import {
  createDynamicAwareAgentPermissionPolicy,
  DynamicAgentToolRegistry,
} from './dynamic-tool-runtime';
import { createDurableDynamicPermissionAuthority } from './durable-permission-authority';
import type { AgentToolPermissionPolicyRequest } from './types';

function memoryRepository(): AgentExtensionRepository & { grants: AgentPermissionGrant[] } {
  const grants: AgentPermissionGrant[] = [];
  return {
    grants,
    listServers: vi.fn(async () => []),
    getServer: vi.fn(async () => null),
    saveServer: vi.fn(async () => {
      throw new Error('not used');
    }),
    deleteServer: vi.fn(async () => false),
    updateServerHealth: vi.fn(async () => undefined),
    async findGrant(match) {
      return grants.find((grant) => grant.status === 'active' && grantMatches(grant, match)) ?? null;
    },
    async createGrant(input) {
      const sessionId = input.scope === 'session' ? input.sessionId : null;
      const existing = grants.find(
        (grant) =>
          grant.status === 'active' &&
          grant.scope === input.scope &&
          grant.sessionId === sessionId &&
          grantMatches(grant, input),
      );
      if (existing) return existing;
      const grant: AgentPermissionGrant = {
        id: `grant-${grants.length + 1}`,
        ...input,
        sessionId,
        status: 'active',
        lastUsedAt: input.createdAt,
        revokedAt: null,
        revokedReason: null,
      };
      grants.push(grant);
      return grant;
    },
    listGrants: vi.fn(async () => grants),
    async revokeGrant(_projectId, grantId, reason) {
      const grant = grants.find((item) => item.id === grantId && item.status === 'active');
      if (!grant) return false;
      grant.status = 'revoked';
      grant.revokedAt = '2026-08-02T00:10:00.000Z';
      grant.revokedReason = reason;
      return true;
    },
    revokeSourceGrants: vi.fn(async () => 0),
  };
}

function register(
  registry: DynamicAgentToolRegistry,
  sourceRevision: string,
  schema: object = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
) {
  return registry.registerSource({
    sourceId: 'research',
    sourceKind: 'mcp',
    projectId: 'project-a',
    sourceRevision,
    tools: [
      {
        remoteName: 'search',
        description: 'Search research notes.',
        inputSchema: schema,
        access: 'read',
        approval: 'ask',
        execute: async () => ({ hits: [] }),
      },
    ],
  });
}

function permissionRequest(
  registry: DynamicAgentToolRegistry,
  name: string,
  overrides: Partial<AgentToolPermissionPolicyRequest> = {},
): AgentToolPermissionPolicyRequest {
  return {
    requestId: 'permission-1',
    sessionId: 'session-a',
    turnId: 'turn-a',
    callId: 'call-a',
    toolName: name,
    access: 'read',
    arguments: { query: 'rain' },
    argumentsHash: `sha256:${'a'.repeat(64)}`,
    revision: null,
    toolDefinitionRevision: registry.describe(name, {
      route: { kind: 'chat', projectId: 'project-a' },
    })?.definitionRevision,
    allowedScopes: ['once'],
    context: { route: { kind: 'chat', projectId: 'project-a' } },
    ...overrides,
  };
}

describe('durable dynamic permission authority', () => {
  it('survives an identical source restart but fails closed on every authority boundary drift', async () => {
    const repository = memoryRepository();
    const firstRegistry = new DynamicAgentToolRegistry();
    const firstHandle = register(firstRegistry, `sha256:${'c'.repeat(64)}`);
    const name = firstHandle.providerNames[0]!;
    const firstPolicy = createDynamicAwareAgentPermissionPolicy(
      { decide: () => ({ decision: 'allow' as const }) },
      firstRegistry,
      createDurableDynamicPermissionAuthority(repository),
    );
    const firstRequest = permissionRequest(firstRegistry, name);
    await expect(firstPolicy.decide(firstRequest)).resolves.toMatchObject({
      decision: 'ask',
      allowedScopes: ['once', 'session', 'project'],
    });
    const resolution = {
      requestId: firstRequest.requestId,
      sessionId: firstRequest.sessionId,
      turnId: firstRequest.turnId,
      callId: firstRequest.callId,
      argumentsHash: firstRequest.argumentsHash,
      revision: firstRequest.revision,
      decision: 'allow' as const,
      scope: 'session' as const,
    };
    await expect(firstPolicy.recordResolution?.(firstRequest, resolution)).resolves.toEqual({
      authorityId: 'grant-1',
    });

    const restarted = new DynamicAgentToolRegistry();
    const dummy = register(restarted, `sha256:${'d'.repeat(64)}`);
    dummy.unregister();
    const restartedHandle = register(restarted, `sha256:${'c'.repeat(64)}`);
    expect(restartedHandle.providerNames[0]).toBe(name);
    expect(
      restarted.describe(name, firstRequest.context)?.definitionRevision,
    ).not.toBe(firstRequest.toolDefinitionRevision);
    const restartedPolicy = createDynamicAwareAgentPermissionPolicy(
      { decide: () => ({ decision: 'allow' as const }) },
      restarted,
      createDurableDynamicPermissionAuthority(repository),
    );
    await expect(
      restartedPolicy.decide(permissionRequest(restarted, name)),
    ).resolves.toEqual({ decision: 'allow', scope: 'session', grantId: 'grant-1' });

    await expect(
      restartedPolicy.decide(
        permissionRequest(restarted, name, {
          sessionId: 'session-b',
          argumentsHash: `sha256:${'b'.repeat(64)}`,
        }),
      ),
    ).resolves.toMatchObject({ decision: 'ask' });

    const configDrift = new DynamicAgentToolRegistry();
    register(configDrift, `sha256:${'e'.repeat(64)}`);
    const configPolicy = createDynamicAwareAgentPermissionPolicy(
      { decide: () => ({ decision: 'allow' as const }) },
      configDrift,
      createDurableDynamicPermissionAuthority(repository),
    );
    await expect(
      configPolicy.decide(permissionRequest(configDrift, name)),
    ).resolves.toMatchObject({ decision: 'ask' });

    const schemaDrift = new DynamicAgentToolRegistry();
    register(schemaDrift, `sha256:${'c'.repeat(64)}`, {
      type: 'object',
      properties: { term: { type: 'string' } },
      required: ['term'],
      additionalProperties: false,
    });
    const schemaPolicy = createDynamicAwareAgentPermissionPolicy(
      { decide: () => ({ decision: 'allow' as const }) },
      schemaDrift,
      createDurableDynamicPermissionAuthority(repository),
    );
    await expect(
      schemaPolicy.decide(permissionRequest(schemaDrift, name)),
    ).resolves.toMatchObject({ decision: 'ask' });

    await repository.revokeGrant('project-a', 'grant-1', 'author revoked');
    await expect(
      restartedPolicy.decide(permissionRequest(restarted, name)),
    ).resolves.toMatchObject({ decision: 'ask' });
  });
});

function grantMatches(grant: AgentPermissionGrant, match: AgentPermissionGrantMatch): boolean {
  return (
    grant.projectId === match.projectId &&
    (grant.scope === 'project' || grant.sessionId === match.sessionId) &&
    grant.sourceKind === match.sourceKind &&
    grant.sourceId === match.sourceId &&
    grant.providerToolName === match.providerToolName &&
    grant.remoteToolName === match.remoteToolName &&
    grant.access === match.access &&
    grant.argumentsHash === match.argumentsHash &&
    grant.toolDefinitionRevision === match.toolDefinitionRevision &&
    grant.sourceConfigRevision === match.sourceConfigRevision
  );
}
