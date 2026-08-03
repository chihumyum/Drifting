// Shadow model routing — the single place that turns the user's Shadow settings
// (legacy hosted tier OR explicit BYOK provider+model) into a concrete route for
// BOTH the chapter-CI review judge and the element-arc derivation.
//
// Hosted tiers (低/中/高) map to concrete models here; BYOK freezes Shadow's
// explicit provider + model pair. Credentials are not Shadow-owned: every local
// AI surface resolves the same `byok.<provider>` Keychain entry.
import { shadowRoutesViaProxy } from '../ai/client/build-default-client';
import { AIError } from '../ai/types';
import { useSettingsStore, type ModelTier } from '../../store/settings-store';
import {
  AGENT_PROVIDER_OPTIONS,
  normalizeAgentProvider,
  normalizeAgentProviderModel,
  resolveAgentProviderReasoningProfile,
  type AgentProviderId,
} from '../agent/runtime/agent-provider-contract';

/**
 * Hosted capability tier → concrete model. Per the product decision:
 *   低 (lite)     → DeepSeek Flash   — speed-first, fine for most checks/arcs
 *   中 (standard) → DeepSeek Pro     — default; steadier reasoning, fewer format misses
 *   高 (pro)      → Sonnet           — strongest judgment; server-routed (hosted proxy)
 * Hosted mode is a separate product route: even though BYOK can call Anthropic
 * locally, a hosted tier only runs through the hosted proxy.
 * `ensureShadowModelRoutable` enforces that boundary.
 */
export const SHADOW_TIER_MODEL: Record<ModelTier, string> = {
  lite: 'deepseek-v4-flash',
  standard: 'deepseek-v4-pro',
  pro: 'claude-sonnet-4-6',
};

/** Legacy hosted-tier catalog retained for persisted settings and future hosted routing. */
export const SHADOW_TIERS: {
  value: ModelTier;
  kicker: string;
  name: string;
  desc: string;
  /** true = the resolved model only runs through the hosted proxy (no local route). */
  needsHosted?: boolean;
}[] = [
  {
    value: 'lite',
    kicker: '低 · LITE',
    name: 'DeepSeek Flash',
    desc: '速度优先。够用的连贯核查与弧线分析。',
  },
  {
    value: 'standard',
    kicker: '中 · STANDARD',
    name: 'DeepSeek Pro',
    desc: '默认。更稳的推理，更少的格式失败。',
  },
  {
    value: 'pro',
    kicker: '高 · PRO',
    name: 'Sonnet',
    desc: '最强判断力。需托管订阅（服务端调用）。',
    needsHosted: true,
  },
];

/** Shadow uses the same certified provider/model catalog as General Agent. */
export const SHADOW_PROVIDER_OPTIONS = AGENT_PROVIDER_OPTIONS;

export interface ShadowModelChoice {
  provider: AgentProviderId;
  model: string;
  /** Whether the selected model has a certified native reasoning mode. */
  thinking: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Resolve the model Shadow features should call, from the live settings.
 * - BYOK: the user's chosen model (empty → DeepSeek Flash, a safe routable default).
 * - Hosted: the tier's concrete model from SHADOW_TIER_MODEL.
 */
export function resolveShadowModel(): ShadowModelChoice {
  const s = useSettingsStore.getState();
  if (s.shadowAiMode === 'byok') {
    const provider = normalizeAgentProvider(s.shadowByokProvider);
    const model = normalizeAgentProviderModel(provider, s.shadowByokModel);
    const reasoning = resolveAgentProviderReasoningProfile(provider, model);
    return {
      provider,
      model,
      thinking: reasoning.thinkingModes.includes('adaptive'),
      ...(reasoning.efforts.length > 0 ? { effort: reasoning.defaultEffort } : {}),
    };
  }
  const model = SHADOW_TIER_MODEL[s.shadowTier] ?? SHADOW_TIER_MODEL.standard;
  const provider = shadowProviderForModel(model);
  return {
    provider: provider === 'unknown' || provider === 'google' ? 'deepseek' : provider,
    model,
    thinking: true,
    effort: 'high',
  };
}

/** Which provider's namespace a model id belongs to (by prefix). */
export function shadowProviderForModel(model: string): AgentProviderId | 'google' | 'unknown' {
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  return 'unknown';
}

/**
 * Fail loudly (instead of silently downgrading) when the chosen model can't be
 * reached on the current transport. Every BYOK choice comes from the certified
 * shared provider catalog and routes locally. A hosted-only tier still needs the
 * hosted proxy; without it, fail before any provider silently rewrites a model.
 */
export function ensureShadowModelRoutable(choice: ShadowModelChoice): void {
  if (useSettingsStore.getState().shadowAiMode === 'byok') return;
  if (shadowRoutesViaProxy()) return;
  throw new AIError(
    'invalid-input',
    `Shadow 模型 ${choice.model} 需要托管代理，但当前构建没有可用的托管模型服务。` +
      `请改用 BYOK provider，或在支持托管模型的构建中重试。`,
  );
}
