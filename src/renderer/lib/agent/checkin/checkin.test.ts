import { describe, expect, it } from 'vitest';
import type { CheckinChangedDocument } from './checkin-delta';
import { describeChangedPassage, digestDocumentChanges } from './checkin-delta';
import {
  buildCheckinContext,
  CHECKIN_MAX_CARDS,
  CHECKIN_SYSTEM_PROMPT,
  checkinToolSchema,
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
    expect(CHECKIN_SYSTEM_PROMPT).toContain('Memory upkeep is a card too');
    expect(Object.keys(checkinToolSchema.properties)).toEqual(['cards']);
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

  it('resolves refs, drops cards without a task and ignores memory edits', () => {
    const parsed = parseCheckinToolArguments(
      JSON.stringify({
        cards: [
          { title: '结尾要停在灯熄灭吗？', detail: '新段落改变了结尾的节奏。', instruction: '和作者讨论结尾是否停在灯熄灭。', target: 'c1' },
          { title: '没有任务的卡片', detail: '没有 instruction 的卡片会被丢弃。', instruction: '  ' },
          { title: '核对码头的描述', instruction: '对照前文核对码头的描述，并把差异记成待办。', target: 'c9' },
        ],
        // Earlier check-ins edited memory directly; those fields are ignored now.
        workingMemoryEdits: [{ oldText: '- 修第三章', newText: '' }],
        memoryAdd: ['作者偏好短句。'],
        memoryUpdate: [{ memoryId: 'mem-1', body: '结局保持开放，但要有回声。' }],
        memoryDelete: ['mem-1'],
      }),
      documents,
    );
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0]).toMatchObject({
      title: '结尾要停在灯熄灭吗？',
      target: { entityType: 'node', entityId: 'node-internal-id', title: '第三章 雾港' },
    });
    expect(parsed.cards[1]).toMatchObject({ title: '核对码头的描述', detail: '', target: null });
    expect(parsed.cards[0]).not.toHaveProperty('kind');
    expect(Object.keys(parsed)).toEqual(['cards']);
  });

  it('rejects malformed or schema-invalid results instead of applying part of them', () => {
    expect(() => parseCheckinToolArguments('{', documents)).toThrow('malformed');
    expect(() =>
      parseCheckinToolArguments(JSON.stringify({ cards: [{ kind: 'todo', title: 't' }] }), documents),
    ).toThrow('invalid');
    expect(() => parseCheckinToolArguments('{"cards":null}', documents)).toThrow('invalid');
  });

  it('accepts a result carrying an echoed schema keyword or null optional fields', () => {
    // The author's check-in failed with "/maxItems Unexpected property": the
    // model returned the cards array's limit beside the cards themselves.
    const parsed = parseCheckinToolArguments(
      JSON.stringify({
        cards: [
          { title: '核对码头的描述', detail: null, instruction: '对照前文核对码头的描述。', target: null, kind: 'todo' },
          { title: '第三章结尾要停在哪？', instruction: '和作者讨论第三章的结尾。', target: 'c1' },
        ],
        maxItems: 4,
        type: 'object',
        memoryAdd: null,
      }),
      documents,
    );
    expect(parsed.cards).toEqual([
      { title: '核对码头的描述', detail: '', instruction: '对照前文核对码头的描述。', target: null },
      {
        title: '第三章结尾要停在哪？',
        detail: '',
        instruction: '和作者讨论第三章的结尾。',
        target: { entityType: 'node', entityId: 'node-internal-id', title: '第三章 雾港' },
      },
    ]);
  });

  it('keeps at most four cards without asking providers to enforce it', () => {
    const card = { title: '一个问题', instruction: '问作者一个问题。' };
    const parsed = parseCheckinToolArguments(
      JSON.stringify({ cards: Array.from({ length: 6 }, () => card) }),
      documents,
    );
    expect(parsed.cards).toHaveLength(CHECKIN_MAX_CARDS);
  });

  it('gives every provider route a structure-only schema', () => {
    // OpenAI, the ChatGPT subscription, Anthropic and DeepSeek all receive
    // this schema verbatim, so it must not carry limits a model could echo.
    const structural = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'description']);
    const keywords = new Set<string>();
    const walk = (node: unknown, inProperties: boolean) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (!inProperties) keywords.add(key);
        walk(value, !inProperties && key === 'properties');
      }
    };
    walk(JSON.parse(JSON.stringify(checkinToolSchema)), false);
    expect([...keywords].filter((keyword) => !structural.has(keyword))).toEqual([]);
  });
});
