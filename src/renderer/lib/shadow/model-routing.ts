// Shadow model routing — the single place that turns the user's Shadow settings
// (hosted tier OR BYOK provider+model) into a concrete model id for BOTH the
// chapter-CI review judge and the element-arc derivation.
//
// Hosted tiers (低/中/高) map to concrete models here; BYOK passes the user's
// chosen model straight through. The actual PROVIDER is still resolved by
// buildDefaultLLMClient (key presence) / the server proxy — this module only
// decides the model *name* and guards against asking for a model the current
// transport can't reach (e.g. Sonnet on a local direct-to-DeepSeek build).
import { isProxyTransport } from '../ai/client/build-default-client';
import { AIError } from '../ai/types';
import { useSettingsStore, type ModelTier } from '../../store/settings-store';

/**
 * Hosted capability tier → concrete model. Per the product decision:
 *   低 (lite)     → DeepSeek Flash   — speed-first, fine for most checks/arcs
 *   中 (standard) → DeepSeek Pro     — default; steadier reasoning, fewer format misses
 *   高 (pro)      → Sonnet           — strongest judgment; server-routed (hosted proxy)
 * The high tier is intentionally a non-DeepSeek model; it only runs when the
 * call goes through the hosted proxy (the renderer substrate has no Anthropic
 * provider). `ensureShadowModelRoutable` enforces that honestly.
 */
export const SHADOW_TIER_MODEL: Record<ModelTier, string> = {
  lite: 'deepseek-v4-flash',
  standard: 'deepseek-v4-pro',
  pro: 'claude-sonnet-4-6',
};

/** Display catalog for the Settings · Shadow tier cards (低/中/高). */
export const SHADOW_TIERS: {
  value: ModelTier;
  kicker: string;
  name: string;
  desc: string;
  /** true = the resolved model only runs through the hosted proxy (no local route). */
  needsHosted?: boolean;
}[] = [
  { value: 'lite', kicker: '低 · LITE', name: 'DeepSeek Flash', desc: '速度优先。够用的连贯核查与弧线分析。' },
  { value: 'standard', kicker: '中 · STANDARD', name: 'DeepSeek Pro', desc: '默认。更稳的推理，更少的格式失败。' },
  { value: 'pro', kicker: '高 · PRO', name: 'Sonnet', desc: '最强判断力。需托管订阅（服务端调用）。', needsHosted: true },
];

/**
 * BYOK model options. Scoped to DeepSeek for now — the renderer substrate routes
 * DeepSeek (and Google) directly; other providers arrive with their own provider
 * or via the hosted path. (Settings · Shadow only offers these two today.)
 */
export const SHADOW_BYOK_MODELS: { value: string; label: string }[] = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek Flash · 快' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek Pro · 稳' },
];

export interface ShadowModelChoice {
  model: string;
  /** Arc derive always wants a reasoning pass (jsonMode composes with it). */
  thinking: boolean;
}

/**
 * Resolve the model Shadow features should call, from the live settings.
 * - BYOK: the user's chosen model (empty → DeepSeek Flash, a safe routable default).
 * - Hosted: the tier's concrete model from SHADOW_TIER_MODEL.
 */
export function resolveShadowModel(): ShadowModelChoice {
  const s = useSettingsStore.getState();
  if (s.shadowAiMode === 'byok') {
    const model = s.shadowByokModel?.trim() || 'deepseek-v4-flash';
    return { model, thinking: true };
  }
  return { model: SHADOW_TIER_MODEL[s.shadowTier] ?? SHADOW_TIER_MODEL.standard, thinking: true };
}

/** Which provider's namespace a model id belongs to (by prefix). */
export function shadowProviderForModel(model: string): 'deepseek' | 'google' | 'anthropic' | 'unknown' {
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('claude-')) return 'anthropic';
  return 'unknown';
}

/**
 * Fail loudly (instead of silently downgrading) when the chosen model can't be
 * reached on the current transport. On the hosted proxy the server routes any
 * provider, so anything goes. On a local direct build the substrate only has
 * DeepSeek + Google — a Sonnet/高档 request would otherwise be silently rewritten
 * to the DeepSeek default by the provider, which is worse than a clear error.
 */
export function ensureShadowModelRoutable(model: string): void {
  if (isProxyTransport()) return; // hosted proxy routes any provider server-side
  const p = shadowProviderForModel(model);
  if (p === 'deepseek' || p === 'google') return; // substrate has these directly
  throw new AIError(
    'invalid-input',
    `「高档 · Sonnet」需要托管订阅（服务端代理）。当前为本地直连，仅支持 DeepSeek 档位。` +
      `请在 设置 · Shadow 改用「中档 · DeepSeek-Pro」，或开启托管。`,
  );
}
