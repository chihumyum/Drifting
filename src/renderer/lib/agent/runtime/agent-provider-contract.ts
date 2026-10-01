import type { AgentModelContextProfile } from './types';
import type { CodexModel } from '../../../platform/contracts';
import type {
  AgentEffortChoice,
  AgentProviderChoice,
  AgentThinkingChoice,
} from '../protocol';

/** Providers whose BYOK wire contract is certified for the General Agent. */
export type AgentProviderId = AgentProviderChoice;

/**
 * Providers served by the native OpenAI Responses transport. `openai` bills an
 * API key against the public API; `openai-codex` is the experimental ChatGPT
 * subscription route against the Codex backend with the same request body.
 */
export type OpenAIResponsesProviderId = Extract<AgentProviderId, 'openai' | 'openai-codex'>;

export interface AgentProviderModelOption {
  value: string;
  label: string;
  short: string;
  context: Readonly<AgentModelContextProfile>;
  reasoning: Readonly<AgentModelReasoningProfile>;
  responses?: { supportsSummary: boolean; supportsVerbosity: boolean };
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
  maxOutputTokens: number | null,
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
 * Bundled model catalog. ChatGPT subscription discovery overrides its choices
 * in agentProviderOption; this snapshot remains the offline fallback/inventory.
 *
 * Bundled context profiles are explicit wire contracts. Discovered profiles
 * use server metadata, with a conservative local budget when it is missing.
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
        context: profile('deepseek-v4-flash:agent-v3', 200_000, null, 512),
        reasoning: DEEPSEEK_REASONING,
      },
      {
        value: 'deepseek-v4-pro',
        label: 'DeepSeek Pro · steady',
        short: 'DeepSeek Pro',
        context: profile('deepseek-v4-pro:agent-v3', 200_000, null, 512),
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
  {
    // Experimental, unsupported: the author's own ChatGPT subscription signed
    // in through the Codex device flow. Same GPT-5.6 wire contract, different
    // origin and credential; the backend may withdraw it without notice.
    value: 'openai-codex',
    label: 'OpenAI · ChatGPT subscription',
    models: Object.freeze([
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol · frontier',
        short: '5.6 Sol',
        context: profile('gpt-5.6-sol:responses-codex-v1', 1_050_000, 128_000, 640),
        reasoning: ADAPTIVE_REASONING,
      },
      {
        value: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra · balanced',
        short: '5.6 Terra',
        context: profile('gpt-5.6-terra:responses-codex-v1', 1_050_000, 128_000, 640),
        reasoning: ADAPTIVE_REASONING,
      },
      {
        value: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna · efficient',
        short: '5.6 Luna',
        context: profile('gpt-5.6-luna:responses-codex-v1', 1_050_000, 128_000, 640),
        reasoning: ADAPTIVE_REASONING,
      },
    ]),
  },
]);

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'deepseek';

// Session-only account catalog. The bundled inventory remains deterministic
// acceptance evidence and is used when discovery has not succeeded.
let codexModels: readonly AgentProviderModelOption[] | null = null;
const CODEX_EFFORTS: readonly AgentEffortChoice[] = [
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

export function setCodexModelCatalog(models: readonly CodexModel[] | null): void {
  codexModels = models?.map((model) => {
    const efforts = [...new Set(
      model.supportedReasoningEfforts.filter(
        (effort): effort is AgentEffortChoice => CODEX_EFFORTS.includes(effort as AgentEffortChoice),
      ),
    )];
    const allowsOff = efforts.length === 0 || model.supportedReasoningEfforts.includes('none');
    const thinkingModes: AgentThinkingChoice[] = [
      ...(allowsOff ? ['off' as const] : []),
      ...(efforts.length ? ['adaptive' as const] : []),
    ];
    return {
      value: model.slug,
      label: model.displayName,
      short: model.displayName,
      // Missing metadata never inherits a million-token window from an older model.
      context: profile(
        `${model.slug}:responses-codex-catalog-v2`, model.contextWindow ?? 32_768, null, 640,
      ),
      reasoning: reasoningProfile(
        thinkingModes,
        efforts,
        allowsOff ? 'off' : 'adaptive',
        efforts.find((effort) => effort === model.defaultReasoningEffort) ?? efforts[0] ?? 'high',
      ),
      responses: {
        supportsSummary: model.supportsReasoningSummary,
        supportsVerbosity: model.supportsVerbosity,
      },
    };
  }) ?? null;
}

export function isCodexModelSelection(value: unknown): value is string {
  // Preserve a saved remote model across restarts and catalog outages, while
  // rejecting identifiers already owned by a different certified provider.
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,200}$/.test(value)
    && !AGENT_PROVIDER_OPTIONS.some((provider) =>
      provider.value !== 'openai-codex' && provider.value !== 'openai'
      && provider.models.some((model) => model.value === value),
    );
}

export function agentProviderModelOption(
  provider: AgentProviderId,
  model: string,
): AgentProviderModelOption {
  const option = agentProviderOption(provider);
  return option.models.find((candidate) => candidate.value === model)
    ?? (provider === 'openai-codex' && isCodexModelSelection(model) ? {
      value: model, label: model, short: model,
      context: profile(`${model}:responses-codex-unresolved-v2`, 32_768, null, 640),
      // Keep persisted controls intact until fresh metadata is available.
      reasoning: reasoningProfile(['off', 'adaptive'], CODEX_EFFORTS),
    } : option.models[0]);
}

export function normalizeAgentProvider(value: unknown): AgentProviderId {
  return AGENT_PROVIDER_OPTIONS.some((candidate) => candidate.value === value)
    ? (value as AgentProviderId)
    : DEFAULT_AGENT_PROVIDER;
}

export function agentProviderOption(provider: AgentProviderId): AgentProviderOption {
  if (provider === 'openai-codex' && codexModels?.length) {
    return { value: provider, label: 'OpenAI · ChatGPT subscription', models: codexModels };
  }
  return (
    AGENT_PROVIDER_OPTIONS.find((candidate) => candidate.value === provider) ??
    AGENT_PROVIDER_OPTIONS[0]
  );
}

export function normalizeAgentProviderModel(
  provider: AgentProviderId,
  value: unknown,
): string {
  if (provider === 'openai-codex' && isCodexModelSelection(value)) return value;
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
  const model = normalizeAgentProviderModel(provider, modelValue);
  return agentProviderModelOption(provider, model).context;
}

export function resolveAgentProviderReasoningProfile(
  providerValue: unknown,
  modelValue: unknown,
): Readonly<AgentModelReasoningProfile> {
  const provider = normalizeAgentProvider(providerValue);
  const model = normalizeAgentProviderModel(provider, modelValue);
  return agentProviderModelOption(provider, model).reasoning;
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
