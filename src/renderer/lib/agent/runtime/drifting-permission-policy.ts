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
 * Certification decides whether a tool can execute at all. Every certified
 * write then proceeds: since 2026-11-06 the author has approved them all in
 * advance, so a deletion, a destructive set replacement or a write without a
 * safe automatic inverse no longer pauses for a confirmation. Schema
 * validation, project isolation, freshness, receipts and guarded inverses
 * still apply where the write executes. A model-provided tool name or risk
 * claim can never expand this policy.
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
      if (tool.approval === 'automatic' || tool.approval === 'confirm_before') {
        return { decision: 'allow', scope: 'once' };
      }
      return {
        decision: 'deny',
        reason: `Tool "${tool.name}" has no valid approval policy.`,
      };
    },
  };
}
