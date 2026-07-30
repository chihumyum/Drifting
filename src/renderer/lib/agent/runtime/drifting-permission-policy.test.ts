import { describe, expect, it } from 'vitest';
import type { RegisteredTool } from '../tool-registry.types';
import { createDriftingAgentPermissionPolicy } from './drifting-permission-policy';
import type { AgentToolPermissionPolicyRequest } from './types';

function tool(
  overrides: Partial<RegisteredTool> = {},
): RegisteredTool {
  return {
    name: 'write_tool',
    version: 1,
    description: 'test',
    parametersSchema: { type: 'object' } as never,
    scope: 'general',
    access: 'write',
    risk: 'medium',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    reversible: true,
    resultBudgetChars: 1_000,
    certification: 'write-certified',
    certificationNote: 'test',
    aliases: [],
    handlerAliases: [],
    ...overrides,
  };
}

function request(
  overrides: Partial<AgentToolPermissionPolicyRequest> = {},
): AgentToolPermissionPolicyRequest {
  return {
    requestId: 'permission-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    toolName: 'write_tool',
    access: 'write',
    arguments: { node: 'A' },
    argumentsHash: `sha256:${'a'.repeat(64)}`,
    revision: 'revision-1',
    allowedScopes: ['once', 'session', 'project'],
    context: { route: { kind: 'test', projectId: 'project-1' } },
    ...overrides,
  };
}

describe('Drifting Agent permission policy', () => {
  it('allows certified exact soft-review writes', async () => {
    const policy = createDriftingAgentPermissionPolicy({
      resolveTool: () => tool(),
    });
    await expect(policy.decide(request())).resolves.toEqual({
      decision: 'allow',
      scope: 'once',
    });
  });

  it('asks before confirm-before writes and exposes only implemented once grants', async () => {
    const policy = createDriftingAgentPermissionPolicy({
      resolveTool: () =>
        tool({
          approval: 'confirm_before',
          risk: 'critical',
        }),
    });
    await expect(policy.decide(request())).resolves.toMatchObject({
      decision: 'ask',
      allowedScopes: ['once'],
    });

    const nonCritical = createDriftingAgentPermissionPolicy({
      resolveTool: () =>
        tool({
          approval: 'confirm_before',
          risk: 'medium',
        }),
    });
    await expect(nonCritical.decide(request())).resolves.toMatchObject({
      decision: 'ask',
      allowedScopes: ['once'],
    });
  });

  it('asks before irreversible writes even if registry approval drifts', async () => {
    const policy = createDriftingAgentPermissionPolicy({
      resolveTool: () =>
        tool({
          approval: 'automatic',
          revertStrategy: 'irreversible',
          reversible: false,
        }),
    });
    await expect(policy.decide(request())).resolves.toMatchObject({
      decision: 'ask',
      allowedScopes: ['once'],
    });
  });

  it('denies unknown, uncertified, and access-mismatched tools', async () => {
    const unknown = createDriftingAgentPermissionPolicy({
      resolveTool: () => undefined,
    });
    await expect(unknown.decide(request())).resolves.toMatchObject({
      decision: 'deny',
    });

    const unavailable = createDriftingAgentPermissionPolicy({
      resolveTool: () => tool({ certification: 'unavailable' }),
    });
    await expect(unavailable.decide(request())).resolves.toMatchObject({
      decision: 'deny',
    });

    const mismatched = createDriftingAgentPermissionPolicy({
      resolveTool: () =>
        tool({
          access: 'read',
          approval: 'automatic',
          risk: 'none',
          effect: 'none',
          concurrency: 'parallel',
          retry: 'safe',
          revertStrategy: 'not_applicable',
        }),
    });
    await expect(mismatched.decide(request())).resolves.toMatchObject({
      decision: 'deny',
    });
  });
});
