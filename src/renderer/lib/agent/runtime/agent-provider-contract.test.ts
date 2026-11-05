import { afterEach, describe, expect, it } from 'vitest';

import type { ByokListedModel } from '../../../platform/contracts';
import {
  AGENT_PROVIDER_OPTIONS,
  BYOK_AGENT_PROVIDERS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  agentProviderModelOption,
  agentProviderOption,
  hasListedAgentModels,
  isAgentModelForProvider,
  isAgentProviderModelSelection,
  normalizeAgentProvider,
  normalizeAgentProviderEffort,
  normalizeAgentProviderModel,
  normalizeAgentProviderThinking,
  resolveAgentProviderContextProfile,
  resolveAgentProviderReasoningProfile,
  setByokModelCatalog,
} from './agent-provider-contract';

const listed = (id: string, extra: Partial<ByokListedModel> = {}): ByokListedModel => ({
  id,
  displayName: null,
  created: null,
  contextWindow: null,
  maxOutputTokens: null,
  adaptiveThinking: null,
  efforts: null,
  defaultEffort: null,
  ...extra,
});

const ids = (provider: Parameters<typeof agentProviderOption>[0]) =>
  agentProviderOption(provider).models.map((model) => model.value);

afterEach(() => {
  for (const provider of BYOK_AGENT_PROVIDERS) setByokModelCatalog(provider, null);
});

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
        if (model.context.maxOutputTokens !== null) {
          expect(model.context.maxOutputTokens).toBeGreaterThan(0);
          expect(model.context.maxOutputTokens).toBeLessThanOrEqual(model.context.contextWindowTokens);
        }
        expect(model.context.id).toContain(model.value);
        expect(model.reasoning.thinkingModes).toContain(model.reasoning.defaultThinking);
        if (model.reasoning.thinkingModes.includes('off')) {
          expect(model.reasoning.defaultThinking).toBe('off');
        }
      }
    }
  });

  it('bundles each provider’s current models as the offline fallback', () => {
    expect(DEFAULT_AGENT_MODEL).toBe('deepseek-flash');
    expect(ids('deepseek')).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    for (const model of agentProviderOption('deepseek').models) {
      // DeepSeek's model list: 1,048,576-token window, 393,216 output, low/high/max.
      expect(model.context).toMatchObject({ contextWindowTokens: 1_048_576, maxOutputTokens: 393_216 });
      expect(model.reasoning).toMatchObject({ thinkingModes: ['off', 'adaptive'], efforts: ['low', 'high', 'max'] });
    }
    expect(ids('anthropic')).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-5-5',
    ]);
    expect(ids('openai')).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
    for (const model of agentProviderOption('anthropic').models) {
      expect(model.context.maxOutputTokens).toBe(128_000);
      // The current Anthropic generation cannot turn thinking off.
      expect(model.reasoning.thinkingModes).toEqual(['adaptive']);
    }
    expect(agentProviderModelOption('anthropic', 'claude-opus-5-5').forcedToolChoice).toBe(false);
    expect(agentProviderModelOption('anthropic', 'claude-haiku-5-5').forcedToolChoice).toBeUndefined();
    expect(resolveAgentProviderReasoningProfile('openai', 'gpt-6-astra').thinkingModes).toEqual(['adaptive']);
    expect(resolveAgentProviderReasoningProfile('openai', 'gpt-6-luna').thinkingModes).toEqual(['off', 'adaptive']);
    for (const model of agentProviderOption('openai').models) {
      expect(model.context.id).toBe(`${model.value}:responses-v1`);
      expect(model.context.contextWindowTokens).toBe(1_050_000);
      expect(model.reasoning.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    }
  });

  it('fails closed to a provider-local model instead of crossing providers', () => {
    expect(normalizeAgentProvider('unknown')).toBe(DEFAULT_AGENT_PROVIDER);
    expect(normalizeAgentProviderModel('anthropic', 'gpt-6-astra')).toBe('claude-sonnet-5-5');
    expect(normalizeAgentProviderModel('deepseek', 'claude-opus-5-5')).toBe('deepseek-flash');
    expect(normalizeAgentProviderModel('openai', 'deepseek-v4-pro')).toBe('gpt-6-astra');
    expect(resolveAgentProviderContextProfile('openai', 'claude-sonnet-5').id).toBe(
      'gpt-6-astra:responses-v1',
    );
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
    expect(normalizeAgentProviderModel('openai-codex', 'deepseek-v4-flash')).toBe('gpt-6-astra');
  });

  it('normalizes thinking and effort inside each model capability profile', () => {
    expect(normalizeAgentProviderEffort('deepseek', 'deepseek-v4-pro', 'medium')).toBe('high');
    expect(normalizeAgentProviderEffort('deepseek', 'deepseek-v4-pro', 'low')).toBe('low');
    expect(normalizeAgentProviderEffort('deepseek', 'deepseek-v4-pro', 'max')).toBe('max');
    expect(
      normalizeAgentProviderThinking('anthropic', 'claude-haiku-4-5-20251001', 'adaptive'),
    ).toBe('off');
    expect(normalizeAgentProviderThinking('anthropic', 'claude-opus-5-5', 'off')).toBe('adaptive');
    expect(
      resolveAgentProviderReasoningProfile('anthropic', 'claude-sonnet-5').thinkingModes,
    ).toEqual(['off', 'adaptive']);
  });

  it('keeps earlier bundled models and saved choices across restarts and list outages', () => {
    for (const [provider, model] of [
      ['deepseek', 'deepseek-v4-pro'],
      ['anthropic', 'claude-sonnet-5'],
      ['anthropic', 'claude-haiku-4-5-20251001'],
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-6.2-nova'],
      ['anthropic', 'claude-opus-6'],
    ] as const) {
      expect(normalizeAgentProviderModel(provider, model)).toBe(model);
    }
    // Earlier bundled models keep their explicit wire profile.
    expect(resolveAgentProviderContextProfile('openai', 'gpt-5.6-sol').id).toBe('gpt-5.6-sol:responses-v1');
    expect(resolveAgentProviderContextProfile('anthropic', 'claude-haiku-4-5-20251001').maxOutputTokens).toBe(64_000);
    // A choice not yet listed never inherits a large window or forced tool use.
    const unresolved = agentProviderModelOption('anthropic', 'claude-opus-6');
    expect(unresolved.context.contextWindowTokens).toBe(128_000);
    expect(unresolved.context.maxOutputTokens).toBe(32_000);
    expect(unresolved.forcedToolChoice).toBe(false);
    expect(unresolved.reasoning.thinkingModes).toEqual(['adaptive']);
    expect(resolveAgentProviderContextProfile('openai', 'gpt-6.2-nova')).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: null,
    });
    // The retired DeepSeek Flash id moves to its successor.
    expect(normalizeAgentProviderModel('deepseek', 'deepseek-v4-flash')).toBe('deepseek-flash');
  });

  it('offers OpenAI text models the Agent can drive and leaves out other families', () => {
    for (const id of ['gpt-6-astra', 'gpt-6.1-terra', 'gpt-5', 'gpt-5-mini', 'gpt-5.6-sol', 'gpt-7']) {
      expect(isAgentModelForProvider('openai', id)).toBe(true);
    }
    for (const id of [
      'gpt-4.1', 'gpt-4o', 'o3', 'chatgpt-4o-latest', 'gpt-5-2025-08-07', 'gpt-5-chat-latest',
      'gpt-5-codex', 'gpt-5.6-cyber', 'gpt-6-rosalind', 'gpt-realtime-2.1', 'gpt-image-2',
      'gpt-4o-mini-transcribe', 'gpt-5-search-api', 'text-embedding-3-large', 'gpt-live-1',
      'gpt-rosalind-research', 'ft:gpt-6-luna:org:custom',
    ]) {
      expect(isAgentModelForProvider('openai', id)).toBe(false);
    }
    expect(isAgentProviderModelSelection('anthropic', 'claude-opus-6')).toBe(true);
    expect(isAgentProviderModelSelection('anthropic', 'gpt-6-astra')).toBe(false);
    expect(isAgentProviderModelSelection('deepseek', 'deepseek-flash')).toBe(true);
  });

  it('replaces the bundled offer with the key’s own list, bundled order first then newest', () => {
    setByokModelCatalog('openai', [
      listed('gpt-4o', { created: 1_900_000_000 }),
      listed('gpt-5.6-sol', { created: 1_780_000_000 }),
      listed('gpt-6.1-terra', { created: 1_790_000_000 }),
      listed('gpt-6.2-nova', { created: 1_800_000_000 }),
      listed('gpt-6-astra', { created: 1_785_000_000 }),
      listed('gpt-realtime-2.1', { created: 1_795_000_000 }),
    ]);
    expect(hasListedAgentModels('openai')).toBe(true);
    expect(ids('openai')).toEqual(['gpt-6-astra', 'gpt-6.1-terra', 'gpt-6.2-nova', 'gpt-5.6-sol']);
    expect(agentProviderModelOption('openai', 'gpt-6.2-nova')).toMatchObject({
      label: 'gpt-6.2-nova',
      context: { contextWindowTokens: 128_000, maxOutputTokens: null },
      reasoning: { thinkingModes: ['adaptive'], efforts: ['low', 'medium', 'high'] },
    });
    // Switching providers picks the list's first model.
    expect(normalizeAgentProviderModel('openai', 'claude-opus-5-5')).toBe('gpt-6-astra');

    setByokModelCatalog('deepseek', [listed('deepseek-v4-pro'), listed('deepseek-flash'), listed('deepseek-v5')]);
    expect(ids('deepseek')).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5']);
    // A list entry without specs keeps a conservative profile.
    expect(resolveAgentProviderReasoningProfile('deepseek', 'deepseek-v5').efforts).toEqual(['high', 'max']);
    expect(resolveAgentProviderContextProfile('deepseek', 'deepseek-v5').contextWindowTokens).toBe(128_000);

    // A list with no model the Agent can drive keeps the bundled offer.
    setByokModelCatalog('openai', [listed('gpt-4o'), listed('o3')]);
    expect(hasListedAgentModels('openai')).toBe(false);
    expect(ids('openai')).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
    setByokModelCatalog('deepseek', null);
    expect(ids('deepseek')).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('takes DeepSeek limits and effort levels from its model list', () => {
    setByokModelCatalog('deepseek', [
      listed('deepseek-flash', {
        displayName: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      }),
      listed('deepseek-v5', {
        displayName: 'DeepSeek-V5',
        contextWindow: 2_097_152,
        maxOutputTokens: 524_288,
        efforts: ['low', 'medium', 'high', 'max', 'ultra'],
        defaultEffort: 'medium',
      }),
    ]);
    expect(agentProviderModelOption('deepseek', 'deepseek-flash')).toMatchObject({
      label: 'DeepSeek Flash · fast',
      context: { contextWindowTokens: 1_048_576, maxOutputTokens: 393_216 },
    });
    expect(agentProviderModelOption('deepseek', 'deepseek-v5')).toMatchObject({
      label: 'DeepSeek-V5',
      context: { id: 'deepseek-v5:agent-listed-v1', contextWindowTokens: 2_097_152, maxOutputTokens: 524_288 },
      reasoning: {
        thinkingModes: ['off', 'adaptive'],
        efforts: ['low', 'medium', 'high', 'max'],
        defaultThinking: 'off',
        defaultEffort: 'medium',
      },
    });
    expect(normalizeAgentProviderEffort('deepseek', 'deepseek-v5', 'xhigh')).toBe('medium');
  });

  it('takes Anthropic limits and capabilities from the Models API', () => {
    setByokModelCatalog('anthropic', [
      listed('claude-opus-6', {
        displayName: 'Claude Opus 6',
        contextWindow: 2_000_000,
        maxOutputTokens: 256_000,
        adaptiveThinking: true,
        efforts: ['low', 'medium', 'high', 'max', 'ultra'],
      }),
      listed('claude-sonnet-5-5', {
        displayName: 'Claude Sonnet 5.5',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        adaptiveThinking: true,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }),
      listed('claude-sonnet-5', {
        displayName: 'Claude Sonnet 5',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        adaptiveThinking: true,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }),
      listed('claude-haiku-4-5-20251001', {
        displayName: 'Claude Haiku 4.5',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        adaptiveThinking: false,
        efforts: [],
      }),
      listed('claude-legacy-bare'),
    ]);
    expect(ids('anthropic')).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-6',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
      'claude-legacy-bare',
    ]);
    expect(agentProviderModelOption('anthropic', 'claude-opus-6')).toMatchObject({
      label: 'Claude Opus 6',
      context: { contextWindowTokens: 2_000_000, maxOutputTokens: 256_000 },
      reasoning: { thinkingModes: ['adaptive'], efforts: ['low', 'medium', 'high', 'max'] },
      forcedToolChoice: false,
    });
    // Bundled labels and switches survive the listed metadata.
    expect(agentProviderModelOption('anthropic', 'claude-sonnet-5-5')).toMatchObject({
      label: 'Claude Sonnet 5.5 · balanced',
      forcedToolChoice: false,
    });
    expect(agentProviderModelOption('anthropic', 'claude-sonnet-5')).toMatchObject({
      reasoning: { thinkingModes: ['off', 'adaptive'] },
      forcedToolChoice: true,
    });
    expect(agentProviderModelOption('anthropic', 'claude-haiku-4-5-20251001').reasoning).toMatchObject({
      thinkingModes: ['off'],
      efforts: [],
    });
    // An entry without specs is treated like any unknown choice.
    expect(agentProviderModelOption('anthropic', 'claude-legacy-bare')).toMatchObject({
      context: { contextWindowTokens: 128_000, maxOutputTokens: 32_000 },
      reasoning: { thinkingModes: ['adaptive'], efforts: ['low', 'medium', 'high'] },
      forcedToolChoice: false,
    });
  });
});
