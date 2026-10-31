import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

import {
  agentOnboardingStepForExistingInstall,
  AGENT_TOOL_SEARCH_DEFAULT,
  AGENT_TURN_ITERATION_LIMIT_DEFAULT,
  migrateAgentToolSearch,
  normalizeAgentTurnIterationLimit,
  normalizeAgentToolSearch,
  useSettingsStore,
} from './settings-store';

describe('General Agent product settings', () => {
  it('starts fresh installations with bounded automatic tool search', () => {
    expect(AGENT_TOOL_SEARCH_DEFAULT).toBe('auto');
    expect(useSettingsStore.getInitialState().agentToolSearch).toBe('auto');
    expect(useSettingsStore.getInitialState().agentAllowDangerousOperations).toBe(false);
  });

  it.each([false, true])('retires a persisted Max preference of %s', (agentMaxContext) => {
    const current = useSettingsStore.getInitialState();
    const merged = useSettingsStore.persist.getOptions().merge!({
      agentMaxContext, agentProvider: 'openai', agentModel: 'gpt-5.6-sol',
    }, current);
    expect(merged).not.toHaveProperty('agentMaxContext');
    expect(merged).not.toHaveProperty('setAgentMaxContext');
    expect(merged).toMatchObject({ agentProvider: 'openai', agentModel: 'gpt-5.6-sol' });
  });

  it('shows the Agent first run to fresh installations and to existing ones that never used the Agent', () => {
    expect(useSettingsStore.getInitialState().agentOnboardingStep).toBe('new');
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    expect(migrate({ lastAgentConvByProject: {} }, 32)).toMatchObject({ agentOnboardingStep: 'new' });
    expect(migrate({ lastAgentConvByProject: { p1: 'c1' } }, 32)).toMatchObject({ agentOnboardingStep: 'done' });
    expect(agentOnboardingStepForExistingInstall(undefined)).toBe('new');
  });

  it('keeps a stored first-run step and repairs an unknown one', () => {
    const current = useSettingsStore.getInitialState();
    const merge = useSettingsStore.persist.getOptions().merge!;
    expect(merge({ agentOnboardingStep: 'change' }, current)).toMatchObject({ agentOnboardingStep: 'change' });
    expect(merge({ agentOnboardingStep: 'later' }, current)).toMatchObject({ agentOnboardingStep: 'new' });
  });

  it('keeps dangerous operations opt-in', () => {
    useSettingsStore.getState().setAgentAllowDangerousOperations(true);
    expect(useSettingsStore.getState().agentAllowDangerousOperations).toBe(true);
    useSettingsStore.getState().setAgentAllowDangerousOperations(false);
  });

  it('starts fresh installations with a bounded per-turn iteration limit', () => {
    expect(useSettingsStore.getInitialState().agentTurnIterationLimit).toBe(
      AGENT_TURN_ITERATION_LIMIT_DEFAULT,
    );
  });

  it('preserves an explicit unlimited choice and rejects invalid limits', () => {
    expect(normalizeAgentTurnIterationLimit(null)).toBeNull();
    expect(normalizeAgentTurnIterationLimit(100)).toBe(100);
    expect(normalizeAgentTurnIterationLimit(0)).toBe(AGENT_TURN_ITERATION_LIMIT_DEFAULT);
    expect(normalizeAgentTurnIterationLimit(-5)).toBe(AGENT_TURN_ITERATION_LIMIT_DEFAULT);
    expect(normalizeAgentTurnIterationLimit(2.5)).toBe(AGENT_TURN_ITERATION_LIMIT_DEFAULT);
    expect(normalizeAgentTurnIterationLimit('50')).toBe(AGENT_TURN_ITERATION_LIMIT_DEFAULT);
    expect(normalizeAgentTurnIterationLimit(undefined)).toBe(AGENT_TURN_ITERATION_LIMIT_DEFAULT);
    expect(normalizeAgentTurnIterationLimit(1_000_000)).toBe(1_000);
  });

  it('clamps the setter through the same normalization', () => {
    useSettingsStore.getState().setAgentTurnIterationLimit(null);
    expect(useSettingsStore.getState().agentTurnIterationLimit).toBeNull();
    useSettingsStore.getState().setAgentTurnIterationLimit(-1);
    expect(useSettingsStore.getState().agentTurnIterationLimit).toBe(
      AGENT_TURN_ITERATION_LIMIT_DEFAULT,
    );
  });

  it.each(['off', 'auto', 'on'] as const)('preserves an explicit persisted %s choice', (value) => {
    expect(normalizeAgentToolSearch(value)).toBe(value);
  });

  it('uses auto only when the persisted value is absent or invalid', () => {
    expect(normalizeAgentToolSearch(undefined)).toBe('auto');
    expect(normalizeAgentToolSearch('legacy-value')).toBe('auto');
  });

  it('moves pre-v20 installations off the legacy all-schema default once', () => {
    expect(migrateAgentToolSearch('off', 19)).toBe('auto');
    expect(migrateAgentToolSearch('off', 20)).toBe('off');
    expect(migrateAgentToolSearch('on', 20)).toBe('on');
  });

  it('keeps provider, model, thinking and effort inside one certified profile', () => {
    const before = useSettingsStore.getState();
    const original = {
      agentProvider: before.agentProvider,
      agentModel: before.agentModel,
      agentThinking: before.agentThinking,
      agentEffort: before.agentEffort,
    };
    try {
      useSettingsStore.setState({
        agentProvider: 'anthropic',
        agentModel: 'claude-haiku-4-5-20251001',
        agentThinking: 'off',
        agentEffort: 'high',
      });
      useSettingsStore.getState().setAgentThinking('adaptive');
      expect(useSettingsStore.getState().agentThinking).toBe('off');

      useSettingsStore.getState().setAgentProvider('openai');
      expect(useSettingsStore.getState()).toMatchObject({
        agentProvider: 'openai',
        agentModel: 'gpt-5.6-sol',
      });
      useSettingsStore.getState().setAgentThinking('adaptive');
      useSettingsStore.getState().setAgentEffort('low');
      expect(useSettingsStore.getState()).toMatchObject({
        agentThinking: 'adaptive',
        agentEffort: 'low',
      });

      useSettingsStore.getState().setAgentProvider('deepseek');
      expect(useSettingsStore.getState()).toMatchObject({
        agentModel: 'deepseek-v4-flash',
        agentThinking: 'adaptive',
        agentEffort: 'high',
      });
    } finally {
      useSettingsStore.setState(original);
    }
  });

});
