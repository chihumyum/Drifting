import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { noteMarkdownExcerpt } from '../../lib/note-markdown';
import { NoteExcerpt } from './NoteExcerpt';

describe('bounded material previews', () => {
  it('bounds text before Markdown conversion and DOM creation in both card states', () => {
    const bodyJson = JSON.stringify({ type: 'doc', content: Array.from({ length: 500 }, () => ({
      type: 'paragraph', content: [{ type: 'text', text: '合成笔记'.repeat(100) }],
    })).concat([{ type: 'paragraph', content: [{ type: 'text', text: 'END_OF_LONG_NOTE' }] }]) });
    for (const clamp of [true, false]) {
      const markdown = noteMarkdownExcerpt(bodyJson, !clamp);
      const html = renderToStaticMarkup(createElement(NoteExcerpt, { bodyJson, clamp, emptyLabel: 'Empty', onOpen() {} }));
      expect(markdown.length).toBeLessThan(clamp ? 600 : 2700);
      expect(html.length).toBeLessThan(4000);
      expect(html).toContain('合成笔记');
      expect(html).not.toContain('END_OF_LONG_NOTE');
      expect(html).toContain('…');
    }
  });
  it('also bounds empty nested structure and preserves closed list/code Markdown', () => {
    const empty = JSON.stringify({ type: 'doc', content: Array.from({ length: 10000 }, () => ({ type: 'horizontalRule' })) });
    expect(noteMarkdownExcerpt(empty).length).toBeLessThan(200);
    const code = JSON.stringify({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'code '.repeat(1000) }] }] });
    const markdown = noteMarkdownExcerpt(code);
    expect(markdown.match(/```/gu)).toHaveLength(2);
  });
  it('escapes raw HTML and leaves the source document intact', () => {
    const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }] });
    const html = renderToStaticMarkup(createElement(NoteExcerpt, { bodyJson, clamp: true, emptyLabel: 'Empty', onOpen() {} }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(JSON.parse(bodyJson).content[0].content[0].text).toBe('<script>alert(1)</script>');
  });
});
