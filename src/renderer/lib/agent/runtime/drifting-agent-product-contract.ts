import type { AgentModelContextProfile } from './types';
import { DEFAULT_AGENT_PROVIDER, resolveAgentProviderContextProfile } from './agent-provider-contract';

export const DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS = 32_768 as const;

/** The default router advertises its default model's declaration, not a product cap. */
export const DRIFTING_AGENT_CONTEXT_PROFILE = resolveAgentProviderContextProfile(
  DEFAULT_AGENT_PROVIDER,
  undefined,
);

export interface ResolvedDriftingAgentContextProfile extends AgentModelContextProfile {
  source: 'driver' | 'explicit_override' | 'conservative_fallback';
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Use the model's entire declared window. Only an explicit DEV/test override
 * may reduce it; an undeclared custom driver receives a conservative fallback.
 */
export function resolveDriftingAgentContextProfile(input: {
  declared?: AgentModelContextProfile;
  /** DEV/test override only; production follows the model declaration. */
  requestedContextWindowTokens?: number;
}): ResolvedDriftingAgentContextProfile {
  const requested =
    input.requestedContextWindowTokens === undefined
      ? undefined
      : positive(input.requestedContextWindowTokens, 'requestedContextWindowTokens');
  const declared = input.declared;
  if (declared) {
    const declaredWindow = positive(declared.contextWindowTokens, 'declared.contextWindowTokens');
    return {
      id:
        requested !== undefined && requested < declaredWindow
          ? `${declared.id}:capped-${requested}`
          : declared.id,
      contextWindowTokens: requested === undefined
        ? declaredWindow : Math.min(requested, declaredWindow),
      maxOutputTokens: declared.maxOutputTokens === null
        ? null : positive(declared.maxOutputTokens, 'declared.maxOutputTokens'),
      providerOverheadTokens: positive(
        declared.providerOverheadTokens,
        'declared.providerOverheadTokens',
      ),
      perToolOverheadTokens: positive(
        declared.perToolOverheadTokens,
        'declared.perToolOverheadTokens',
      ),
      source: 'driver',
    };
  }
  if (requested !== undefined) {
    return {
      ...DRIFTING_AGENT_CONTEXT_PROFILE,
      id: `explicit-context-window:${requested}`,
      contextWindowTokens: requested,
      source: 'explicit_override',
    };
  }
  return {
    ...DRIFTING_AGENT_CONTEXT_PROFILE,
    id: 'undeclared-provider-conservative-v1',
    contextWindowTokens: DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
    source: 'conservative_fallback',
  };
}
