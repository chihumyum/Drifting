import { describe, expect, it } from 'vitest';

import { countWords, deriveProseMetric, deriveProseMetricFromJson } from './word-count';

describe('canonical prose metrics', () => {
  it('preserves the established mixed CJK and Latin counting rule', () => {
    expect(countWords('你好，Drifting world 2.0！')).toBe(5);
    expect(countWords('标点…… ——')).toBe(2);
    expect(countWords('   ')).toBe(0);
  });

  it('separates Latin tokens at ProseMirror child boundaries', async () => {
    const metric = await deriveProseMetric({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    });
    expect(metric.wordCount).toBe(2);
  });

  it('hashes semantic JSON canonically rather than by object key order', async () => {
    const left = await deriveProseMetric({ type: 'doc', attrs: { b: 2, a: 1 }, content: [] });
    const right = await deriveProseMetricFromJson(
      JSON.stringify({ content: [], attrs: { a: 1, b: 2 }, type: 'doc' }),
    );
    expect(left.basisHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(right).toEqual(left);
  });
});
