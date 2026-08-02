import type { AgentModelContextProfile } from './types';
import type {
  AgentEffortChoice,
  AgentProviderChoice,
  AgentThinkingChoice,
} from '../protocol';

/** Providers whose BYOK wire contract is certified for the General Agent. */
export type AgentProviderId = AgentProviderChoice;

export interface AgentProviderModelOption {
  value: string;
  label: string;
  short: string;
  context: Readonly<AgentModelContextProfile>;
  reasoning: Readonly<AgentModelReasoningProfile>;
}

export interface AgentModelReasoningProfile {
  thinkingModes: readonly AgentThinkingChoice[];
  efforts: readonly AgentEffortChoice[];
  defaultThinking: AgentThinkingChoice;
  defaultEffort: AgentEffortChoice;
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

const reasoningProfile = (
  thinkingModes: readonly AgentThinkingChoice[],
  efforts: readonly AgentEffortChoice[],
  defaultThinking: AgentThinkingChoice = 'off',
  defaultEffort: AgentEffortChoice = 'high',
): Readonly<AgentModelReasoningProfile> =>
  Object.freeze({
    thinkingModes: Object.freeze([...thinkingModes]),
    efforts: Object.freeze([...efforts]),
    defaultThinking,
    defaultEffort,
  });

const ADAPTIVE_REASONING = reasoningProfile(
  ['off', 'adaptive'],
  ['low', 'medium', 'high', 'xhigh', 'max'],
);
const DEEPSEEK_REASONING = reasoningProfile(
  ['off', 'adaptive'],
  ['high', 'max'],
);
const NO_REASONING = reasoningProfile(['off'], []);

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
        reasoning: DEEPSEEK_REASONING,
      },
      {
        value: 'deepseek-v4-pro',
        label: 'DeepSeek Pro · steady',
        short: 'DeepSeek Pro',
        context: profile('deepseek-v4-pro:agent-v2', 200_000, 8_192, 512),
        reasoning: DEEPSEEK_REASONING,
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
        reasoning: ADAPTIVE_REASONING,
      },
      {
        value: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5 · fast',
        short: 'Haiku 4.5',
        context: profile('claude-haiku-4-5-20251001:messages-v1', 200_000, 64_000, 768),
        reasoning: NO_REASONING,
      },
    ]),
  },
  {
    value: 'openai',
    label: 'OpenAI',
    models: Object.freeze([
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol · frontier',
        short: '5.6 Sol',
        context: profile('gpt-5.6-sol:responses-v1', 1_050_000, 128_000, 640),
        reasoning: ADAPTIVE_REASONING,
      },
      {
        value: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra · balanced',
        short: '5.6 Terra',
        context: profile('gpt-5.6-terra:responses-v1', 1_050_000, 128_000, 640),
        reasoning: ADAPTIVE_REASONING,
      },
      {
        value: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna · efficient',
        short: '5.6 Luna',
        context: profile('gpt-5.6-luna:responses-v1', 1_050_000, 128_000, 640),
        reasoning: ADAPTIVE_REASONING,
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

export function resolveAgentProviderReasoningProfile(
  providerValue: unknown,
  modelValue: unknown,
): Readonly<AgentModelReasoningProfile> {
  const provider = normalizeAgentProvider(providerValue);
  const option = agentProviderOption(provider);
  const model = normalizeAgentProviderModel(provider, modelValue);
  return option.models.find((candidate) => candidate.value === model)!.reasoning;
}

export function normalizeAgentProviderThinking(
  providerValue: unknown,
  modelValue: unknown,
  value: unknown,
): AgentThinkingChoice {
  const reasoning = resolveAgentProviderReasoningProfile(providerValue, modelValue);
  return reasoning.thinkingModes.includes(value as AgentThinkingChoice)
    ? (value as AgentThinkingChoice)
    : reasoning.defaultThinking;
}

export function normalizeAgentProviderEffort(
  providerValue: unknown,
  modelValue: unknown,
  value: unknown,
): AgentEffortChoice {
  const reasoning = resolveAgentProviderReasoningProfile(providerValue, modelValue);
  if (reasoning.efforts.length === 0) return reasoning.defaultEffort;
  return reasoning.efforts.includes(value as AgentEffortChoice)
    ? (value as AgentEffortChoice)
    : reasoning.defaultEffort;
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return AGENT_PROVIDER_OPTIONS.some((candidate) => candidate.value === value);
}
