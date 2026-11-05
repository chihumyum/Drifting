import { describe, expect, it } from 'vitest';
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
});
