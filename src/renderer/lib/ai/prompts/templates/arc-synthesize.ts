import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// Element Arc · SYNTHESIZE (top). Reasons over the small DISTILLED input (segment
// digests) to produce the ArcMap: ordered trajectory points, neutral tension flags,
// and a patchOverlay self-check. The patches are revealed ONLY here — the
// leaf/distill steps derived the arc BLIND, so if the derivation independently lands
// on the authored beats it's strong evidence the tree works. Provenance is
// chapter-level: a point IS its `order`; a tension cites the orders it spans.
const conf = Type.Union([Type.Literal('low'), Type.Literal('med'), Type.Literal('high')]);

export const arcSynthesizePrompt = definePrompt({
  id: 'arc-synthesize',
  version: 2,
  model: 'gemini-3.5-flash',
  description: '元素弧线·顶层综合：把多段蒸馏整理成 ArcMap（轨迹点 + 中性张力 + patch overlay 自检）。',

  input: Type.Object({
    canon: Type.String(),
    elementName: Type.String(),
    segmentsJson: Type.String(),
    patchesJson: Type.String(),
  }),

  output: Type.Object({
    narrative: Type.String({ description: '整体弧线叙述' }),
    points: Type.Array(
      Type.Object({
        order: Type.Number({ description: '该轨迹点所属章的叙事序（即它的锚点）' }),
        label: Type.String(),
        state: Type.String(),
        motivation: Type.Optional(Type.String({ description: '对非角色元素可写动因/叙事作用' })),
        confidence: conf,
      }),
    ),
    tensions: Type.Array(
      Type.Object({
        kind: Type.Union([
          Type.Literal('contrast'),
          Type.Literal('possible-drift'),
          Type.Literal('uncommitted-evolution'),
        ]),
        note: Type.String({ description: '中性提问口吻，不要「你应该」' }),
        orders: Type.Array(Type.Number(), { description: '这条张力涉及的章 order' }),
      }),
    ),
    patchOverlay: Type.Array(
      Type.Object({
        atOrder: Type.Number(),
        patchTitle: Type.String(),
        alignsWithDerived: Type.Boolean({ description: '盲派生的轨迹是否独立反映了这个节拍' }),
        note: Type.String({ description: '引哪个派生 point 对上了，或为何没对上' }),
      }),
    ),
  }),

  buildSystem: () =>
    [
      '你在做「元素弧线透镜」的【顶层综合】。把某元素跨全书的发展弧线整理成一张 ArcMap。目标元素可能是角色，也可能是物件/地点/组织/概念。',
      '1. narrative：整体弧线叙述。',
      '2. points：有序轨迹点（order=该章叙事序，order 本身即锚点），每点 label/state/可选 motivation(对非角色元素可写动因/叙事作用)/confidence。只用给定蒸馏里的事实，不得新编。',
      '3. tensions：中性张力提示——contrast(前后对比)/possible-drift(疑似漂移)/uncommitted-evolution(正文在演化但无演化记录)；orders 标这条张力涉及哪几章。用中性提问口吻，不要「你应该」。',
      '4. patchOverlay：给定作者实际写下的演化记录(patch)；对每条，判断你上面【盲派生】出的轨迹有没有独立反映这个节拍：alignsWithDerived=true/false，note 里引哪个派生 point 对上了或为何没对上。',
    ].join('\n'),

  buildUserMessage: (input) =>
    [
      `目标元素：${input.elementName}`,
      '静态 canon：',
      input.canon,
      '',
      '多段蒸馏结果（从正文盲派生，未参考作者演化记录）：',
      input.segmentsJson,
      '',
      '作者实际写下的演化记录(patch)（仅用于 overlay 自检，前面的派生未见过它）：',
      input.patchesJson,
    ].join('\n'),
});
