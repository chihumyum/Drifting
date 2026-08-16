import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSettingsStore } from './settings-store';

let original: Pick<
  ReturnType<typeof useSettingsStore.getState>,
  | 'copilotByokProvider'
  | 'copilotByokModel'
  | 'copilotOutputLangByProject'
  | 'lastAgentConvByProject'
>;

beforeEach(() => {
  const state = useSettingsStore.getState();
  original = {
    copilotByokProvider: state.copilotByokProvider,
    copilotByokModel: state.copilotByokModel,
    copilotOutputLangByProject: state.copilotOutputLangByProject,
    lastAgentConvByProject: state.lastAgentConvByProject,
  };
});

afterEach(() => {
  useSettingsStore.setState(original);
});

describe('Copilot provider route settings', () => {
  it('clears a provider-specific model when the provider changes', () => {
    useSettingsStore.setState({
      copilotByokProvider: 'deepseek',
      copilotByokModel: 'deepseek-v4-pro',
    });

    useSettingsStore.getState().setCopilotByokProvider('google');

    expect(useSettingsStore.getState()).toMatchObject({
      copilotByokProvider: 'google',
      copilotByokModel: '',
    });
  });

  it('preserves the selected model when the provider did not change', () => {
    useSettingsStore.setState({
      copilotByokProvider: 'google',
      copilotByokModel: 'gemini-custom',
    });

    useSettingsStore.getState().setCopilotByokProvider('google');

    expect(useSettingsStore.getState().copilotByokModel).toBe('gemini-custom');
  });

  it('removes persisted per-project Copilot and Agent pointers on project deletion', () => {
    useSettingsStore.setState({
      copilotOutputLangByProject: { deleted: 'zh-CN', kept: 'en' },
      lastAgentConvByProject: { deleted: 'conversation-a', kept: 'conversation-b' },
    });

    useSettingsStore.getState().clearProjectSettings('deleted');

    expect(useSettingsStore.getState().copilotOutputLangByProject).toEqual({ kept: 'en' });
    expect(useSettingsStore.getState().lastAgentConvByProject).toEqual({
      kept: 'conversation-b',
    });
  });
});
