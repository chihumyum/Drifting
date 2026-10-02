import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_PROVIDER_OPTIONS,
  DEFAULT_AGENT_PROVIDER,
  resolveAgentProviderContextProfile,
  setCodexModelCatalog,
} from './agent-provider-contract';
import {
  DRIFTING_AGENT_CONTEXT_PROFILE,
  DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
  resolveDriftingAgentContextProfile,
} from './drifting-agent-product-contract';

afterEach(() => setCodexModelCatalog(null));

describe('Drifting Agent provider context contract', () => {
  it('installs the default model declaration without a separate product target', () => {
    expect(DRIFTING_AGENT_CONTEXT_PROFILE).toBe(
      resolveAgentProviderContextProfile(DEFAULT_AGENT_PROVIDER, undefined),
    );
    for (const provider of AGENT_PROVIDER_OPTIONS) {
      for (const model of provider.models) {
        expect(resolveDriftingAgentContextProfile({ declared: model.context })).toEqual({
          ...model.context,
          source: 'driver',
        });
      }
    }
  });

  it('uses discovered model windows without standard or Max caps', () => {
    for (const contextWindow of [64_000, 256_000, 400_000, 1_050_000, 2_000_000]) {
      setCodexModelCatalog([{
        slug: 'synthetic-model', displayName: 'Synthetic model', contextWindow,
        supportedReasoningEfforts: [], defaultReasoningEffort: null,
        supportsReasoningSummary: false, supportsVerbosity: false,
      }]);
      const declared = resolveAgentProviderContextProfile('openai-codex', 'synthetic-model');
      expect(resolveDriftingAgentContextProfile({ declared })).toEqual({
        ...declared,
        contextWindowTokens: contextWindow,
        source: 'driver',
      });
    }
  });

  it('never enlarges a smaller provider declaration with a DEV override', () => {
    expect(resolveDriftingAgentContextProfile({
      declared: { ...DRIFTING_AGENT_CONTEXT_PROFILE, contextWindowTokens: 64_000 },
      requestedContextWindowTokens: 256_000,
    }).contextWindowTokens).toBe(64_000);
  });

  it('allows explicit smaller DEV fixtures without changing production budgets', () => {
    const declared = { ...DRIFTING_AGENT_CONTEXT_PROFILE, contextWindowTokens: 1_050_000 };
    expect(resolveDriftingAgentContextProfile({
      declared, requestedContextWindowTokens: 16_384,
    }).contextWindowTokens).toBe(16_384);
    expect(resolveDriftingAgentContextProfile({ declared }).contextWindowTokens).toBe(1_050_000);
  });

  it('uses a conservative window for an undeclared custom driver', () => {
    expect(resolveDriftingAgentContextProfile({})).toMatchObject({
      contextWindowTokens: DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
      source: 'conservative_fallback',
    });
  });
});
