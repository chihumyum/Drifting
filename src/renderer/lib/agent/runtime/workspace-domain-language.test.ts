import { describe, expect, it } from 'vitest';

import {
  describeAgentWriteTarget,
  describeWorkspaceDomainTarget,
  describeWorkspaceDomainWriteResult,
} from './workspace-domain-language';

describe('workspace domain language', () => {
  it('turns internal workspace identities into authored objects', () => {
    expect(describeWorkspaceDomainTarget('/chapters/AI%20ch%202/prose.md')).toBe(
      '章节「AI ch 2」正文',
    );
    expect(describeWorkspaceDomainTarget('/elements/人物/维娅/body.md')).toBe(
      '要素「维娅」设定',
    );
    expect(describeWorkspaceDomainTarget('/relations/师徒.json')).toBe('实体关系「师徒」');
  });

  it('returns a domain confirmation without paths, ids, review state, or serialization details', () => {
    const result = describeWorkspaceDomainWriteResult({
      path: '/chapters/AI%20ch%202/prose.md',
      operation: 'updated',
      wordCount: 6_129,
      changeSummary: '清理测试痕迹并收紧正文',
    });

    expect(result).toBe(
      '章节「AI ch 2」正文已更新。当前 6129 字。完成内容：清理测试痕迹并收紧正文。这一步已经完成；直接继续剩余任务，不要为了确认写入而重读。',
    );
    expect(result).not.toMatch(/\/chapters|writeRef|review|revision|JSON|\\/i);
  });

  it('hides partial-match mechanics and marks the completed domain step once', () => {
    const result = describeWorkspaceDomainWriteResult({
      path: '/chapters/05/prose.md',
      replacements: 8,
      skippedStale: 2,
      remainingWork:
        '2 处局部修改因正文已变化而跳过；只有它仍影响作者目标时，才需在附近正文中重新定位一次',
    });

    expect(result).toBe(
      '章节「05」正文已完成 8 处修改。这一步已经完成；直接继续剩余任务，不要为了确认写入而重读。',
    );
    expect(result).not.toMatch(/path|revision|receipt|JSON|stale|跳过|重新定位|\\/i);
  });

  it('preserves real authored remaining work', () => {
    const result = describeWorkspaceDomainWriteResult({
        path: '/chapters/05/summary.md',
        operation: 'updated',
        summaryUpdated: true,
        remainingWork: '当前摘要为空，需要补写',
      });

    expect(result).toContain('仍待完成：当前摘要为空，需要补写。');
    expect(result).not.toContain('摘要已同步更新。');
  });

  it('reports a combined chapter and summary save as one author-domain result', () => {
    expect(
      describeWorkspaceDomainWriteResult({
        path: '/chapters/05/prose.md',
        operation: 'updated',
        wordCount: 4_800,
        summaryUpdated: true,
      }),
    ).toBe(
      '章节「05」正文已更新。当前 4800 字。摘要已同步更新。这一步已经完成；直接继续剩余任务，不要为了确认写入而重读。',
    );
  });

  it('retains full-read and current-summary state without transport vocabulary', () => {
    const result = describeWorkspaceDomainWriteResult({
      path: '/chapters/11/prose.md',
      replacements: 4,
      authoredReadState: {
        targetKey: 'node:chapter-11',
        target: '章节「11」正文',
        summary: '米拉从伊莱亚斯心智中确认了泰勒面临的危险。',
        completeBodyRead: true,
        focusedBodyEdit: true,
        currentPassages: ['她终于突破了那面墙。'],
      },
    });

    expect(result).toContain('该正文已在本轮完整通读');
    expect(result).toContain(
      '当前摘要：米拉从伊莱亚斯心智中确认了泰勒面临的危险',
    );
    expect(result).toContain('当前修改后的正文片段：「她终于突破了那面墙。」');
    expect(result).not.toContain('危险。。');
    expect(result).not.toMatch(/targetKey|node:|path|offset|tool|revision|JSON|Yjs|SQLite/iu);
  });

  it('describes legacy certified writes without replaying their arguments', () => {
    expect(
      describeAgentWriteTarget('rename_node', {
        node: '第三章',
        title: '雨夜茶城',
        expectedRevision: { revision: 'yjs:42' },
      }),
    ).toBe('作品内容「第三章」');
  });
});
