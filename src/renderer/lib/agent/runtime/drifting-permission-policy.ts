import {
  getRegisteredTool,
  isCertifiedTool,
} from '../tool-registry';
import type { RegisteredTool } from '../tool-registry.types';
import type {
  AgentToolPermissionPolicy,
  AgentToolPermissionPolicyDecision,
  AgentToolPermissionPolicyRequest,
} from './types';

export interface DriftingAgentPermissionPolicyOptions {
  resolveTool?: (name: string) => RegisteredTool | undefined;
}

/**
 * Product authorization policy derived from the canonical tool registry.
 *
 * Certification decides whether a tool can execute at all. Approval metadata
 * then decides whether a certified call can proceed automatically, land under
 * soft review, or must pause before the dispatcher. A model-provided tool name
 * or risk claim can never expand this policy.
 */
export function createDriftingAgentPermissionPolicy(
  options: DriftingAgentPermissionPolicyOptions = {},
): AgentToolPermissionPolicy {
  const resolveTool = options.resolveTool ?? getRegisteredTool;
  return {
    async decide(
      request: AgentToolPermissionPolicyRequest,
    ): Promise<AgentToolPermissionPolicyDecision> {
      const tool = resolveTool(request.toolName);
      if (
        !tool ||
        !isCertifiedTool(tool) ||
        tool.access !== request.access
      ) {
        return {
          decision: 'deny',
          reason: `Tool "${request.toolName}" is not certified for this Agent runtime.`,
        };
      }
      if (tool.access === 'read') {
        return { decision: 'allow', scope: 'once' };
      }

      if (
        tool.revertStrategy === 'irreversible' ||
        tool.revertStrategy === 'unavailable'
      ) {
        return {
          decision: 'ask',
          reason: `${tool.name} may not have a safe automatic inverse.`,
          allowedScopes: ['once'],
        };
      }
      if (tool.approval === 'confirm_before') {
        return {
          decision: 'ask',
          reason: `${tool.name} requires author approval before execution.`,
          // Broader grants stay closed until a durable session/project grant
          // store exists. Advertising an unimplemented scope would make the
          // permission UI promise authority that the runtime cannot honor.
          allowedScopes: ['once'],
        };
      }
      if (
        tool.approval === 'soft_review' &&
        (tool.revertStrategy === 'exact_inverse' ||
          tool.revertStrategy === 'compensating')
      ) {
        return { decision: 'allow', scope: 'once' };
      }
      if (tool.approval === 'automatic') {
        return { decision: 'allow', scope: 'once' };
      }
      return {
        decision: 'deny',
        reason: `Tool "${tool.name}" has no valid approval policy.`,
      };
    },
  };
}
