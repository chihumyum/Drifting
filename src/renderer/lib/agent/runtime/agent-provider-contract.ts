import type { AgentModelContextProfile } from './types';
import type { AgentProviderChoice } from '../protocol';

/** Providers whose BYOK wire contract is certified for the General Agent. */
export type AgentProviderId = AgentProviderChoice;

export interface AgentProviderModelOption {
  value: string;
  label: string;
  short: string;
  context: Readonly<AgentModelContextProfile>;
}

export interface AgentProviderOption {
  value: AgentProviderId;
  label: string;
  models: readonly AgentProviderModelOption[];
}

const profile = (
  id: string,
  contextWindowTokens: number,
  maxOutputTokens: number,
  providerOverheadTokens: number,
): Readonly<AgentModelContextProfile> =>
  Object.freeze({
    id,
    contextWindowTokens,
    maxOutputTokens,
    providerOverheadTokens,
    perToolOverheadTokens: 8,
  });

/**
 * Product-certified model catalog.
 *
 * Context profiles are explicit wire contracts, never guesses made from an
 * arbitrary model string. The product planner may cap these windows, but may
 * never enlarge them.
 */
export const AGENT_PROVIDER_OPTIONS: readonly AgentProviderOption[] = Object.freeze([
  {
    value: 'deepseek',
    label: 'DeepSeek',
    models: Object.freeze([
      {
        value: 'deepseek-v4-flash',
        label: 'DeepSeek Flash · fast',
        short: 'DeepSeek Flash',
        context: profile('deepseek-v4-flash:agent-v2', 200_000, 8_192, 512),
      },
      {
        value: 'deepseek-v4-pro',
        label: 'DeepSeek Pro · steady',
        short: 'DeepSeek Pro',
        context: profile('deepseek-v4-pro:agent-v2', 200_000, 8_192, 512),
      },
    ]),
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    models: Object.freeze([
      {
        value: 'claude-sonnet-5',
        label: 'Claude Sonnet 5 · balanced',
        short: 'Sonnet 5',
        context: profile('claude-sonnet-5:messages-v1', 1_000_000, 128_000, 768),
      },
      {
        value: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5 · fast',
        short: 'Haiku 4.5',
        context: profile('claude-haiku-4-5-20251001:messages-v1', 200_000, 64_000, 768),
      },
    ]),
  },
  {
    value: 'openai',
    label: 'OpenAI',
    models: Object.freeze([
      {
        value: 'gpt-4.1',
        label: 'GPT-4.1 · capable',
        short: 'GPT-4.1',
        context: profile('gpt-4.1:chat-completions-v1', 1_000_000, 32_768, 640),
      },
      {
        value: 'gpt-4.1-mini',
        label: 'GPT-4.1 mini · fast',
        short: 'GPT-4.1 mini',
        context: profile('gpt-4.1-mini:chat-completions-v1', 1_000_000, 32_768, 640),
      },
    ]),
  },
]);

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'deepseek';

export function normalizeAgentProvider(value: unknown): AgentProviderId {
  return AGENT_PROVIDER_OPTIONS.some((candidate) => candidate.value === value)
    ? (value as AgentProviderId)
    : DEFAULT_AGENT_PROVIDER;
}

export function agentProviderOption(provider: AgentProviderId): AgentProviderOption {
  return (
    AGENT_PROVIDER_OPTIONS.find((candidate) => candidate.value === provider) ??
    AGENT_PROVIDER_OPTIONS[0]
  );
}

export function normalizeAgentProviderModel(
  provider: AgentProviderId,
  value: unknown,
): string {
  const option = agentProviderOption(provider);
  return option.models.some((model) => model.value === value)
    ? (value as string)
    : option.models[0].value;
}

export function resolveAgentProviderContextProfile(
  providerValue: unknown,
  modelValue: unknown,
): Readonly<AgentModelContextProfile> {
  const provider = normalizeAgentProvider(providerValue);
  const option = agentProviderOption(provider);
  const model = normalizeAgentProviderModel(provider, modelValue);
  return option.models.find((candidate) => candidate.value === model)!.context;
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return AGENT_PROVIDER_OPTIONS.some((candidate) => candidate.value === value);
}
