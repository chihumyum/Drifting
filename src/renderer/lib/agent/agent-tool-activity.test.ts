import { describe, expect, it } from 'vitest';

import {
  describeAgentPermissionAction,
  describeAgentToolActivity,
  shouldDisplayAgentToolActivity,
} from './agent-tool-activity';

describe('author-facing Agent tool activity', () => {
  it('waits for real streamed arguments instead of rendering a fallback placeholder', () => {
    expect(
      shouldDisplayAgentToolActivity({ phase: 'arguments', toolInput: undefined }),
    ).toBe(false);
    expect(
      shouldDisplayAgentToolActivity({
        phase: 'arguments',
        toolInput: undefined,
        status: 'error',
      }),
    ).toBe(true);
    expect(
      shouldDisplayAgentToolActivity({ phase: 'ready', toolInput: { path: '/chapters' } }),
    ).toBe(true);
    expect(
      shouldDisplayAgentToolActivity({ phase: undefined, toolInput: undefined }),
    ).toBe(true);
  });

  it('describes explicit domain reads without storage vocabulary', () => {
    expect(describeAgentToolActivity('get_project_overview', {}, 'zh-CN')).toBe('了解作品全貌');
    expect(describeAgentToolActivity('list_inspirations', {}, 'zh-CN')).toBe('查看灵感列表');
    expect(
      describeAgentToolActivity('read_inspiration', { inspiration: '灵感碎片' }, 'zh-CN'),
    ).toBe('阅读灵感「灵感碎片」');
    expect(
      describeAgentToolActivity(
        'read_element',
        { element: '麦可森·雷都' },
        'zh-CN',
      ),
    ).toBe('查看写作要素「麦可森·雷都」');
  });

  it('describes search and writes from their narrow domain arguments', () => {
    expect(describeAgentToolActivity('search_prose', { query: '收费站' }, 'zh-CN')).toBe(
      '检索正文“收费站”',
    );
    expect(
      describeAgentToolActivity('revise_chapter', { chapter: '00' }, 'zh-CN'),
    ).toBe('修改章节正文「00」');
  });

  it('provides readable labels for direct domain tools', () => {
    expect(describeAgentToolActivity('update_element', { element: '留存者' }, 'zh-CN')).toBe(
      '更新写作要素「留存者」',
    );
    expect(describeAgentToolActivity('read_task_plan', {}, 'en-US')).toBe(
      'Review task progress',
    );
    expect(describeAgentToolActivity('delete_element', { element: '旧角色' }, 'zh-CN')).toBe(
      '删除写作要素「旧角色」',
    );
    expect(describeAgentToolActivity('delete_relation', { relationId: 'r-1' }, 'zh-CN')).toBe(
      '删除实体关系「r-1」',
    );
  });

  it('renders relation permission arguments as one natural-language action', () => {
    expect(
      describeAgentPermissionAction(
        'create_relation',
        {
          fromType: 'storyline',
          fromName: '潮汐下的第二个名字',
          toType: 'chapter',
          toName: '14',
          relationType: '包含章节',
        },
        'zh-CN',
      ),
    ).toEqual({
      summary: '新建实体关系：故事线「潮汐下的第二个名字」 —包含章节→ 章节「14」',
      details: [],
    });
  });

  it('shows destructive targets naturally while leaving raw JSON optional', () => {
    expect(
      describeAgentPermissionAction(
        'delete_element',
        { element: '旧角色' },
        'zh-CN',
      ),
    ).toEqual({
      summary: '删除写作要素「旧角色」',
      details: [],
    });
    expect(
      describeAgentPermissionAction(
        'delete_relation',
        { relationId: 'relation-1' },
        'en-US',
      ),
    ).toEqual({
      summary: 'Delete relationship “relation-1”',
      details: [],
    });
    expect(
      describeAgentPermissionAction(
        'replace_storyline_chapters',
        { storyline: '主线', chapters: [] },
        'zh-CN',
      ),
    ).toEqual({
      summary: '用 0 个章节替换故事线「主线」的完整成员列表',
      details: ['章节：清空成员'],
    });
  });
});
