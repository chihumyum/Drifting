import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_SEARCH_DEFAULT,
  migrateAgentToolSearch,
  normalizeAgentToolSearch,
  useSettingsStore,
} from './settings-store';

describe('General Agent product settings', () => {
  it('starts fresh installations with bounded automatic tool search', () => {
    expect(AGENT_TOOL_SEARCH_DEFAULT).toBe('auto');
    expect(useSettingsStore.getInitialState().agentToolSearch).toBe('auto');
  });

  it.each(['off', 'auto', 'on'] as const)(
    'preserves an explicit persisted %s choice',
    (value) => {
      expect(normalizeAgentToolSearch(value)).toBe(value);
    },
  );

  it('uses auto only when the persisted value is absent or invalid', () => {
    expect(normalizeAgentToolSearch(undefined)).toBe('auto');
    expect(normalizeAgentToolSearch('legacy-value')).toBe('auto');
  });

  it('moves pre-v20 installations off the legacy all-schema default once', () => {
    expect(migrateAgentToolSearch('off', 19)).toBe('auto');
    expect(migrateAgentToolSearch('off', 20)).toBe('off');
    expect(migrateAgentToolSearch('on', 20)).toBe('on');
  });
});
