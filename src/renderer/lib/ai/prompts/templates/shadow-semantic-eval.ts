import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// Judges ONE semantic assertion against a chapter's prose (given as NUMBERED
// blocks), grounded in the project's background facts + chapter summary so deep
// rules (e.g. POV constraints) have the context to judge correctly. Returns one
// violation per offending consecutive span. `violated` is the explicit yes/no
// gate — only true ones are kept — so the model can't pad the list with
// "satisfied" spans. Quote-free reason + confidence curb hallucinated violations.
export const shadowSemanticEvalPrompt = definePrompt({
  id: 'shadow-semantic-eval',
  version: 5,
  model: 'gemini-3.5-flash',
  description: '结合背景设定，判断章节正文是否违反一条语义约束，返回违反的连续段落范围、原因与置信度。',

  input: Type.Object({
    assertion: Type.String(),
    context: Type.String(),
    blocks: Type.String(),
  }),

  output: Type.Object({
    violations: Type.Array(
      Type.Object({
        violated: Type.Boolean({ description: 'true=该段确实违反约束；false=不违反（会被丢弃）' }),
        blockStart: Type.Number({ description: '违反范围的起始段编号（1 起）；0 表示整章级、无法定位到具体段落' }),
        blockEnd: Type.Number({ description: '违反范围的结束段编号（含）；单段时与 blockStart 相同；整章级为 0' }),
        reason: Type.String({ description: '一句话说明为什么违反约束（解释原因，不要照抄原文）' }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      }),
    ),
  }),

  buildSystem: () =>
    [
      '你是小说写作 CI 的审阅器。给你一条「约束」、一段「背景设定」、和一章正文（按段编号）。',
      '结合背景设定（人称/视角、人物设定、本章梗概等）判断哪些段落确实违反了该约束，输出 violations：',
      '- violated：true 表示该段确实违反约束；false 表示不违反。只有 violated=true 的会被采用。不确定、依据不足一律给 false。',
      '- 若连续若干段因同一原因违反，合并成一条 violation（blockStart/blockEnd 表示连续范围，含两端，单段时相同）。不连续或原因不同的分成多条。',
      '- blockStart/blockEnd：段落编号（从 1 起）。整章级、无法定位到具体段落时两者都用 0。',
      '- reason：一句话说明为什么违反约束（解释原因，不要照抄原文）。',
      '- confidence：你对该判断的把握（0~1）。',
      '重要：不要把"符合约束/未违反"的段落作为 violation 输出（更不要 violated=true）。整章都满足时返回空 violations。宁可漏报也别误报。',
    ].join('\n'),

  buildUserMessage: (input) =>
    `约束：${input.assertion}\n\n背景设定：\n${input.context}\n\n正文（按段编号）：\n${input.blocks}`,
});
