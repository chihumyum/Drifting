import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDataStore } from '../../store/data-store';
import { collectTurnEntityRefs, toolEntityRef, toolEntityRefs } from './tool-entity-ref';

const initialDataState = useDataStore.getState();
const timestamp = '2026-08-02T00:00:00.000Z';

describe('workspace Agent entity activity projection', () => {
  beforeEach(() => {
    useDataStore.setState({
      bookNodes: [
        {
          id: 'node-added',
          projectId: 'project-1',
          kind: 'chapter',
          title: '雨/城',
          summary: '',
          bookOrder: 1,
          narrativeOrder: null,
          driftGroupId: null,
          writingStatus: 'draft',
          position: { x: 0, y: 0 },
          wordCount: 12,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      bookElements: [
        {
          id: 'element-ada',
          projectId: 'project-1',
          categoryId: 'category-people',
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
      storylines: [
        {
          id: 'storyline-main',
          projectId: 'project-1',
          name: '主线',
          color: '#888888',
          summary: '',
          orderKey: 1,
          contentJson: '{}',
          kvJson: '[]',
          nodeContentTemplateJson: '{}',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      bookElementCategories: [
        {
          id: 'category-people',
          projectId: 'project-1',
          name: '人物',
          contentJson: '{}',
          elementTemplateJson: '{}',
          elementTemplateKvJson: '[]',
          color: '#777777',
          layoutMode: 'auto',
          gridX: null,
          gridY: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      comments: [
        {
          id: 'comment-1',
          projectId: 'project-1',
          kind: 'note',
          targetKind: 'node',
          targetId: 'node-added',
          targetBlockId: 'block-1',
          anchorJson: '{}',
          authorKind: 'ai',
          authorId: null,
          authorName: 'General Agent',
          bodyJson: '{}',
          status: 'open',
          priority: null,
          source: 'api',
          metadataJson: null,
          targetBlockIdsJson: '["block-1"]',
          resolvedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
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
    useDataStore.setState(initialDataState, true);
  });

  it('maps a successful create_chapter result to an Added node', () => {
    expect(
      toolEntityRef(
        'create_chapter',
        { title: '雨城', body: '雨落。' },
        JSON.stringify({
          path: '/chapters/雨%2F城/prose.md',
          operation: 'created',
          updated: true,
        }),
      ),
    ).toEqual({
      entityType: 'node',
      id: 'node-added',
      op: 'create',
      spots: { structural: true },
    });
  });

  it('keeps an existing chapter revision classified as Modified', () => {
    expect(
      toolEntityRef(
        'revise_chapter',
        { chapter: '雨/城', changes: [{ currentText: '雨', revisedText: '雪' }] },
        JSON.stringify({
          path: '/chapters/雨%2F城/prose.md',
          replacements: 1,
          updated: true,
        }),
      ),
    ).toMatchObject({
      entityType: 'node',
      id: 'node-added',
      op: 'write',
    });
  });

  it('maps public comment targets and existing comment mutations to the host as Modified', () => {
    expect(
      toolEntityRefs('create_comment', {
        body: '核对伏笔。',
        targetType: 'chapter',
        targetName: '雨/城',
        targetText: '雨落。',
      }),
    ).toEqual([
      {
        entityType: 'node',
        id: 'node-added',
        op: 'write',
        spots: { structural: true },
      },
    ]);
    expect(toolEntityRefs('update_comment', { commentId: 'comment-1' })).toMatchObject([
      { entityType: 'node', id: 'node-added', op: 'write' },
    ]);
    expect(toolEntityRefs('delete_comment', { commentId: 'comment-1' })).toMatchObject([
      { entityType: 'node', id: 'node-added', op: 'write' },
    ]);
    expect(toolEntityRefs('create_comment', { body: '项目级批注。' })).toEqual([]);
  });

  it('maps relation writes to both endpoint entities without producing Added', () => {
    const created = toolEntityRefs('create_relation', {
      fromType: 'chapter',
      fromName: '雨/城',
      toType: 'element',
      toName: '艾达',
      relationType: '出场',
    });
    expect(created).toMatchObject([
      { entityType: 'node', id: 'node-added', op: 'write' },
      { entityType: 'element', id: 'element-ada', op: 'write' },
    ]);
    expect(toolEntityRefs('update_relation', { relationId: 'relation-1' })).toEqual(created);
    expect(toolEntityRefs('delete_relation', { relationId: 'relation-1' })).toEqual(created);
    expect(created.every((ref) => ref.op !== 'create')).toBe(true);
  });

  it('includes both relation endpoints in the latest-turn changed links', () => {
    expect(
      collectTurnEntityRefs([
        { kind: 'user' },
        {
          kind: 'tool',
          name: 'create_relation',
          status: 'ok',
          input: {
            fromType: 'chapter',
            fromName: '雨/城',
            toType: 'element',
            toName: '艾达',
          },
          result: '{}',
        },
      ]),
    ).toMatchObject([
      { entityType: 'node', id: 'node-added', op: 'write' },
      { entityType: 'element', id: 'element-ada', op: 'write' },
    ]);
  });
});
