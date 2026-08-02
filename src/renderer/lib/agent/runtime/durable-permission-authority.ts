import type { AgentExtensionRepository } from '../../../sqlite-repo/agent-extension-repo';
import type {
  DynamicAgentPermissionGrantAuthority,
  RegisteredDynamicAgentTool,
} from './dynamic-tool-runtime';
import type { AgentToolPermissionPolicyRequest } from './types';
import type { AgentPermissionResolutionInput } from '../protocol';

/** SQLite-backed exact-match authority for runtime-discovered tools. */
export function createDurableDynamicPermissionAuthority(
  repository: AgentExtensionRepository,
): DynamicAgentPermissionGrantAuthority {
  const match = (
    request: AgentToolPermissionPolicyRequest,
    descriptor: RegisteredDynamicAgentTool,
  ) => ({
    projectId: descriptor.projectId,
    sessionId: request.sessionId,
    sourceKind: descriptor.sourceKind,
    sourceId: descriptor.sourceId,
    providerToolName: descriptor.providerName,
    remoteToolName: descriptor.remoteName,
    access: descriptor.access,
    argumentsHash: request.argumentsHash,
    toolDefinitionRevision: descriptor.authorityRevision,
    sourceConfigRevision: descriptor.sourceRevision,
  });

  return {
    async findGrant(request, descriptor) {
      if (
        descriptor.projectId !== request.context.route.projectId ||
        descriptor.definitionRevision !== request.toolDefinitionRevision ||
        descriptor.access !== request.access
      ) {
        return null;
      }
      const grant = await repository.findGrant(match(request, descriptor));
      return grant ? { grantId: grant.id, scope: grant.scope } : null;
    },

    async recordGrant(request, resolution, descriptor) {
      assertResolution(request, resolution);
      if (resolution.scope !== 'session' && resolution.scope !== 'project') {
        throw new Error('Only session/project decisions create durable grants');
      }
      const grant = await repository.createGrant({
        ...match(request, descriptor),
        scope: resolution.scope,
        createdAt: new Date().toISOString(),
      });
      return { authorityId: grant.id };
    },
  };
}

function assertResolution(
  request: AgentToolPermissionPolicyRequest,
  resolution: AgentPermissionResolutionInput,
): void {
  if (
    resolution.decision !== 'allow' ||
    resolution.requestId !== request.requestId ||
    resolution.sessionId !== request.sessionId ||
    resolution.turnId !== request.turnId ||
    resolution.callId !== request.callId ||
    resolution.argumentsHash !== request.argumentsHash ||
    resolution.revision !== request.revision
  ) {
    throw new Error('Durable permission resolution does not match its request');
  }
}
