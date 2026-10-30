import { describe, expect, it } from 'vitest';

import { paragraphsFromLines, parseAuthoredFile, renderAuthoredFile } from './authored-file';

const file = (body: string, extra = '') =>
  renderAuthoredFile({
    id: 'chapter-1',
    title: '雨夜',
    fields: { status: 'draft', summary: '林岚回到老宅。\n第二行"引号"', },
    extra,
    body,
  });

describe('authored Markdown files', () => {
  it('reads back exactly what Drifting wrote', () => {
    const text = file('# 第一场\n\n林岚推开门。\n\n> 雨很大。', 'tags:\n  - 初稿\ncssclasses: [wide]');
    expect(text).toBe(
      [
        '---',
        'drifting-id: chapter-1',
        '写作状态: 草稿',
        '摘要: "林岚回到老宅。\\n第二行\\"引号\\""',
        'aliases: ["雨夜"]',
        'tags:',
        '  - 初稿',
        'cssclasses: [wide]',
        '---',
        '',
        '# 第一场',
        '',
        '林岚推开门。',
        '',
        '> 雨很大。',
        '',
      ].join('\n'),
    );
    expect(parseAuthoredFile(text)).toEqual({
      ok: true,
      id: 'chapter-1',
      fields: { status: 'draft', summary: '林岚回到老宅。\n第二行"引号"' },
      extra: 'tags:\n  - 初稿\ncssclasses: [wide]',
      body: '# 第一场\n\n林岚推开门。\n\n> 雨很大。',
    });
  });

  it('accepts the shapes other editors rewrite frontmatter into', () => {
    const parsed = parseAuthoredFile(
      '\uFEFF---\r\ndrifting-id: "chapter-1"\r\n写作状态: finished\r\n摘要: |\r\n  第一行\r\n  第二行\r\naliases:\r\n  - 雨夜\r\n---\r\n正文',
    );
    expect(parsed).toEqual({
      ok: true,
      id: 'chapter-1',
      fields: { status: 'finished', summary: '第一行\n第二行\n' },
      extra: '',
      body: '正文',
    });
    expect(parseAuthoredFile("---\n摘要: '它''s'\n写作状态: 已完成\n---\n")).toMatchObject({
      fields: { summary: "它's", status: 'finished' },
    });
    expect(parseAuthoredFile('---\n写作状态: 未知\n---\n正文')).toMatchObject({ ok: true, fields: {} });
  });

  it('keeps the body when the frontmatter is removed and refuses a broken one', () => {
    expect(parseAuthoredFile('林岚推开门。\n雨很大。')).toEqual({
      ok: true,
      id: null,
      fields: {},
      extra: '',
      body: '林岚推开门。\n\n雨很大。',
    });
    expect(parseAuthoredFile('---\n摘要: "未闭合\n正文')).toEqual({ ok: false, reason: 'frontmatter' });
    expect(parseAuthoredFile('---\n摘要: "未闭合\n---\n正文')).toEqual({ ok: false, reason: 'frontmatter' });
  });

  it('treats one line break as a new paragraph outside fenced code', () => {
    expect(paragraphsFromLines('第一段\n第二段\n\n\n第三段')).toBe('第一段\n\n第二段\n\n\n第三段');
    expect(paragraphsFromLines('```\na\nb\n```\n后文')).toBe('```\na\nb\n```\n\n后文');
    expect(paragraphsFromLines('已经\n\n分好')).toBe('已经\n\n分好');
  });
});
