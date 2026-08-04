import { describe, expect, it } from 'vitest';

import { stripRedundantLeadingAuthoredTitle } from './normalize-new-authored-prose';

describe('new authored prose title normalization', () => {
  it('removes only a matching leading H1', () => {
    expect(
      stripRedundantLeadingAuthoredTitle('# **雨夜**\n\n潮声越过旧码头。', '雨夜'),
    ).toBe('潮声越过旧码头。');
    expect(
      stripRedundantLeadingAuthoredTitle('# 雨夜·序章\n\n潮声越过旧码头。', '雨夜'),
    ).toBe('# 雨夜·序章\n\n潮声越过旧码头。');
    expect(
      stripRedundantLeadingAuthoredTitle('## 雨夜\n\n潮声越过旧码头。', '雨夜'),
    ).toBe('## 雨夜\n\n潮声越过旧码头。');
  });
});
