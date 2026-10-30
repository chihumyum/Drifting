import { describe, expect, it } from 'vitest';
import type { CheckinChangedDocument } from '../checkin/checkin-delta';
import {
  buildOrganizeTask,
  hasOrganizableChange,
  summarizeOrganizeTranscript,
} from './organize-task';

function document(overrides: Partial<CheckinChangedDocument>): CheckinChangedDocument {
  return {
    ref: 'c1',
    entityType: 'node',
    entityId: 'node-1',
    objectKind: 'chapter',
    title: '第一章',
    lastChangedAt: '2026-10-30T08:00:00.000Z',
    revisions: { user: 3, agent: 0, remote: 0 },
    hasBaseline: true,
    digest: '+ 新来的旅人自称阿岚。',
    ...overrides,
  };
}

describe('organize task', () => {
  it('hands the Agent every changed passage with principles, not story content', () => {
    const task = buildOrganizeTask([
      document({}),
      document({ ref: 'c2', entityId: 'node-2', objectKind: 'idea', title: '雾港', hasBaseline: false, digest: '港口终年起雾。' }),
    ]);
    expect(task.title).toBe('整理：第一章 等 2 篇');
    expect(task.prompt).toContain('## 章节「第一章」\n改动：\n+ 新来的旅人自称阿岚。');
    expect(task.prompt).toContain('## 构想「雾港」\n新写的，或此前没有本地版本；节选：\n港口终年起雾。');
    expect(task.prompt).toContain('不要重复新建');
    expect(task.prompt).toContain('不要修改正文，不要删除任何东西。');
    expect(task.prompt).toContain('不要建立任务计划');
    expect(buildOrganizeTask([document({})]).title).toBe('整理：第一章');
  });

  it('skips documents whose only change is formatting', () => {
    expect(hasOrganizableChange(document({}))).toBe(true);
    expect(hasOrganizableChange(document({ digest: '（只有格式或空白变化）' }))).toBe(false);
    expect(hasOrganizableChange(document({ digest: '（正文为空）' }))).toBe(false);
  });

  it('counts committed record writes and keeps the closing reply', () => {
    const { summary, counts } = summarizeOrganizeTranscript([
      { kind: 'user', text: '整理' },
      { kind: 'assistant', text: '先查已有要素。' },
      { kind: 'tool', id: '1', name: 'list_elements', status: 'ok' },
      { kind: 'tool', id: '2', name: 'create_element', status: 'ok' },
      { kind: 'tool', id: '3', name: 'create_element', status: 'error' },
      { kind: 'tool', id: '4', name: 'revise_element', status: 'ok' },
      { kind: 'tool', id: '5', name: 'create_element_patch', status: 'ok' },
      { kind: 'tool', id: '6', name: 'create_relation', status: 'ok' },
      { kind: 'assistant', text: '新建了阿岚。\n需要你确认：阿岚是不是七娘？' },
    ]);
    expect(counts).toEqual({ elementsCreated: 1, elementsUpdated: 1, patches: 1, relations: 1 });
    expect(summary).toBe('新建了阿岚。\n需要你确认：阿岚是不是七娘？');
  });
});
