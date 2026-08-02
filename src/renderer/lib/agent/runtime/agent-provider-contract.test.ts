import { describe, expect, it } from 'vitest';

import {
  AGENT_PROVIDER_OPTIONS,
  DEFAULT_AGENT_PROVIDER,
  normalizeAgentProvider,
  normalizeAgentProviderModel,
  resolveAgentProviderContextProfile,
} from './agent-provider-contract';

describe('General Agent provider contract', () => {
  it('keeps provider/model identifiers unique with bounded explicit context profiles', () => {
    const providers = AGENT_PROVIDER_OPTIONS.map((provider) => provider.value);
    expect(new Set(providers).size).toBe(providers.length);
    for (const provider of AGENT_PROVIDER_OPTIONS) {
      expect(provider.models.length).toBeGreaterThan(0);
      const models = provider.models.map((model) => model.value);
      expect(new Set(models).size).toBe(models.length);
      for (const model of provider.models) {
        expect(model.context.contextWindowTokens).toBeGreaterThan(0);
        expect(model.context.maxOutputTokens).toBeGreaterThan(0);
        expect(model.context.maxOutputTokens).toBeLessThanOrEqual(
          model.context.contextWindowTokens,
        );
        expect(model.context.id).toContain(model.value);
      }
    }
  });

  it('fails closed to a provider-local certified model instead of crossing providers', () => {
    expect(normalizeAgentProvider('unknown')).toBe(DEFAULT_AGENT_PROVIDER);
    expect(normalizeAgentProviderModel('anthropic', 'gpt-4.1')).toBe(
      AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'anthropic')!.models[0]!.value,
    );
    expect(resolveAgentProviderContextProfile('openai', 'claude-sonnet-5').id).toBe(
      AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'openai')!.models[0]!.context.id,
    );
  });
});
