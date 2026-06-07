// Records one Shadow LLM call's token usage to the LOCAL ai_usage table — the
// client-side half of the usage design (hosted calls are metered on the server;
// local/direct calls are captured here). Fire-and-forget: usage accounting must
// never break or slow a Shadow run.
import { shadowRoutesViaProxy } from '../ai/client/build-default-client';
import { shadowProviderForModel } from './model-routing';
import { useSettingsStore } from '../../store/settings-store';
import { useProjectStore } from '../../store/project-store';
import { createAiUsageRepository } from '../../sqlite-repo/ai-usage-repo';
import type { AIUsage } from '../ai/types';

export function recordShadowUsage(feature: string, model: string, usage: AIUsage | undefined): void {
  // Record ONLY calls that actually ran locally. When this Shadow call routed
  // through the hosted proxy, the server metered it — recording here too would
  // double-count. Gating on shadowRoutesViaProxy() (the same predicate the client
  // factory used) means byok stays local even on a proxy build.
  if (shadowRoutesViaProxy() || !usage) return;
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  const credentialsMode = useSettingsStore.getState().shadowAiMode;
  void createAiUsageRepository()
    .record({
      projectId,
      feature,
      provider: shadowProviderForModel(model),
      model,
      credentialsMode,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedTokens: usage.cachedTokens ?? 0,
    })
    .catch(() => {
      /* never let usage recording surface an error into the Shadow run */
    });
}
