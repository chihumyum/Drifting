import { describe, expect, it } from 'vitest';
import type { CheckinChangedDocument } from './checkin-delta';
import { describeChangedPassage, digestDocumentChanges } from './checkin-delta';
import {
  buildCheckinContext,
  CHECKIN_SYSTEM_PROMPT,
  parseCheckinToolArguments,
} from './checkin-prompt';

function doc(blocks: Array<[string, string]>): string {
  return JSON.stringify({
    type: 'doc',
    content: blocks.map(([id, text]) => ({
      type: 'paragraph',
      attrs: { id },
      content: text ? [{ type: 'text', text }] : [],
    })),
  });
}

const documents: CheckinChangedDocument[] = [
  {
    ref: 'c1',
    entityType: 'node',
    entityId: 'node-internal-id',
    objectKind: 'chapter',
    title: '第三章 雾港',
    lastChangedAt: '2026-10-11T12:00:00.000Z',
    revisions: { user: 4, agent: 1, remote: 0 },
    hasBaseline: true,
    digest: '+ 新的一段。',
  },
];

describe('check-in change digest', () => {
  it('lists added, removed and revised blocks against the baseline', () => {
    const baseline = doc([
      ['a', '她推开门。'],
      ['b', '雨下了一整夜。'],
      ['c', '这一段之后被删除。'],
    ]);
    const current = doc([
      ['a', '她轻轻推开门。'],
      ['b', '雨下了一整夜。'],
      ['d', '码头的灯一盏盏熄灭。'],
    ]);
    const digest = digestDocumentChanges(baseline, current);
    expect(digest).toContain('~ ');
    expect(digest).toContain('{+轻轻+}');
    expect(digest).toContain('+ 码头的灯一盏盏熄灭。');
    expect(digest).toContain('- 这一段之后被删除。');
    expect(digest).not.toContain('雨下了一整夜');
  });

  it('excerpts a document without a baseline instead of diffing it', () => {
    const current = doc([['a', '全新的章节开头。']]);
    expect(digestDocumentChanges(null, current)).toBe('全新的章节开头。');
    expect(digestDocumentChanges(null, doc([['a', '']]))).toBe('（正文为空）');
  });

  it('falls back to before/after excerpts for very long passages', () => {
    const long = '字'.repeat(2_000);
    const described = describeChangedPassage(long, `${long}尾`);
    expect(described.startsWith('原：')).toBe(true);
    expect(described).toContain('现：');
  });
});

describe('check-in prompt and result', () => {
  it('states principles, keeps book facts out of memory and asks for the author language', () => {
    expect(CHECKIN_SYSTEM_PROMPT).toContain('between zero and four cards');
    expect(CHECKIN_SYSTEM_PROMPT).toContain('Its title is the question itself, or the work you want to do');
    expect(CHECKIN_SYSTEM_PROMPT).toContain('story facts never belong there');
    expect(CHECKIN_SYSTEM_PROMPT).toContain('Literary choices belong to the author');
    expect(CHECKIN_SYSTEM_PROMPT).toContain('language the author writes in');
  });

  it('builds a bounded context with refs and memory ids but no internal object ids', () => {
    const context = buildCheckinContext({
      projectName: '雾港档案',
      nowIso: '2026-10-12T08:00:00.000Z',
      sinceIso: '2026-10-11T08:00:00.000Z',
      mode: 'changes',
      documents,
      projectMemory: [{ id: 'mem-1', body: '结局保持开放。' }],
      workingMemory: '# Working Memory\n\n## Current\n- 修第三章',
      openTodos: ['检查时间线'],
      chapterTitles: ['第一章', '第三章 雾港'],
    });
    expect(context).toContain('## c1 · chapter 「第三章 雾港」');
    expect(context).toContain('revisions by author 4, Agent 1');
    expect(context).toContain('### memoryId mem-1\n结局保持开放。');
    expect(context).toContain('- 检查时间线');
    expect(context).toContain('## Current');
    expect(context).not.toContain('node-internal-id');
  });

  it('resolves refs, drops unknown memory ids and cards without a task', () => {
    const parsed = parseCheckinToolArguments(
      JSON.stringify({
        cards: [
          { title: '结尾要停在灯熄灭吗？', detail: '新段落改变了结尾的节奏。', instruction: '和作者讨论结尾是否停在灯熄灭。', target: 'c1' },
          { title: '没有任务的卡片', detail: '没有 instruction 的卡片会被丢弃。', instruction: '  ' },
          { title: '核对码头的描述', instruction: '对照前文核对码头的描述，并把差异记成待办。', target: 'c9' },
        ],
        workingMemoryEdits: [{ oldText: '- 修第三章', newText: '' }, { oldText: '', newText: 'x' }],
        memoryAdd: ['作者偏好短句。'],
        memoryUpdate: [
          { memoryId: 'mem-1', body: '结局保持开放，但要有回声。' },
          { memoryId: 'unknown', body: 'ignored' },
        ],
        memoryDelete: ['mem-1', 'unknown', 'mem-1'],
      }),
      documents,
      new Set(['mem-1']),
    );
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0]).toMatchObject({
      title: '结尾要停在灯熄灭吗？',
      target: { entityType: 'node', entityId: 'node-internal-id', title: '第三章 雾港' },
    });
    expect(parsed.cards[1]).toMatchObject({ title: '核对码头的描述', detail: '', target: null });
    expect(parsed.cards[0]).not.toHaveProperty('kind');
    expect(parsed.workingMemoryEdits).toEqual([{ oldText: '- 修第三章', newText: '' }]);
    expect(parsed.memoryAdd).toEqual(['作者偏好短句。']);
    expect(parsed.memoryUpdate).toEqual([{ memoryId: 'mem-1', body: '结局保持开放，但要有回声。' }]);
    expect(parsed.memoryDelete).toEqual(['mem-1']);
  });

  it('rejects malformed or schema-invalid results instead of applying part of them', () => {
    expect(() => parseCheckinToolArguments('{', documents, new Set())).toThrow('malformed');
    expect(() =>
      parseCheckinToolArguments(JSON.stringify({ cards: [{ kind: 'todo', title: 't' }] }), documents, new Set()),
    ).toThrow('invalid');
  });
});
