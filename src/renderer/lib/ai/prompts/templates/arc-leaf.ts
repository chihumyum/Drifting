import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// Element Arc · LEAF (level 0). The FLOOR of the distillation tree: extract what the
// target element does/undergoes/is-portrayed-as in ONE chapter. EXTRACTION, not
// reasoning. Provenance is CHAPTER-level (this leaf IS one chapter) — no block ids:
// the model isn't agentic and can't verify them, and threading opaque ids upward
// bloated the distill input and broke its JSON output. The leaf also RECORDS (does
// not adjudicate) prose that seems to diverge from the static canon.
export const arcLeafPrompt = definePrompt({
  id: 'arc-leaf',
  version: 2,
  model: 'gemini-3.5-flash',
  description: '元素弧线·叶层：从一章正文抽取某元素的言行/状态/变化，不挂 block、不推理。',

  input: Type.Object({
    canon: Type.String(),
    elementName: Type.String(),
    chapterTitle: Type.String(),
    order: Type.Number(),
    prose: Type.String(),
  }),

  output: Type.Object({
    oneLineState: Type.String({ description: '该元素本章状态，一句话' }),
    observations: Type.Array(
      Type.Object({
        text: Type.String({ description: '该元素做了/发生了什么、被如何描写（客观，不解读动机）' }),
        signal: Type.Union([
          Type.Literal('state'),
          Type.Literal('action'),
          Type.Literal('relation'),
          Type.Literal('significance'),
          Type.Literal('change'),
          Type.Literal('other'),
        ]),
      }),
    ),
    divergenceFromCanon: Type.Array(
      Type.Object({
        note: Type.String({ description: '正文此处与静态 canon 的张力（只记录，不裁定是否真矛盾）' }),
      }),
    ),
  }),

  buildSystem: () =>
    [
      '你在为「元素弧线」分析做最底层的【抽取】。只抽取，不推理、不脑补。',
      '- 目标元素可能是角色，也可能是物件 / 地点 / 组织 / 概念等（见下方「类别」与 canon）。',
      '  按其性质抽取它在本章【发生 / 呈现了什么、状态如何、与谁或什么互动、有何变化】：',
      '  角色→言行/能力/处境；物件→状态/归属/位置/损耗/被如何使用；地点→在此发生之事/氛围/到场者/格局变化；组织/概念→主张/行动/适用范围/势力消长。',
      '- 每条 observation 打 signal：state(状态)/action(行为/发生之事)/relation(关系/归属)/significance(作用/意义)/change(变化)/other。',
      '- 若正文某处看起来偏离给定的静态 canon（尤其「从不/总是/绝不/未尝/唯一」这类绝对设定），记入 divergenceFromCanon——【只记录，不裁定是否真矛盾】。',
      '- oneLineState：一句话概括该元素本章状态。',
      '- 不要解读动机/作用、不要总结弧线，那是上层的事。',
    ].join('\n'),

  buildUserMessage: (input) =>
    [
      `目标元素：${input.elementName}`,
      `本章：${input.chapterTitle}（叙事序 ${input.order}）`,
      '',
      '【该元素的静态设定 canon】',
      input.canon,
      '',
      '【本章正文】',
      input.prose,
    ].join('\n'),
});
