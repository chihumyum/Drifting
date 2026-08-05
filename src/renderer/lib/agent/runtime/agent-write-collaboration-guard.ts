/**
 * Bounded same-target conflict memory for one renderer runtime.
 *
 * Yjs and the durable write CAS prevent data corruption, but a model can still
 * react to every stale result by rereading and trying forever while another
 * conversation keeps editing the same authored object. This guard allows one
 * reconciliation attempt, then blocks that session/turn/target for the rest of
 * the turn. Independent targets and sibling sessions remain unaffected.
 */

import { MAX_AGENT_TARGET_CONFLICTS_PER_TURN } from './agent-concurrency-contract';
import {
  describeAgentWriteConflictAttribution,
  UNKNOWN_AGENT_WRITE_CONFLICT_ATTRIBUTION,
  type AgentWriteConflictAttribution,
} from './agent-write-conflict-attribution';

export { MAX_AGENT_TARGET_CONFLICTS_PER_TURN } from './agent-concurrency-contract';

export interface AgentWriteCollaborationTarget {
  sessionId: string;
  turnId: string;
  entityKind: string;
  entityId: string;
}

export class AgentWriteCollaborationConflictError extends Error {
  readonly code = 'AGENT_COLLABORATION_CONFLICT';

  constructor(
    readonly target: AgentWriteCollaborationTarget,
    readonly attribution: AgentWriteConflictAttribution,
  ) {
    super(
      `${describeAgentWriteConflictAttribution(attribution)} Read the current authored object and reconcile only the still-needed part of the request.`,
    );
    this.name = 'AgentWriteCollaborationConflictError';
  }
}

export class AgentWriteCollaborationConflictLimitError extends Error {
  readonly code = 'AGENT_COLLABORATION_CONFLICT_LIMIT';

  constructor(
    readonly target: AgentWriteCollaborationTarget,
    readonly attribution: AgentWriteConflictAttribution,
  ) {
    super(
      `AGENT_COLLABORATION_CONFLICT_LIMIT: ${describeAgentWriteConflictAttribution(attribution)} This target changed twice while this turn was revising it. Do not write it again in this turn; continue independent work and report the coordination conflict.`,
    );
    this.name = 'AgentWriteCollaborationConflictLimitError';
  }
}

export class AgentWriteCollaborationGuard {
  private readonly conflicts = new Map<
    string,
    { count: number; attribution: AgentWriteConflictAttribution }
  >();

  constructor(
    private readonly conflictLimit = MAX_AGENT_TARGET_CONFLICTS_PER_TURN,
    private readonly maxTrackedTargets = 512,
  ) {
    if (!Number.isSafeInteger(conflictLimit) || conflictLimit < 1) {
      throw new Error('conflictLimit must be a positive integer');
    }
    if (!Number.isSafeInteger(maxTrackedTargets) || maxTrackedTargets < 1) {
      throw new Error('maxTrackedTargets must be a positive integer');
    }
  }

  assertAllowed(target: AgentWriteCollaborationTarget): void {
    const conflict = this.conflicts.get(targetKey(target));
    if ((conflict?.count ?? 0) >= this.conflictLimit) {
      throw new AgentWriteCollaborationConflictLimitError(
        target,
        conflict?.attribution ?? UNKNOWN_AGENT_WRITE_CONFLICT_ATTRIBUTION,
      );
    }
  }

  recordConflict(
    target: AgentWriteCollaborationTarget,
    attribution: AgentWriteConflictAttribution = UNKNOWN_AGENT_WRITE_CONFLICT_ATTRIBUTION,
  ): number {
    const key = targetKey(target);
    const count = (this.conflicts.get(key)?.count ?? 0) + 1;
    this.conflicts.delete(key);
    this.conflicts.set(key, { count, attribution });
    this.trim();
    return count;
  }

  recordSuccess(target: AgentWriteCollaborationTarget): void {
    this.conflicts.delete(targetKey(target));
  }

  private trim(): void {
    while (this.conflicts.size > this.maxTrackedTargets) {
      const oldest = this.conflicts.keys().next().value as string | undefined;
      if (!oldest) return;
      this.conflicts.delete(oldest);
    }
  }
}

function targetKey(target: AgentWriteCollaborationTarget): string {
  return [target.sessionId, target.turnId, target.entityKind, target.entityId].join('\u0000');
}
