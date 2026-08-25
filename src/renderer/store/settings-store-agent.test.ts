import { describe, expect, it } from 'vitest';
import {
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
    expect(useSettingsStore.getInitialState().agentMaxContext).toBe(false);
    expect(useSettingsStore.getInitialState().agentAllowDangerousOperations).toBe(false);
  });

  it('persists Max as an explicit user-controlled Agent setting', () => {
    useSettingsStore.getState().setAgentMaxContext(true);
    expect(useSettingsStore.getState().agentMaxContext).toBe(true);
    useSettingsStore.getState().setAgentMaxContext(false);
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
