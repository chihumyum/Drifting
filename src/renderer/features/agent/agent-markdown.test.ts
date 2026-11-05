import { describe, expect, it } from 'vitest';
import { parseLocationHref } from '../../lib/location-link';
import { renderAgentMarkdown } from './agent-markdown';

describe('renderAgentMarkdown', () => {
  it('bolds Chinese runs whose closing stars follow full-width punctuation', () => {
    expect(renderAgentMarkdown('**出处：**明·方汝浩《东度记》')).toContain('<strong>出处：</strong>明·方汝浩');
    expect(renderAgentMarkdown('他说：**“吸铁石。”**她笑了')).toContain('<strong>“吸铁石。”</strong>她笑了');
  });

  it('keeps ordinary emphasis, code and lone stars as before', () => {
    expect(renderAgentMarkdown('a **b** c')).toContain('a <strong>b</strong> c');
    expect(renderAgentMarkdown('***both***')).toContain('<em><strong>both</strong></em>');
    expect(renderAgentMarkdown('`a**b**c`')).toContain('<code>a**b**c</code>');
    expect(renderAgentMarkdown('2 ** 3 and 4 ** 5')).not.toContain('<strong>');
    expect(renderAgentMarkdown('** not bold **')).not.toContain('<strong>');
  });

  it('escapes raw HTML from the model', () => {
    expect(renderAgentMarkdown('<img src=x onerror=alert(1)> **ok**')).toContain('&lt;img');
  });

  it('links a cited passage whose chapter title has a space', () => {
    const html = renderAgentMarkdown('正文停在[阿Q第一次高喊](drifting:chapters/第七章 革命/prose.md#L11-L13)，尚未写完。');
    expect(html).not.toContain('](drifting:');
    const href = /<a href="([^"]+)">阿Q第一次高喊<\/a>/.exec(html)?.[1];
    expect(href).toBeTruthy();
    expect(parseLocationHref(href!)).toMatchObject({ group: 'chapters', reference: '第七章 革命', startLine: 11, endLine: 13 });
    // Titles without spaces and ordinary links are left as they were.
    expect(renderAgentMarkdown('[雨夜](drifting:chapters/雨夜/prose.md#L12)')).toContain('<a href="drifting:chapters/');
    expect(renderAgentMarkdown('[a b](https://example.com/a b)')).not.toContain('<a href="https://example.com/a%20b"');
  });
});
