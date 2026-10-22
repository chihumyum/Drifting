import { describe, expect, it } from 'vitest';

import { buildChapterReviewTask } from './chapter-agent-review';

describe('buildChapterReviewTask', () => {
  it('asks for a review in comments without rewriting the prose', () => {
    const task = buildChapterReviewTask('第三章 雨夜');
    expect(task.title).toBe('审阅：第三章 雨夜');
    expect(task.prompt).toContain('《第三章 雨夜》');
    expect(task.prompt).toContain('批注');
    expect(task.prompt).toContain('不要直接修改正文');
  });

  it('keeps the session title short and on one line', () => {
    const task = buildChapterReviewTask(`很长的标题\n${'字'.repeat(40)}`);
    expect(task.title).not.toContain('\n');
    expect(task.title.length).toBeLessThanOrEqual('审阅：'.length + 30);
  });
});
