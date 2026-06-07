import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// Element Arc · DISTILL (reduction level). Folds a contiguous run of leaf
// extractions into a segment digest: the local sub-arc, per-dimension trends, and
// TENTATIVE motivation hypotheses. Motivation is the interpretive jump (behavior →
// characterization) and where hallucination creeps in — so every motivation carries
// a confidence + the chapter orders it's drawn from. Provenance is chapter-level
// (orders), not block-level.
export const arcDistillPrompt = definePrompt({
  id: 'arc-distill',
  version: 2,
  model: 'gemini-3.5-flash',
  description: '元素弧线·中层蒸馏：把连续几章的叶层抽取折成局部子弧 + 趋势 + 试探性动机。',

  input: Type.Object({
    canon: Type.String(),
    segmentLabel: Type.String(),
    leavesJson: Type.String(),
  }),

  output: Type.Object({
    subArc: Type.String({ description: '这几章里该元素的局部弧线' }),
    trends: Type.Array(
      Type.Object({
        dimension: Type.String({ description: '按元素性质选取的维度名（如 能力/关系/情绪/状态/归属/意义/氛围…）' }),
        trend: Type.String({ description: '这几章里该维度怎么变（一句话）' }),
      }),
      { description: '挑该元素最相关的若干维度' },
    ),
    motivations: Type.Array(
      Type.Object({
        claim: Type.String({ description: '试探性的动机/内在状态/作用机理推断' }),
        confidence: Type.Union([Type.Literal('low'), Type.Literal('med'), Type.Literal('high')]),
        orders: Type.Array(Type.Number(), {
          description: '该推断引自哪些章的 order，宁可少也不无据',
        }),
      }),
    ),
  }),

  buildSystem: () =>
    [
      '你在做「元素弧线」的【中层蒸馏】。输入是某元素在连续几章的底层抽取结果。目标元素可能是角色，也可能是物件/地点/组织/概念。',
      '- subArc：把这几章里该元素的局部弧线用几句话讲出来。',
      '- trends：挑该元素最相关的若干维度，各给一句话变化——角色可用 能力/关系/情绪/立场，物件可用 状态/归属/意义/损耗，地点可用 氛围/到场者/格局……由你按元素性质定，不必凑固定维度。',
      '- motivations：试探性推断其内在状态 / 驱动 / 作用机理（角色＝动机；物件/地点/概念＝其变化背后的动因或叙事功能）——每条必标 confidence(low/med/high) + orders(引具体章 order)。宁可标 low 也不无据断言。',
      '- 不要发明证据里没有的事。',
    ].join('\n'),

  buildUserMessage: (input) =>
    [
      '目标元素静态 canon：',
      input.canon,
      '',
      `段落：${input.segmentLabel}`,
      '逐章抽取（JSON）：',
      input.leavesJson,
    ].join('\n'),
});
