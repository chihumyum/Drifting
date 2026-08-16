/**
 * Renderer-local structured Copilot execution.
 *
 * Prompt construction, schema validation, provider selection, and inference
 * all happen on the author's device. The only network hop is the explicitly
 * selected BYOK provider; no Drifting account or hosted API participates.
 */
import type { Static, TSchema } from '@sinclair/typebox';

import { useSettingsStore, type LocaleCode } from '../../store/settings-store';
import type { CopilotRuntime } from '../copilot/capability';
import { copilotRuntime } from '../copilot/runtime';
import { callStructured } from './call-structured';
import type { LLMClient } from './client/llm-client';
import { resolveCopilotModel } from './copilot-route';
import type { PromptDef } from './prompts/define-prompt';

export {
  COPILOT_DEFAULT_MODEL_BY_PROVIDER,
  resolveCopilotModel,
} from './copilot-route';

export interface RunStructuredOptions {
  signal?: AbortSignal;
  /** Override the author's selected model for this call. */
  model?: string;
  /** Project id used to resolve the per-project output-language preference. */
  projectId?: string;
  /** Capability-injected runtime, primarily for deterministic tests. */
  runtime?: Pick<CopilotRuntime, 'getClient'>;
  /** Lowest-level test seam. Production callers normally use runtime. */
  client?: LLMClient;
}

const OUTPUT_LANGUAGE_NAMES: Record<LocaleCode, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (Français)',
};

export function resolveCopilotOutputLanguage(projectId?: string): string {
  const state = useSettingsStore.getState();
  const selected = projectId ? state.copilotOutputLangByProject[projectId] : undefined;
  const locale = !selected || selected === 'auto' ? state.manuscriptLocale : selected;
  return OUTPUT_LANGUAGE_NAMES[locale];
}

export async function runStructured<
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
>(
  prompt: PromptDef<TInputSchema, TOutputSchema>,
  input: Static<TInputSchema>,
  options: RunStructuredOptions = {},
): Promise<Static<TOutputSchema>> {
  const settings = useSettingsStore.getState();
  const provider = settings.copilotByokProvider;
  const model = resolveCopilotModel(provider, settings.copilotByokModel, options.model);
  const client =
    options.client ?? (await (options.runtime ?? copilotRuntime).getClient(provider));

  return callStructured(client, prompt, input, {
    signal: options.signal,
    model,
    outputLanguage: resolveCopilotOutputLanguage(options.projectId),
  });
}
