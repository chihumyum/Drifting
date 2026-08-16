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
      bookElements: [
        {
          id: 'element-ada',
          projectId: 'project-1',
          categoryId: null,
          name: '艾达',
          summary: '',
          contentJson: '{}',
          kvJson: '[]',
          aliases: [],
          groupName: null,
          portraitAssetId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      storylines: [],
      bookElementCategories: [],
      comments: [],
      entityRelations: [
        {
          id: 'relation-1',
          projectId: 'project-1',
          fromKind: 'node',
          fromId: 'node-added',
          toKind: 'element',
          toId: 'element-ada',
          relationTypeId: 'relation-type-1',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
  });

  afterEach(() => {
    useAgentActivityStore.getState().clearAll();
    useAgentEditStore.getState().clearAll();
    useDataStore.setState(initialDataState, true);
  });

  it('persists Added presentation after the workspace create result commits', () => {
    const activity = useAgentActivityStore.getState();
    activity.onToolUse(scopeA, 'create-call', 'create_inspiration', {
      title: '潮痕',
      body: '潮水退去。',
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
    const input = {
      inspiration: '潮痕',
      changes: [{ currentText: '潮水', revisedText: '海水' }],
    };
    activity.onToolUse(scopeA, 'same-provider-call', 'revise_inspiration', input);
    activity.onToolUse(scopeB, 'same-provider-call', 'revise_inspiration', input);

    activity.onTurnEnd(scopeA);
    expect(useAgentActivityStore.getState().active['node:node-added']).toBeDefined();

    activity.onTurnEnd(scopeB);
    expect(useAgentActivityStore.getState().active['node:node-added']).toBeUndefined();
  });

  it('flashes and leaves M on an anchored comment host without recording A', () => {
    const activity = useAgentActivityStore.getState();
    activity.onToolUse(scopeA, 'comment-call', 'create_comment', {
      body: '核对这一处。',
      targetType: 'inspiration',
      targetName: '潮痕',
      targetText: '潮水退去。',
    });

    expect(useAgentActivityStore.getState().active['node:node-added']).toBeDefined();
    activity.onToolResult(scopeA, 'comment-call', true, '{}');
    expect(useAgentActivityStore.getState().touched['node:node-added']).toMatchObject({
      op: 'write',
    });
    expect(useAgentEditStore.getState().additions).toEqual({});
  });

  it('retains both relation endpoints through deletion so each receives M', () => {
    const activity = useAgentActivityStore.getState();
    activity.onToolUse(scopeA, 'relation-call', 'delete_relation', {
      relationId: 'relation-1',
    });

    expect(Object.keys(useAgentActivityStore.getState().active).sort()).toEqual([
      'element:element-ada',
      'node:node-added',
    ]);
    // The committed delete removes the relation before tool_result reaches the
    // perception store; preflight refs must still drive the successful M marks.
    useDataStore.setState({ entityRelations: [] });
    activity.onToolResult(scopeA, 'relation-call', true, '{}');
    expect(Object.keys(useAgentActivityStore.getState().touched).sort()).toEqual([
      'element:element-ada',
      'node:node-added',
    ]);
    expect(useAgentEditStore.getState().additions).toEqual({});
  });
});
