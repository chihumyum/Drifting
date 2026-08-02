import { writeFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentRuntimeTaskStepReviewResult } from '../../../../domain/agent-runtime-long-task';
import {
  buildAgentWritingTurnContext,
  renderAgentWritingSystemSection,
  type AgentAuthoringFocus,
  type AgentWritingIntentKind,
  type AgentWritingMutationKind,
  type AgentWritingScopeKind,
} from '../writing-intelligence';
import { scoreAgentVoiceContinuity, validateAgentSemanticCitations } from '../writing-quality';
import { loadMilestoneFLiteraryFixture } from './milestone-f-literary-fixture';

const focus: AgentAuthoringFocus = {
  projectId: 'milestone-h-project',
  entity: {
    kind: 'chapter',
    id: 'chapter-current',
    name: '第十二章 收费站',
    path: '/chapters/第十二章 收费站/prose.md',
  },
  mode: 'selection',
  selectedText: '亚历克握住方向盘，没有回答。',
  selectedBlocks: [
    {
      id: 'block-current',
      ordinal: 18,
      text: '亚历克握住方向盘，没有回答。',
    },
  ],
  contextBefore: ['收费站的灯在雾里一盏盏亮起来。'],
  contextAfter: ['“我们还走吗？”奥伦问。'],
};

interface IntentOracle {
  prompt: string;
  focused: boolean;
  kind: AgentWritingIntentKind;
  mutation: AgentWritingMutationKind;
  scope: AgentWritingScopeKind;
  clarification: boolean;
}

const INTENT_ORACLE: readonly IntentOracle[] = [
  {
    prompt: '润色这里。',
    focused: true,
    kind: 'polish',
    mutation: 'prose',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '重写这段，但不要改剧情。',
    focused: true,
    kind: 'rewrite',
    mutation: 'prose',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '把本章改成第一人称。',
    focused: true,
    kind: 'rewrite',
    mutation: 'prose',
    scope: 'focus_entity',
    clarification: false,
  },
  {
    prompt: '续写本章。',
    focused: true,
    kind: 'continue',
    mutation: 'prose',
    scope: 'focus_entity',
    clarification: false,
  },
  {
    prompt: '总结本章。',
    focused: true,
    kind: 'summarize',
    mutation: 'none',
    scope: 'focus_entity',
    clarification: false,
  },
  {
    prompt: '更新本章摘要。',
    focused: true,
    kind: 'summarize',
    mutation: 'summary',
    scope: 'focus_entity',
    clarification: false,
  },
  {
    prompt: '检查整本小说的时间线一致性。',
    focused: true,
    kind: 'whole_book_qa',
    mutation: 'none',
    scope: 'whole_book',
    clarification: false,
  },
  {
    prompt: '通读全书并修复所有连续性问题。',
    focused: true,
    kind: 'whole_book_qa',
    mutation: 'mixed',
    scope: 'whole_book',
    clarification: false,
  },
  {
    prompt: '润色整本小说。',
    focused: true,
    kind: 'polish',
    mutation: 'prose',
    scope: 'whole_book',
    clarification: false,
  },
  {
    prompt: '修改设定：南园已经停战。',
    focused: true,
    kind: 'canon_evolution',
    mutation: 'canon',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '创建一个名为尾声的新章节。',
    focused: false,
    kind: 'structural',
    mutation: 'structural',
    scope: 'unresolved',
    clarification: false,
  },
  {
    prompt: '删除当前章节。',
    focused: true,
    kind: 'structural',
    mutation: 'structural',
    scope: 'focus_entity',
    clarification: false,
  },
  {
    prompt: '重命名第十二章为收费站。',
    focused: false,
    kind: 'structural',
    mutation: 'structural',
    scope: 'explicit',
    clarification: false,
  },
  {
    prompt: '你觉得这里是否需要润色？',
    focused: true,
    kind: 'inspect',
    mutation: 'none',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '先别润色，只评价这段。',
    focused: true,
    kind: 'inspect',
    mutation: 'none',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '告诉我怎么改写这一段。',
    focused: true,
    kind: 'inspect',
    mutation: 'none',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '分析当前章节的节奏。',
    focused: true,
    kind: 'inspect',
    mutation: 'none',
    scope: 'focus_entity',
    clarification: false,
  },
  {
    prompt: '这本书的主题是什么？',
    focused: true,
    kind: 'answer',
    mutation: 'none',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '重写这里。',
    focused: false,
    kind: 'rewrite',
    mutation: 'prose',
    scope: 'unresolved',
    clarification: true,
  },
  {
    prompt: '帮我润色选中的内容。',
    focused: false,
    kind: 'polish',
    mutation: 'prose',
    scope: 'unresolved',
    clarification: true,
  },
  {
    prompt: '改写第十二章。',
    focused: false,
    kind: 'rewrite',
    mutation: 'prose',
    scope: 'explicit',
    clarification: false,
  },
  {
    prompt: '检查全文，但不要修改。',
    focused: false,
    kind: 'whole_book_qa',
    mutation: 'none',
    scope: 'whole_book',
    clarification: false,
  },
  {
    prompt: '扩写当前段落。',
    focused: true,
    kind: 'continue',
    mutation: 'prose',
    scope: 'focus_selection',
    clarification: false,
  },
  {
    prompt: '新增人物关系。',
    focused: false,
    kind: 'structural',
    mutation: 'structural',
    scope: 'unresolved',
    clarification: false,
  },
  {
    prompt: '移除这个关系。',
    focused: true,
    kind: 'structural',
    mutation: 'structural',
    scope: 'focus_selection',
    clarification: false,
  },
] as const;

const metrics: {
  intent: Record<string, number>;
  voice: Record<string, number>;
  citations: Record<string, number>;
  fixture: Record<string, number | boolean>;
} = {
  intent: {},
  voice: {},
  citations: {},
  fixture: {},
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function flattenedMutation(paragraphs: readonly string[]): string[] {
  return [
    paragraphs
      .join('')
      .replace(/[，。！？；：、—…“”「」『』,.!?;:]/gu, '')
      .replace(/\s+/gu, ''),
  ];
}

describe('milestone H editor-native writing intelligence', () => {
  it('classifies author intent and scope against a deterministic ambiguity oracle', () => {
    let passed = 0;
    for (const oracle of INTENT_ORACLE) {
      const context = buildAgentWritingTurnContext(oracle.prompt, oracle.focused ? focus : null, [
        '南园',
        '亚历克',
        '奥伦',
      ]);
      expect(
        {
          kind: context.intent.kind,
          mutation: context.intent.mutation,
          scope: context.intent.scopeKind,
          clarification: context.intent.clarificationRequired,
        },
        oracle.prompt,
      ).toEqual({
        kind: oracle.kind,
        mutation: oracle.mutation,
        scope: oracle.scope,
        clarification: oracle.clarification,
      });
      passed += 1;
    }
    metrics.intent = {
      cases: INTENT_ORACLE.length,
      passed,
      accuracy: passed / INTENT_ORACLE.length,
    };
    expect(metrics.intent.accuracy).toBe(1);
  });

  it('injects exact focus, author voice, canon impact, and work-kind policy into provider context', () => {
    const focused = buildAgentWritingTurnContext('润色这里，不要改变剧情。', focus);
    const focusedPrompt = renderAgentWritingSystemSection(focused).join('\n');
    expect(focusedPrompt).toContain('/chapters/第十二章 收费站/prose.md');
    expect(focusedPrompt).toContain('Exact selected span');
    expect(focusedPrompt).toContain('Local voice witness');
    expect(focused.intent.preservation.plotFacts).toBe(true);

    const review = buildAgentWritingTurnContext('检查整本小说的一致性。', focus);
    expect(renderAgentWritingSystemSection(review).join('\n')).toContain('workKind=review');
    const edit = buildAgentWritingTurnContext('通读全书并修复连续性问题。', focus);
    expect(renderAgentWritingSystemSection(edit).join('\n')).toContain('workKind=edit');

    const canon = buildAgentWritingTurnContext('修改设定：让南园推翻旧约并据此改剧情。', focus, [
      '南园',
    ]);
    expect(canon.canonImpact).toMatchObject({
      level: 'high',
      referencedTerms: ['南园'],
      requiresSanctionedPatch: true,
    });
  });

  it('detects voice-flattening mutations on synthetic and local manuscript samples without leaking prose', () => {
    const fixture = loadMilestoneFLiteraryFixture();
    const synthetic = [
      [
        '雨压得很低。她没有回头，只把湿伞倚在门边。',
        '“你迟到了。”他说。声音却很轻。',
        '她仍站着，于是钟声又响了一次。',
      ],
      [
        '风从廊下穿过去，纸灯便轻轻一晃。',
        '我以为她会问，然而她只是笑。',
        '“走吧。”她说，“天快亮了。”',
      ],
      [
        '城门没有关。远处的海却像一堵黑墙。',
        '他们沿着旧轨道走，谁也没有提起昨夜。',
        '直到第一声汽笛从雾里传来。',
      ],
    ];
    const privateSamples = fixture.documents
      .filter((document) => document.evidenceId.startsWith('private-chapter:'))
      .map((document) => document.fields.map((field) => field.text).filter(Boolean))
      .filter((paragraphs) => paragraphs.length >= 3 && paragraphs.join('').length >= 300)
      .slice(0, 20);
    const samples = [...synthetic, ...privateSamples];
    const identicalScores: number[] = [];
    const mutatedScores: number[] = [];
    for (const sample of samples) {
      const identical = scoreAgentVoiceContinuity(sample, sample);
      const mutated = scoreAgentVoiceContinuity(sample, flattenedMutation(sample));
      expect(identical).not.toBeNull();
      expect(mutated).not.toBeNull();
      identicalScores.push(identical!.score);
      mutatedScores.push(mutated!.score);
    }
    const detected = mutatedScores.filter((score) => score < 0.8).length;
    metrics.voice = {
      samples: samples.length,
      privateSamples: privateSamples.length,
      identicalMedian: median(identicalScores),
      mutatedMedian: median(mutatedScores),
      mutationDetectionRate: detected / samples.length,
    };
    metrics.fixture = {
      privateCorpusAvailable: fixture.privateCorpus.available,
      privateCorpusFiles: fixture.privateCorpus.files,
      privateCorpusBytes: fixture.privateCorpus.bytes,
    };
    expect(metrics.voice.identicalMedian).toBe(1);
    expect(metrics.voice.mutatedMedian).toBeLessThan(0.7);
    expect(metrics.voice.mutationDetectionRate).toBeGreaterThanOrEqual(0.95);
    if (fixture.privateCorpus.available) {
      expect(privateSamples.length).toBeGreaterThanOrEqual(12);
    }
  });

  it('accepts exact semantic citations and rejects every forged citation mutation', () => {
    const sources = [
      '收费站的灯在雾里一盏盏亮起来。',
      '亚历克握住方向盘，没有回答。',
      '“我们还走吗？”奥伦问。',
    ];
    const base: AgentRuntimeTaskStepReviewResult = {
      schemaVersion: 1,
      verdict: 'findings',
      synopsis: '当前场景存在一个待确认的人物动机问题。',
      claims: [
        {
          kind: 'character_state',
          text: '亚历克选择沉默。',
          citations: [{ quote: '亚历克握住方向盘，没有回答。', block: 18 }],
        },
      ],
      findings: [
        {
          kind: 'continuity',
          severity: 'warning',
          message: '奥伦是否知道下一段行程仍未解决。',
          citations: [{ quote: '“我们还走吗？”奥伦问。', block: 19 }],
        },
      ],
    };
    const exact = validateAgentSemanticCitations(base, sources);
    expect(exact).toMatchObject({ valid: true, coverage: 1, citationCount: 2 });

    let rejected = 0;
    for (let index = 0; index < 12; index += 1) {
      const forged = structuredClone(base);
      const citation =
        index % 2 === 0 ? forged.claims[0]!.citations[0]! : forged.findings[0]!.citations[0]!;
      citation.quote = `${citation.quote}［伪造-${index}］`;
      if (!validateAgentSemanticCitations(forged, sources).valid) rejected += 1;
    }
    metrics.citations = {
      exactCases: 1,
      exactAccepted: exact.valid ? 1 : 0,
      forgedCases: 12,
      forgedRejected: rejected,
      forgedRejectionRate: rejected / 12,
    };
    expect(metrics.citations.forgedRejectionRate).toBe(1);
  });
});

afterAll(() => {
  const output = process.env.DRIFTING_AGENT_MILESTONE_H_METRICS_PATH;
  if (output) writeFileSync(output, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  if (process.env.DRIFTING_AGENT_ACCEPTANCE_VERBOSE === '1') {
    console.log(`MILESTONE_H_METRICS=${JSON.stringify(metrics)}`);
  }
});
