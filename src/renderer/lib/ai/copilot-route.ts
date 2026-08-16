import type { BYOKProvider } from '../byok-keychain';

/** Provider-native defaults used only when the author has not pinned a model. */
export const COPILOT_DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<BYOKProvider, string>> = {
  deepseek: 'deepseek-v4-flash',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-sol',
  google: 'gemini-2.5-flash',
};

export function resolveCopilotModel(
  provider: BYOKProvider,
  configuredModel: string,
  callOverride?: string,
): string {
  return (
    callOverride?.trim() ||
    configuredModel.trim() ||
    COPILOT_DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}
