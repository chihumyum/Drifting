import { useEffect, useLayoutEffect, useReducer } from 'react';
import { BYOKCredentialsProvider } from '../ai/credentials/byok';
import { ChainCredentialsProvider } from '../ai/credentials/chain';
import { EnvCredentialsProvider } from '../ai/credentials/env';
import type { GeneralAgentAuthStatus } from './protocol';
import { createDriftingAgentProductComposition } from './runtime';
import { installGeneralAgentTransport, type GeneralAgentTransport } from './transport';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useProjectStore } from '../../store/project-store';
import type { AgentRuntimeWriteEffectRepository } from '../../sqlite-repo/agent-runtime-write-effect-repo';
import { useSettingsStore } from '../../store/settings-store';
import type { AgentExtensionManager } from './runtime/agent-extension-manager';
import type { AgentExtensionRepository } from '../../sqlite-repo/agent-extension-repo';

function debugPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function headlessDebugRuntimeOverrides(): {
  contextWindowTokens?: number;
  readResultBudgetCharsCap?: number;
} {
  if (!import.meta.env.DEV || !import.meta.env.VITE_DRIFTING_AGENT_DEBUG_URL) {
    return {};
  }
  const contextWindowTokens = debugPositiveInteger(
    import.meta.env.VITE_DRIFTING_AGENT_DEBUG_CONTEXT_WINDOW_TOKENS,
  );
  const readResultBudgetCharsCap = debugPositiveInteger(
    import.meta.env.VITE_DRIFTING_AGENT_DEBUG_RESULT_BUDGET_CHARS,
  );
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(readResultBudgetCharsCap ? { readResultBudgetCharsCap } : {}),
  };
}

const debugRuntimeOverrides = headlessDebugRuntimeOverrides();

async function readLocalAgentAuthStatus(): Promise<GeneralAgentAuthStatus> {
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
  let connected = false;
  try {
    connected = Boolean(
      await credentials.getApiKey(useSettingsStore.getState().agentProvider),
    );
  } catch {
    connected = false;
  }
  return {
    // Both legacy BYOK labels resolve to the selected provider's local key.
    byokConnected: connected,
    apiKeyConnected: connected,
    hostedAvailable: false,
  };
}

/** Live per-turn limits from Settings; resolved by the transport at turn start. */
function readAgentRuntimeLimits(): { maxModelIterations: number | null } {
  return {
    maxModelIterations: useSettingsStore.getState().agentTurnIterationLimit,
  };
}

export function createDriftingLocalAgentTransport(): GeneralAgentTransport {
  return createDriftingAgentProductComposition({
    authStatus: readLocalAgentAuthStatus,
    allowDangerousOperations: () =>
      useSettingsStore.getState().agentAllowDangerousOperations,
    limits: readAgentRuntimeLimits,
    ...debugRuntimeOverrides,
  }).transport;
}

const driftingProductComposition = createDriftingAgentProductComposition({
  authStatus: readLocalAgentAuthStatus,
  allowDangerousOperations: () =>
    useSettingsStore.getState().agentAllowDangerousOperations,
  limits: readAgentRuntimeLimits,
  ...debugRuntimeOverrides,
});

export function getDriftingAgentExtensionPlatform(): {
  manager: AgentExtensionManager;
  repository: AgentExtensionRepository;
} {
  return {
    manager: driftingProductComposition.extensionManager,
    repository: driftingProductComposition.repositories.extensions,
  };
}

/**
 * Reconcile the rebuildable localStorage editor projection with SQLite review
 * authority. Missing rows, settled rows, and rows from another project cannot
 * remain clickable editor ghosts.
 * A database read failure keeps every batch so recovery fails closed.
 */
export async function reconcileAgentEditReviewCache(
  projectId: string,
  repository: AgentRuntimeWriteEffectRepository =
    driftingProductComposition.repositories.writeEffects,
): Promise<readonly string[]> {
  if (!projectId) return [];
  const state = useAgentEditStore.getState();
  const stale: string[] = [];
  const candidateReviewIds = new Set([
    ...state.reviewOrder,
    ...Object.keys(state.reviewBatches),
    ...Object.values(state.pending).flatMap((entry) =>
      entry.changes.flatMap((change) => change.reviewId ? [change.reviewId] : []),
    ),
  ]);
  try {
    for (const reviewId of candidateReviewIds) {
      const batch = state.reviewBatches[reviewId];
      if (!batch) {
        stale.push(reviewId);
        continue;
      }
      const review = await repository.getReview(reviewId);
      if (!review || review.effectId !== batch.effectId) {
        stale.push(reviewId);
        continue;
      }
      const effect = await repository.getEffect(review.effectId);
      if (
        !effect ||
        effect.projectId !== projectId ||
        effect.id !== batch.effectId ||
        review.sessionId !== effect.sessionId ||
        review.turnId !== effect.turnId ||
        review.toolCallId !== effect.toolCallId ||
        review.status === 'accepted_effect' ||
        review.status === 'reverted'
      ) {
        stale.push(reviewId);
      }
    }
  } catch {
    return [];
  }
  if (stale.length > 0) {
    useAgentEditStore.getState().resolveReviews(stale);
  }
  return stale;
}

/** Canonical editor-review actions. */
export async function acceptDriftingAgentWriteReview(
  reviewId: string,
  decisionNote?: unknown,
) {
  return driftingProductComposition.tools.acceptReview(
    reviewId,
    decisionNote,
  );
}

export async function rejectDriftingAgentWriteReview(
  reviewId: string,
  decisionNote?: unknown,
  signal?: AbortSignal,
) {
  return driftingProductComposition.tools.rejectReview(
    reviewId,
    decisionNote,
    signal,
  );
}

export async function acceptDriftingAgentWriteReviewBlock(
  reviewId: string,
  blockId: string,
  decisionNote?: unknown,
) {
  return driftingProductComposition.tools.acceptReviewBlock(
    reviewId,
    blockId,
    decisionNote,
  );
}

export async function rejectDriftingAgentWriteReviewBlock(
  reviewId: string,
  blockId: string,
  decisionNote?: unknown,
  signal?: AbortSignal,
) {
  return driftingProductComposition.tools.rejectReviewBlock(
    reviewId,
    blockId,
    decisionNote,
    signal,
  );
}

// One product transport per renderer lifetime. React Strict Mode may mount,
// clean up, and remount effects; reusing this instance preserves subscriptions
// and prevents a turn from being attached to a discarded duplicate.
const driftingLocalAgentTransport = driftingProductComposition.transport;

/** Install the provider-neutral local runtime behind the existing chat seam. */
export function useDriftingAgentRuntime(): void {
  const [, refreshCapabilities] = useReducer((value: number) => value + 1, 0);
  const projectId = useProjectStore((state) => state.currentProject?.id ?? '');
  useLayoutEffect(() => {
    const restore = installGeneralAgentTransport(driftingLocalAgentTransport);
    // The facade is intentionally external to React. Re-render the owning
    // layout once so child panels observe the newly installed capability
    // before paint instead of keeping their first unsupported projection.
    refreshCapabilities();
    return restore;
  }, []);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void driftingProductComposition.tools
      .reconcileProjectReviews(projectId, controller.signal)
      .then(() => reconcileAgentEditReviewCache(projectId))
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.warn('[agent] editor review hydration failed closed', error);
      });
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => {
    if (!projectId) {
      void driftingProductComposition.extensionManager.deactivateProject();
      return;
    }
    let active = true;
    void driftingProductComposition.extensionManager.activateProject(projectId).catch((error) => {
      if (!active) return;
      console.warn('[agent] extension platform activation failed closed', error);
    });
    return () => {
      active = false;
      void driftingProductComposition.extensionManager.deactivateProject(projectId);
    };
  }, [projectId]);
}
