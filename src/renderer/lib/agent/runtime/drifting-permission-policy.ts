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
  /**
   * Author-controlled override for destructive pre-execution prompts. This
   * never bypasses certification, schema validation, freshness or write
   * receipts; it only turns an otherwise valid confirmation into allow-once.
   */
  allowDangerousOperations?: () => boolean;
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
      const allowDangerousOperations = options.allowDangerousOperations?.() === true;

      if (
        tool.revertStrategy === 'irreversible' ||
        tool.revertStrategy === 'unavailable'
      ) {
        if (allowDangerousOperations) {
          return { decision: 'allow', scope: 'once' };
        }
        return {
          decision: 'ask',
          reason: `${tool.name} may not have a safe automatic inverse.`,
          allowedScopes: ['once'],
        };
      }
      if (tool.approval === 'confirm_before') {
        if (allowDangerousOperations) {
          return { decision: 'allow', scope: 'once' };
        }
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
