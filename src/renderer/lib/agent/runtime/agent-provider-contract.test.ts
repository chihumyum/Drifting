import { describe, expect, it } from 'vitest';

import {
  AGENT_PROVIDER_OPTIONS,
  DEFAULT_AGENT_PROVIDER,
  normalizeAgentProvider,
  normalizeAgentProviderEffort,
  normalizeAgentProviderModel,
  normalizeAgentProviderThinking,
  resolveAgentProviderContextProfile,
  resolveAgentProviderReasoningProfile,
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
        expect(model.reasoning.thinkingModes).toContain('off');
        expect(model.reasoning.defaultThinking).toBe('off');
      }
    }
  });

  it('fails closed to a provider-local certified model instead of crossing providers', () => {
    expect(normalizeAgentProvider('unknown')).toBe(DEFAULT_AGENT_PROVIDER);
    expect(normalizeAgentProviderModel('anthropic', 'gpt-5.6-sol')).toBe(
      AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'anthropic')!.models[0]!.value,
    );
    expect(resolveAgentProviderContextProfile('openai', 'claude-sonnet-5').id).toBe(
      AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'openai')!.models[0]!.context.id,
    );
  });

  it('certifies the GPT-5.6 family on the Responses API contract', () => {
    const openai = AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'openai')!;
    expect(openai.models.map((model) => model.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    for (const model of openai.models) {
      expect(model.context.id).toContain('responses-v1');
      expect(model.context.contextWindowTokens).toBe(1_050_000);
      expect(model.context.maxOutputTokens).toBe(128_000);
      expect(model.reasoning.efforts).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  });

  it('certifies the ChatGPT subscription route as a twin of the OpenAI body with its own wire id', () => {
    const openai = AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'openai')!;
    const codex = AGENT_PROVIDER_OPTIONS.find((item) => item.value === 'openai-codex')!;
    expect(codex.models.map((model) => model.value)).toEqual(
      openai.models.map((model) => model.value),
    );
    for (const model of codex.models) {
      const twin = openai.models.find((candidate) => candidate.value === model.value)!;
      expect(model.context.id).toBe(`${model.value}:responses-codex-v1`);
      expect(model.context.contextWindowTokens).toBe(twin.context.contextWindowTokens);
      expect(model.context.maxOutputTokens).toBe(twin.context.maxOutputTokens);
      expect(model.reasoning).toEqual(twin.reasoning);
    }
    expect(normalizeAgentProviderModel('openai-codex', 'deepseek-v4-flash')).toBe('gpt-5.6-sol');
  });

  it('normalizes thinking and effort inside each model capability profile', () => {
    expect(normalizeAgentProviderEffort('deepseek', 'deepseek-v4-pro', 'low')).toBe(
      'high',
    );
    expect(normalizeAgentProviderEffort('deepseek', 'deepseek-v4-pro', 'max')).toBe(
      'max',
    );
    expect(
      normalizeAgentProviderThinking(
        'anthropic',
        'claude-haiku-4-5-20251001',
        'adaptive',
      ),
    ).toBe('off');
    expect(
      resolveAgentProviderReasoningProfile('anthropic', 'claude-sonnet-5')
        .thinkingModes,
    ).toContain('adaptive');
  });
});
