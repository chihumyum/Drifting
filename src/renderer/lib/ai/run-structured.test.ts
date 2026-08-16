import { Type } from '@sinclair/typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../store/settings-store';
import { LLMClient } from './client/llm-client';
import type { LLMProvider } from './client/providers/provider';
import { definePrompt } from './prompts/define-prompt';
import {
  COPILOT_DEFAULT_MODEL_BY_PROVIDER,
  resolveCopilotModel,
  resolveCopilotOutputLanguage,
  runStructured,
} from './run-structured';
import type { AICompletionRequest } from './types';

const prompt = definePrompt({
  id: 'route-probe',
  version: 1,
  model: 'prompt-default-must-not-win',
  description: 'Synthetic route probe.',
  input: Type.Object({ text: Type.String() }),
  output: Type.Object({ answer: Type.String() }),
  buildSystem: ({ text }) => `Inspect ${text}.`,
  buildUserMessage: ({ text }) => text,
});

let original: Pick<
  ReturnType<typeof useSettingsStore.getState>,
  | 'copilotByokProvider'
  | 'copilotByokModel'
  | 'manuscriptLocale'
  | 'copilotOutputLangByProject'
>;

beforeEach(() => {
  const state = useSettingsStore.getState();
  original = {
    copilotByokProvider: state.copilotByokProvider,
    copilotByokModel: state.copilotByokModel,
    manuscriptLocale: state.manuscriptLocale,
    copilotOutputLangByProject: state.copilotOutputLangByProject,
  };
});

afterEach(() => {
  useSettingsStore.setState(original);
});

describe('renderer-local structured Copilot routing', () => {
  it('resolves call override, configured model, then provider-local default', () => {
    expect(resolveCopilotModel('deepseek', 'saved-model', 'call-model')).toBe('call-model');
    expect(resolveCopilotModel('anthropic', ' saved-model ')).toBe('saved-model');
    expect(resolveCopilotModel('google', '  ')).toBe(
      COPILOT_DEFAULT_MODEL_BY_PROVIDER.google,
    );
  });

  it('passes the resolved model and per-project output language to callStructured', async () => {
    const requests: AICompletionRequest[] = [];
    const provider: LLMProvider = {
      id: 'test-provider',
      async complete(request) {
        requests.push(request);
        return {
          toolCall: { name: 'return_route_probe', arguments: { answer: 'ok' } },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    useSettingsStore.setState({
      copilotByokProvider: 'deepseek',
      copilotByokModel: 'saved-model',
      manuscriptLocale: 'en',
      copilotOutputLangByProject: { project: 'zh-TW' },
    });
    const getClient = vi.fn(async () => new LLMClient(provider));

    await expect(
      runStructured(prompt, { text: 'sample' }, {
        runtime: { getClient },
        model: 'call-model',
        projectId: 'project',
      }),
    ).resolves.toEqual({ answer: 'ok' });

    expect(requests).toHaveLength(1);
    expect(getClient).toHaveBeenCalledWith('deepseek');
    expect(requests[0]?.model).toBe('call-model');
    expect(requests[0]?.system).toContain('Traditional Chinese (繁體中文)');
    expect(resolveCopilotOutputLanguage()).toBe('English');
  });
});
