import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDataStore } from './data-store';
import { useAgentActivityStore } from './agent-activity-store';
import { useAgentEditStore } from './agent-edit-store';

const initialDataState = useDataStore.getState();
const timestamp = '2026-08-02T00:00:00.000Z';
const scopeA = { sessionId: 'session-a', turnId: 'turn-a' };
const scopeB = { sessionId: 'session-b', turnId: 'turn-b' };

describe('General Agent Added activity', () => {
  beforeEach(() => {
    useAgentActivityStore.getState().clearAll();
    useAgentEditStore.getState().clearAll();
    useDataStore.setState({
      bookNodes: [
        {
          id: 'node-added',
          projectId: 'project-1',
          kind: 'drift',
          title: '潮痕',
          summary: '',
          bookOrder: null,
          narrativeOrder: 1,
          driftGroupId: null,
          writingStatus: 'drifting',
          position: { x: 0, y: 0 },
          wordCount: 8,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      bookElements: [],
      storylines: [],
      bookElementCategories: [],
    });
  });

  afterEach(() => {
    useAgentActivityStore.getState().clearAll();
    useAgentEditStore.getState().clearAll();
    useDataStore.setState(initialDataState, true);
  });

  it('persists Added presentation after the workspace create result commits', () => {
    const activity = useAgentActivityStore.getState();
    activity.onToolUse(scopeA, 'create-call', 'write_file', {
      path: '/drifts/潮痕/prose.md',
      content: '潮水退去。',
    });
    activity.onToolResult(
      scopeA,
      'create-call',
      true,
      JSON.stringify({
        path: '/drifts/潮痕/prose.md',
        operation: 'created',
        updated: true,
      }),
    );

    expect(useAgentEditStore.getState().additions['node:node-added']).toEqual({
      entityType: 'node',
      id: 'node-added',
      revealBlockIds: null,
    });
    expect(useAgentActivityStore.getState().touched['node:node-added']?.op).toBe('create');
  });

  it('keeps a sibling session pulse when another turn with the same call id finishes', () => {
    const activity = useAgentActivityStore.getState();
    const input = { path: '/drifts/潮痕/prose.md', content: '潮水退去。' };
    activity.onToolUse(scopeA, 'same-provider-call', 'write_file', input);
    activity.onToolUse(scopeB, 'same-provider-call', 'write_file', input);

    activity.onTurnEnd(scopeA);
    expect(useAgentActivityStore.getState().active['node:node-added']).toBeDefined();

    activity.onTurnEnd(scopeB);
    expect(useAgentActivityStore.getState().active['node:node-added']).toBeUndefined();
  });
});
