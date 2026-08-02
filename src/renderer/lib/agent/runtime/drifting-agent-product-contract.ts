import type { AgentModelContextProfile } from './types';

/** Pure product constants consumed by runtime and capability tooling. */
export const DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS = 200_000 as const;
export const DRIFTING_AGENT_MAX_CONTEXT_WINDOW_TOKENS = 1_000_000 as const;
export const DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS = 32_768 as const;

/**
 * Current General Agent provider contract. Keep this object in lockstep with
 * the concrete default driver; alternate drivers must declare their own
 * profile instead of inheriting this one by model-name guesswork.
 */
export const DRIFTING_AGENT_CONTEXT_PROFILE = Object.freeze({
  id: 'deepseek-v4-flash:drifting-context-v1',
  contextWindowTokens: DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: 8_192,
  providerOverheadTokens: 512,
  perToolOverheadTokens: 8,
}) satisfies Readonly<AgentModelContextProfile>;

export interface ResolvedDriftingAgentContextProfile extends AgentModelContextProfile {
  source: 'driver' | 'explicit_override' | 'conservative_fallback';
}

export type DriftingAgentContextMode = 'standard' | 'max';

export function requestedDriftingAgentContextWindowTokens(
  mode: DriftingAgentContextMode | undefined,
): number {
  return mode === 'max'
    ? DRIFTING_AGENT_MAX_CONTEXT_WINDOW_TOKENS
    : DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Resolve the exact budget installed into the planner. Product intent may cap
 * a driver's declared window, but can never enlarge it. An unknown custom
 * driver receives 32k unless a DEV/test caller explicitly supplies a window.
 */
export function resolveDriftingAgentContextProfile(input: {
  declared?: AgentModelContextProfile;
  requestedContextWindowTokens?: number;
}): ResolvedDriftingAgentContextProfile {
  const requested =
    input.requestedContextWindowTokens === undefined
      ? DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS
      : positive(input.requestedContextWindowTokens, 'requestedContextWindowTokens');
  const declared = input.declared;
  if (declared) {
    const declaredWindow = positive(declared.contextWindowTokens, 'declared.contextWindowTokens');
    return {
      id:
        requested < declaredWindow
          ? `${declared.id}:capped-${requested}`
          : declared.id,
      contextWindowTokens: Math.min(requested, declaredWindow),
      maxOutputTokens: positive(declared.maxOutputTokens, 'declared.maxOutputTokens'),
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
  if (input.requestedContextWindowTokens !== undefined) {
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
