import type { AgentModelContextProfile } from './types';
import type { ByokListedModel, CodexModel } from '../../../platform/contracts';
import type {
  AgentEffortChoice,
  AgentProviderChoice,
  AgentThinkingChoice,
} from '../protocol';

/** Providers whose BYOK wire contract is certified for the General Agent. */
export type AgentProviderId = AgentProviderChoice;

/** API-key providers whose models are listed by the provider for the stored key. */
export type ByokAgentProviderId = Extract<AgentProviderId, 'deepseek' | 'anthropic' | 'openai'>;

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
  /**
   * False when the provider rejects a forced tool choice for this model
   * (Anthropic `tool_choice` `any` / `tool`); the driver then sends `auto`.
   */
  forcedToolChoice?: boolean;
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
  defaultThinking: AgentThinkingChoice = thinkingModes.includes('off') ? 'off' : 'adaptive',
  defaultEffort: AgentEffortChoice = 'high',
): Readonly<AgentModelReasoningProfile> =>
  Object.freeze({
    thinkingModes: Object.freeze([...thinkingModes]),
    efforts: Object.freeze([...efforts]),
    defaultThinking,
    defaultEffort,
  });

const FULL_EFFORTS: readonly AgentEffortChoice[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ADAPTIVE_REASONING = reasoningProfile(['off', 'adaptive'], FULL_EFFORTS);
/** Models whose provider rejects turning reasoning off (no `none` effort / disabled thinking). */
const ALWAYS_REASONING = reasoningProfile(['adaptive'], FULL_EFFORTS);
const DEEPSEEK_REASONING = reasoningProfile(
  ['off', 'adaptive'],
  ['high', 'max'],
);
const NO_REASONING = reasoningProfile(['off'], []);

const OPENAI_MODELS = [
  ['gpt-6-astra', 'GPT-6 Astra · frontier', '6 Astra', ALWAYS_REASONING],
  ['gpt-6.1-sol', 'GPT-6.1 Sol · strong', '6.1 Sol', ALWAYS_REASONING],
  ['gpt-6.1-terra', 'GPT-6.1 Terra · balanced', '6.1 Terra', ADAPTIVE_REASONING],
  ['gpt-6-luna', 'GPT-6 Luna · efficient', '6 Luna', ADAPTIVE_REASONING],
] as const;

const openAIModels = (wire: 'responses-v1' | 'responses-codex-v1') =>
  Object.freeze(OPENAI_MODELS.map(([value, label, short, reasoning]) => ({
    value,
    label,
    short,
    context: profile(`${value}:${wire}`, 1_050_000, 128_000, 640),
    reasoning,
  })));

/**
 * Bundled model catalog: each provider's current models as of 2026-11, in the
 * order the menu offers them (the first is the provider's default). It is the
 * fallback while a provider's own list is unavailable (no key, offline, outside
 * the native app, or a failed request) and the deterministic acceptance
 * inventory. A successful provider list replaces a provider's choices in
 * agentProviderOption.
 *
 * Bundled context profiles are explicit wire contracts. Listed models use the
 * provider's metadata where it publishes some, a bundled or legacy profile for
 * a known id, and a conservative local budget otherwise.
 */
export const AGENT_PROVIDER_OPTIONS: readonly AgentProviderOption[] = Object.freeze([
  {
    value: 'deepseek',
    label: 'DeepSeek',
    models: Object.freeze([
      {
        value: 'deepseek-flash',
        label: 'DeepSeek Flash · fast',
        short: 'DeepSeek Flash',
        context: profile('deepseek-flash:agent-v3', 200_000, null, 512),
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
        value: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5 · balanced',
        short: 'Sonnet 5.5',
        context: profile('claude-sonnet-5-5:messages-v1', 1_000_000, 128_000, 768),
        reasoning: ALWAYS_REASONING,
        forcedToolChoice: false,
      },
      {
        value: 'claude-opus-5-5',
        label: 'Claude Opus 5.5 · steady',
        short: 'Opus 5.5',
        context: profile('claude-opus-5-5:messages-v1', 1_000_000, 128_000, 768),
        reasoning: ALWAYS_REASONING,
        forcedToolChoice: false,
      },
      {
        value: 'claude-fable-5-1',
        label: 'Claude Fable 5.1 · frontier',
        short: 'Fable 5.1',
        context: profile('claude-fable-5-1:messages-v1', 1_000_000, 128_000, 768),
        reasoning: ALWAYS_REASONING,
        forcedToolChoice: false,
      },
      {
        value: 'claude-haiku-5-5',
        label: 'Claude Haiku 5.5 · fast',
        short: 'Haiku 5.5',
        context: profile('claude-haiku-5-5:messages-v1', 1_000_000, 128_000, 768),
        reasoning: ALWAYS_REASONING,
      },
    ]),
  },
  {
    value: 'openai',
    label: 'OpenAI',
    models: openAIModels('responses-v1'),
  },
  {
    // Experimental, unsupported: the author's own ChatGPT subscription signed
    // in through the Codex device flow. Same Responses wire contract, different
    // origin and credential; the backend may withdraw it without notice. Its
    // account catalog is discovered; this twin is only the offline fallback.
    value: 'openai-codex',
    label: 'OpenAI · ChatGPT subscription',
    models: openAIModels('responses-codex-v1'),
  },
]);

/**
 * Earlier bundled models the providers still serve. They are not offered while
 * a provider's list is unavailable, but a saved choice or a listed id keeps its
 * explicit wire profile.
 */
const LEGACY_PROVIDER_MODELS: Readonly<Record<ByokAgentProviderId, readonly AgentProviderModelOption[]>> = Object.freeze({
  deepseek: Object.freeze([]),
  anthropic: Object.freeze([
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
  openai: Object.freeze((['sol', 'terra', 'luna'] as const).map((tier) => ({
    value: `gpt-5.6-${tier}`,
    label: `GPT-5.6 ${tier[0]!.toUpperCase()}${tier.slice(1)}`,
    short: `5.6 ${tier[0]!.toUpperCase()}${tier.slice(1)}`,
    context: profile(`gpt-5.6-${tier}:responses-v1`, 1_050_000, 128_000, 640),
    reasoning: ADAPTIVE_REASONING,
  }))),
});

/** Retired ids the provider still routes to a successor; a saved choice moves with it. */
const MODEL_ALIASES: Readonly<Partial<Record<AgentProviderId, Readonly<Record<string, string>>>>> = Object.freeze({
  deepseek: Object.freeze({ 'deepseek-v4-flash': 'deepseek-flash' }),
});

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'deepseek';

/** A provider's bundled default model: the first one its menu offers offline. */
export function defaultAgentProviderModel(provider: AgentProviderId): string {
  return (AGENT_PROVIDER_OPTIONS.find((candidate) => candidate.value === provider)
    ?? AGENT_PROVIDER_OPTIONS[0]!).models[0]!.value;
}

export const DEFAULT_AGENT_MODEL = defaultAgentProviderModel(DEFAULT_AGENT_PROVIDER);

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

// Session-only lists from each API-key provider's own model endpoint.
const byokModels = new Map<ByokAgentProviderId, readonly AgentProviderModelOption[]>();

export const BYOK_AGENT_PROVIDERS: readonly ByokAgentProviderId[] = Object.freeze([
  'deepseek', 'anthropic', 'openai',
]);

export function isByokAgentProvider(value: unknown): value is ByokAgentProviderId {
  return BYOK_AGENT_PROVIDERS.includes(value as ByokAgentProviderId);
}

const MODEL_ID = /^[a-zA-Z0-9._-]{1,200}$/;
/** Ids each API-key provider can own; a saved id outside them belongs elsewhere. */
const BYOK_MODEL_ID: Readonly<Record<ByokAgentProviderId, RegExp>> = {
  deepseek: /^deepseek-/,
  anthropic: /^claude-/,
  openai: /^gpt-\d/,
};
/**
 * OpenAI lists every model the key can reach. The Agent speaks Responses with
 * reasoning and function tools, so it offers GPT-5 and later text models and
 * leaves out dated snapshots and audio, image, search, embedding, chat-only,
 * coding and approval-gated specialist families.
 */
const OPENAI_EXCLUDED_PART =
  /^(?:audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation|live|chat|codex|cyber|rosalind|research|deep|daybreak|preview)$/;
// Missing metadata never inherits a large window from an older model; every
// model these providers currently list for agent use accepts at least this much.
const UNKNOWN_CONTEXT_TOKENS = 128_000;
const UNKNOWN_ANTHROPIC_OUTPUT_TOKENS = 32_000;

export function isAgentModelForProvider(provider: ByokAgentProviderId, id: string): boolean {
  if (!MODEL_ID.test(id) || !BYOK_MODEL_ID[provider].test(id)) return false;
  if (provider !== 'openai') return true;
  const [, major] = /^gpt-(\d+)/.exec(id) ?? [];
  if (Number(major) < 5 || /-\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  return !id.split('-').slice(1).some((part) => OPENAI_EXCLUDED_PART.test(part));
}

function knownByokModel(provider: ByokAgentProviderId, id: string): AgentProviderModelOption | undefined {
  return AGENT_PROVIDER_OPTIONS.find((candidate) => candidate.value === provider)!.models
    .find((model) => model.value === id)
    ?? LEGACY_PROVIDER_MODELS[provider].find((model) => model.value === id);
}

function wireSuffix(provider: ByokAgentProviderId): string {
  return provider === 'anthropic' ? 'messages' : provider === 'openai' ? 'responses' : 'agent';
}

/** The profile of an id the provider listed or a choice saved before its list arrived. */
function byokModelOption(
  provider: ByokAgentProviderId,
  id: string,
  listed?: ByokListedModel,
): AgentProviderModelOption {
  const known = knownByokModel(provider, id);
  const label = known?.label ?? listed?.displayName ?? id;
  const short = known?.short ?? listed?.displayName ?? id;
  if (provider !== 'anthropic' || !listed) {
    if (known) return known;
    return {
      value: id,
      label,
      short,
      context: profile(
        `${id}:${wireSuffix(provider)}-listed-v1`,
        UNKNOWN_CONTEXT_TOKENS,
        provider === 'anthropic' ? UNKNOWN_ANTHROPIC_OUTPUT_TOKENS : null,
        provider === 'anthropic' ? 768 : provider === 'openai' ? 640 : 512,
      ),
      reasoning: provider === 'deepseek'
        ? DEEPSEEK_REASONING
        // Not every listed model accepts reasoning off (`none` / disabled thinking).
        : reasoningProfile(['adaptive'], ['low', 'medium', 'high']),
      ...(provider === 'anthropic' ? { forcedToolChoice: false } : {}),
    };
  }
  // The Anthropic Models API publishes limits and capabilities; they win over
  // a bundled profile so a provider change reaches the wire without a release.
  const efforts = listed.efforts
    ? FULL_EFFORTS.filter((effort) => listed.efforts!.includes(effort))
    : listed.adaptiveThinking ? ['low', 'medium', 'high'] as const : [];
  const adaptive = listed.adaptiveThinking ?? known?.reasoning.thinkingModes.includes('adaptive') ?? false;
  const reasoning = !adaptive
    ? reasoningProfile(['off'], efforts)
    // Thinking stays on for listed adaptive models (the newest reject turning
    // it off); a bundled profile that allows off keeps it.
    : known?.reasoning.thinkingModes.includes('off')
      ? reasoningProfile(['off', 'adaptive'], efforts)
      : reasoningProfile(['adaptive'], efforts);
  const contextWindow = listed.contextWindow ?? known?.context.contextWindowTokens ?? UNKNOWN_CONTEXT_TOKENS;
  const maxOutput = listed.maxOutputTokens ?? known?.context.maxOutputTokens ?? UNKNOWN_ANTHROPIC_OUTPUT_TOKENS;
  return {
    value: id,
    label,
    short,
    context: profile(`${id}:messages-listed-v1`, contextWindow, Math.min(maxOutput, contextWindow), 768),
    reasoning,
    forcedToolChoice: known?.forcedToolChoice ?? (known ? true : false),
  };
}

/**
 * Publishes (or clears, with null) one API-key provider's own model list.
 * Bundled models the provider lists keep the bundled order and come first;
 * other listed models follow, newest first where the provider dates them.
 */
export function setByokModelCatalog(
  provider: ByokAgentProviderId,
  models: readonly ByokListedModel[] | null,
): void {
  const listed = models?.filter((model) => isAgentModelForProvider(provider, model.id));
  if (!listed?.length) {
    byokModels.delete(provider);
    return;
  }
  const bundled = AGENT_PROVIDER_OPTIONS.find((candidate) => candidate.value === provider)!.models;
  const rank = (model: ByokListedModel) => {
    const index = bundled.findIndex((candidate) => candidate.value === model.id);
    return index === -1 ? bundled.length : index;
  };
  const ordered = listed
    .map((model, index) => ({ model, index }))
    .sort((a, b) => rank(a.model) - rank(b.model)
      || (b.model.created ?? 0) - (a.model.created ?? 0)
      || a.index - b.index)
    .map(({ model }) => byokModelOption(provider, model.id, model));
  byokModels.set(provider, Object.freeze(ordered));
}

/** The provider's own list is the current offer (not the bundled fallback). */
export function hasListedAgentModels(provider: AgentProviderId): boolean {
  return isByokAgentProvider(provider) ? byokModels.has(provider) : Boolean(codexModels?.length);
}

export function isCodexModelSelection(value: unknown): value is string {
  // Preserve a saved remote model across restarts and catalog outages, while
  // rejecting identifiers owned by a different certified provider.
  return typeof value === 'string' && MODEL_ID.test(value)
    && !BYOK_MODEL_ID.deepseek.test(value) && !BYOK_MODEL_ID.anthropic.test(value);
}

/**
 * Whether `value` is a model id `provider` can own, listed yet or not. A saved
 * choice survives restarts and list outages; the provider stays the authority
 * on whether the key may use it, and a rejected send reports that explicitly.
 */
export function isAgentProviderModelSelection(
  provider: AgentProviderId,
  value: unknown,
): value is string {
  if (provider === 'openai-codex') return isCodexModelSelection(value);
  return typeof value === 'string'
    && (isAgentModelForProvider(provider, value) || knownByokModel(provider, value) !== undefined);
}

export function agentProviderModelOption(
  provider: AgentProviderId,
  model: string,
): AgentProviderModelOption {
  const option = agentProviderOption(provider);
  const listed = option.models.find((candidate) => candidate.value === model);
  if (listed) return listed;
  if (isByokAgentProvider(provider) && isAgentProviderModelSelection(provider, model)) {
    return byokModelOption(provider, model);
  }
  return provider === 'openai-codex' && isCodexModelSelection(model) ? {
    value: model, label: model, short: model,
    context: profile(`${model}:responses-codex-unresolved-v2`, 32_768, null, 640),
    // Keep persisted controls intact until fresh metadata is available.
    reasoning: reasoningProfile(['off', 'adaptive'], CODEX_EFFORTS),
  } : option.models[0]!;
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
  const bundled = AGENT_PROVIDER_OPTIONS.find((candidate) => candidate.value === provider)
    ?? AGENT_PROVIDER_OPTIONS[0]!;
  const listed = isByokAgentProvider(provider) ? byokModels.get(provider) : undefined;
  return listed ? { value: bundled.value, label: bundled.label, models: listed } : bundled;
}

export function normalizeAgentProviderModel(
  provider: AgentProviderId,
  value: unknown,
): string {
  const model = typeof value === 'string' ? MODEL_ALIASES[provider]?.[value] ?? value : value;
  if (isAgentProviderModelSelection(provider, model)) return model;
  return agentProviderOption(provider).models[0]!.value;
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

/** Providers whose certified Agent wire contract accepts image input. */
export function agentProviderAcceptsImages(provider: unknown): boolean {
  return provider === 'openai' || provider === 'openai-codex' || provider === 'anthropic';
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return AGENT_PROVIDER_OPTIONS.some((candidate) => candidate.value === value);
}
