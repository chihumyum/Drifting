import type { AgentRuntimePersistenceRepository } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentRuntimePersistenceRepository } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import type { AgentContextSummaryCandidate } from './context-planner';
import {
  AGENT_RUNTIME_CHECKPOINT_CONTEXT_V2_FORMAT,
  AGENT_RUNTIME_CHECKPOINT_CONTEXT_V2_VERSION,
  recoverAgentRuntimeSnapshot,
  type AgentRuntimeCheckpointContextV2,
} from './recovery';
import type {
  AgentRuntimeContextPlanningHookInput,
} from './runtime-context-planning';

/**
 * Load only summaries whose enclosing checkpoint has passed the full recovery
 * verifier. The context planner rechecks source ids/hash against the current
 * canonical rows before any summary can replace history.
 */
export async function loadDurableAgentContextSummaries(
  sessionId: string,
  repository: AgentRuntimePersistenceRepository =
    createAgentRuntimePersistenceRepository(),
): Promise<AgentContextSummaryCandidate[]> {
  if (!sessionId) return [];
  const snapshot = await repository.loadRecoverySnapshot(sessionId);
  if (!snapshot) return [];
  const recovered = await recoverAgentRuntimeSnapshot(snapshot);
  if (!recovered.checkpointId) return [];
  const checkpoint = snapshot.checkpoints.find(
    (candidate) => candidate.id === recovered.checkpointId,
  );
  if (!checkpoint || !isCheckpointContextV2(checkpoint.context)) return [];

  return checkpoint.context.providerEnvelope.plannerCheckpoint.projection.segments.flatMap(
    (segment): AgentContextSummaryCandidate[] =>
      segment.type === 'summary'
        ? [
            {
              summaryId: segment.summaryId,
              sourceIds: [...segment.sourceIds],
              sourceHash: segment.sourceHash,
              content: segment.content,
            },
          ]
        : [],
  );
}

/**
 * Product hook with a one-load-per-turn cache. A new completed turn changes
 * turnId and reloads the latest verified checkpoint; repeated provider
 * iterations do not repeatedly scan recovery state.
 */
export function createDurableAgentContextSummaryHook(
  repository: AgentRuntimePersistenceRepository =
    createAgentRuntimePersistenceRepository(),
): (
  input: AgentRuntimeContextPlanningHookInput,
) => Promise<readonly AgentContextSummaryCandidate[]> {
  const bySession = new Map<
    string,
    { turnId: string; summaries: AgentContextSummaryCandidate[] }
  >();
  return async (input) => {
    const cached = bySession.get(input.sessionId);
    if (cached?.turnId === input.turnId) {
      return cached.summaries.map(cloneSummary);
    }
    const summaries = await loadDurableAgentContextSummaries(
      input.sessionId,
      repository,
    );
    bySession.set(input.sessionId, {
      turnId: input.turnId,
      summaries: summaries.map(cloneSummary),
    });
    return summaries.map(cloneSummary);
  };
}

function isCheckpointContextV2(
  value: unknown,
): value is AgentRuntimeCheckpointContextV2 {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { schemaVersion?: unknown }).schemaVersion ===
        AGENT_RUNTIME_CHECKPOINT_CONTEXT_V2_VERSION &&
      (value as { format?: unknown }).format ===
        AGENT_RUNTIME_CHECKPOINT_CONTEXT_V2_FORMAT &&
      (value as { providerEnvelope?: unknown }).providerEnvelope,
  );
}

function cloneSummary(
  value: AgentContextSummaryCandidate,
): AgentContextSummaryCandidate {
  return {
    summaryId: value.summaryId,
    sourceIds: [...value.sourceIds],
    sourceHash: value.sourceHash,
    content: value.content,
  };
}
