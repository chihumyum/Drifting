import { describe, expect, it } from 'vitest';

import {
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

  it('hides virtual filesystem vocabulary behind novel-domain actions', () => {
    expect(describeAgentToolActivity('list_files', { path: '/' }, 'zh-CN')).toBe('查看作品结构');
    expect(describeAgentToolActivity('list_files', { path: '/drifts' }, 'zh-CN')).toBe('查看漂移灵感');
    expect(
      describeAgentToolActivity('read_file', { path: '/drifts/灵感碎片/prose.md' }, 'zh-CN'),
    ).toBe('阅读灵感「灵感碎片」正文');
    expect(
      describeAgentToolActivity(
        'read_file',
        { path: '/elements/人物/麦可森%C2%B7雷都/body.md' },
        'zh-CN',
      ),
    ).toBe('阅读人物「麦可森·雷都」设定正文');
  });

  it('describes search and writes semantically without exposing paths', () => {
    expect(describeAgentToolActivity('grep', { query: '收费站' }, 'zh-CN')).toBe(
      '检索小说内容“收费站”',
    );
    expect(
      describeAgentToolActivity('edit_file', { path: '/chapters/00/prose.md' }, 'zh-CN'),
    ).toBe('修改章节「00」正文');
  });

  it('provides readable labels for direct domain tools', () => {
    expect(describeAgentToolActivity('update_element', { element: '留存者' }, 'zh-CN')).toBe(
      '更新故事元素「留存者」',
    );
    expect(describeAgentToolActivity('read_task_plan', {}, 'en-US')).toBe(
      'Review task progress',
    );
    expect(describeAgentToolActivity('delete_element', { element: '旧角色' }, 'zh-CN')).toBe(
      '删除故事元素「旧角色」',
    );
    expect(describeAgentToolActivity('remove_relation', {}, 'zh-CN')).toBe(
      '移除实体关系',
    );
  });
});
