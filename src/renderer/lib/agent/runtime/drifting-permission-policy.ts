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
 * then decides whether a certified call can proceed automatically or must
 * pause before the dispatcher. A model-provided tool name
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

      // The provider sees a small filesystem-like facade, but author approval
      // follows the domain operation behind the path. Creating or relabelling
      // a curated entity relation is graph authorship and must pause before it
      // mutates, just like deleting the relation through delete_file.
      if (isWorkspaceGuardedGraphMutation(request)) {
        return {
          decision: 'ask',
          reason: 'Changing an authored story-graph relationship requires author approval before execution.',
          allowedScopes: ['once'],
        };
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
      if (tool.approval === 'review_after') {
        if (
          tool.revertStrategy !== 'exact_inverse' &&
          tool.revertStrategy !== 'compensating'
        ) {
          return {
            decision: 'deny',
            reason: `Tool "${tool.name}" has no valid editor-review policy.`,
          };
        }
        // The mutation is allowed now. Its exact inverse and author-facing diff
        // are settled after the write inside the target editor, never in chat.
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

function isWorkspaceGuardedGraphMutation(
  request: AgentToolPermissionPolicyRequest,
): boolean {
  if (request.toolName !== 'write_file' && request.toolName !== 'edit_file') {
    return false;
  }
  const path = request.arguments.path;
  if (typeof path !== 'string') return false;
  const normalized = `/${path.trim()}`.replace(/\/{2,}/g, '/').replace(/\/$/u, '');
  return (
    normalized === '/relations' ||
    normalized.startsWith('/relations/') ||
    /^\/storylines\/[^/]+\/chapters\.json$/u.test(normalized)
  );
}
