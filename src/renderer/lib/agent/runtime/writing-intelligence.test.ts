import { describe, expect, it } from 'vitest';

import type { AgentAuthoringFocus } from './writing-intelligence';
import {
  buildAgentWritingTurnContext,
  renderAgentWritingSystemSection,
} from './writing-intelligence';
import { scoreAgentVoiceContinuity, validateAgentSemanticCitations } from './writing-quality';

const focus: AgentAuthoringFocus = {
  projectId: 'project-writing',
  entity: {
    kind: 'chapter',
    id: 'chapter-1',
    name: '雨夜',
    path: '/chapters/雨夜/prose.md',
  },
  mode: 'selection',
  selectedText: '她没有回头，只把湿伞倚在门边。',
  selectedBlocks: [
    {
      id: 'block-7',
      ordinal: 7,
      text: '她没有回头，只把湿伞倚在门边。',
    },
  ],
  contextBefore: ['钟声隔着雨幕传来，像一枚生锈的钉子。'],
  contextAfter: ['“你迟到了。”他说。'],
};

describe('writing intelligence', () => {
  it('binds deictic prose edits to the exact editor selection', () => {
    const context = buildAgentWritingTurnContext('帮我润色这里，不要改剧情。', focus);

    expect(context.intent).toMatchObject({
      kind: 'polish',
      mutation: 'prose',
      scopeKind: 'focus_selection',
      hardFocusScope: true,
      clarificationRequired: false,
      preservation: {
        plotFacts: true,
        canon: true,
        chronology: true,
        pov: true,
        tense: true,
        authorVoice: true,
      },
    });
    expect(context.styleProfile?.sampleChars).toBeGreaterThan(20);
    expect(renderAgentWritingSystemSection(context).join('\n')).toContain(
      'Exact selected span: "她没有回头，只把湿伞倚在门边。"',
    );
  });

  it('fails closed when nearby text is referenced without editor focus', () => {
    const context = buildAgentWritingTurnContext('重写这段，让它更克制。', null);
    expect(context.intent).toMatchObject({
      kind: 'rewrite',
      scopeKind: 'unresolved',
      clarificationRequired: true,
    });
  });

  it('distinguishes read-only whole-book QA from edit work', () => {
    const context = buildAgentWritingTurnContext(
      '检查整本小说的人物状态与时间线一致性，列出证据。',
      focus,
    );
    expect(context.intent).toMatchObject({
      kind: 'whole_book_qa',
      mutation: 'none',
      scopeKind: 'whole_book',
      hardFocusScope: false,
      evidence: { exactCitations: true },
    });
    expect(renderAgentWritingSystemSection(context).join('\n')).toContain('workKind=review');
  });

  it('does not demand an existing focus for resource creation', () => {
    const context = buildAgentWritingTurnContext('创建一个名为“尾声”的新章节。', null);
    expect(context.intent).toMatchObject({
      kind: 'structural',
      mutation: 'structural',
      clarificationRequired: false,
    });
    expect(context.canonImpact.level).toBe('high');
  });

  it('marks named canon evolution as patch-required high impact', () => {
    const context = buildAgentWritingTurnContext(
      '修改设定：让留存者议会推翻南园的旧契约，并据此改剧情。',
      focus,
      ['留存者议会', '南园'],
    );
    expect(context.canonImpact).toEqual({
      level: 'high',
      referencedTerms: ['留存者议会', '南园'],
      reasons: expect.arrayContaining([
        'The request names established project entities.',
        'The request changes authored truth or project structure.',
      ]),
      requiresSanctionedPatch: true,
    });
  });

  it('quantifies voice drift diagnostically and rejects fabricated citations', () => {
    const reference = [
      '雨压得很低。她没有回头，只把湿伞倚在门边。',
      '“你迟到了。”他说。声音却很轻，仿佛怕惊动楼上的人。',
      '她仍站着，于是钟声又隔着雨幕响了一次。',
    ];
    const same = scoreAgentVoiceContinuity(reference, reference);
    const flattened = scoreAgentVoiceContinuity(reference, [
      '雨压得很低她没有回头只把湿伞倚在门边你迟到了他说声音很轻怕惊动楼上的人她站着钟声响了一次',
    ]);
    expect(same?.score).toBe(1);
    expect(flattened?.score ?? 1).toBeLessThan(0.75);

    const validation = validateAgentSemanticCitations(
      {
        schemaVersion: 1,
        verdict: 'findings',
        synopsis: '发现一处连续性问题。',
        claims: [
          {
            kind: 'event',
            text: '她把伞放在门边。',
            citations: [{ quote: '把湿伞倚在门边' }],
          },
        ],
        findings: [
          {
            kind: 'continuity',
            severity: 'warning',
            message: '后文凭空出现了另一把伞。',
            citations: [{ quote: '凭空出现的金色雨伞' }],
          },
        ],
      },
      reference,
    );
    expect(validation).toMatchObject({
      valid: false,
      citationCount: 2,
      coverage: 1,
      missingQuotes: ['凭空出现的金色雨伞'],
    });
  });
});
