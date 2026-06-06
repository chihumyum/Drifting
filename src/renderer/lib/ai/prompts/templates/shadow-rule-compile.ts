import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// Compiles ONE freeform author rule into (a) a checklist of atomic, checkable
// assertions, (b) an inferred `kind`, and (c) a `judgingGuide` — a per-rule judging
// template injected into the Shadow judge's prompt when this rule is evaluated.
//
// The judgingGuide is the LLM-authored "how to judge THIS rule" instruction. For
// character/setting CONSISTENCY rules it must bake in the canon-truth policy (see
// shadow/DESIGN.md): canon = authored truth; the only sanctioned divergence is an
// in-effect element_patch; no patch ⇒ report; absolute settings are hard constraints.
// The author can edit the generated guide afterwards (the decision is theirs).
export const shadowRuleCompilePrompt = definePrompt({
  id: 'shadow-rule-compile',
  version: 2,
  model: 'gemini-3.5-flash',
  description: '把作者写的自由文本写作规则编译成 kind + 判定指引(judgingGuide) + 可检查的原子 checklist。',

  input: Type.Object({
    rule: Type.String(),
  }),

  output: Type.Object({
    kind: Type.Union(
      [
        Type.Literal('consistency'),
        Type.Literal('continuity'),
        Type.Literal('structure'),
        Type.Literal('style'),
        Type.Literal('other'),
      ],
      { description: '规则的总体类别' },
    ),
    judgingGuide: Type.String({
      description:
        '给审阅判官的"如何判这条规则"指引，会被注入判官 prompt。一致性类必须写入 canon 真理政策。',
    }),
    checklist: Type.Array(
      Type.Object({
        assertion: Type.String({ description: '一条原子的、可独立验证的断言' }),
        type: Type.Union([
          Type.Literal('word-count'),
          Type.Literal('must-appear'),
          Type.Literal('banned-words'),
          Type.Literal('semantic'),
        ]),
        params: Type.Optional(
          Type.Object(
            {
              target: Type.Optional(Type.Number()),
              tol: Type.Optional(Type.Number()),
              element: Type.Optional(Type.String()),
              words: Type.Optional(Type.Array(Type.String())),
            },
            { additionalProperties: false },
          ),
        ),
      }),
    ),
  }),

  buildSystem: () =>
    [
      '你是小说写作 CI 的「规则增强编译器」。把作者用自然语言写的一条写作规则，编译成三部分：kind、judgingGuide、checklist。',
      '',
      '【kind】判断这条规则的总体类别：',
      "- 'consistency'：人物/设定一致性（言行须符合人设、能力、背景、价值观等）。",
      "- 'continuity'：跨章连续性（时间线、前后事实、状态延续）。",
      "- 'structure'：结构/格式（分幕、视角单一、是否头跳、字数等）。",
      "- 'style'：文风/语气。",
      "- 'other'：以上都不贴切。",
      '',
      '【judgingGuide】写给审阅判官的"如何判这条规则"的指引（会被注入判官 prompt，作者可后续修改）。要具体、可操作，针对这条规则的重点。',
      '★ 若 kind = consistency，judgingGuide 必须完整包含下面这套 canon 真理政策（可改写措辞但不得弱化其约束力）：',
      '  · canon(角色/设定的 简介/正文/字段)是作者敲定的真理；正文与之冲突时，唯一合法的例外是该设定有一条【对本章已生效】的演化记录(patch)解释了这个变化。',
      '  · 一旦发现某角色言行与其设定冲突，必须调用 get_element_patches 查它的演化记录(只会返回对本章已生效的 patch)：有 patch 解释→判一致；没有→报出(advisory)，交作者裁定。',
      '  · 正文内部的叙事铺垫(退化弧、「这一次」、伏笔回收)不构成例外——只有作者写下的 patch 才算；绝不要因为「正文自己解释了」就放过无 patch 背书的冲突。',
      '  · 「从不/总是/绝不/永远/只」这类绝对设定被正文打破、且无已生效 patch → 必报；区分叙述确立的事实 vs 角色口中的话(角色撒谎不是 canon 冲突)。',
      '若 kind ≠ consistency，写贴合该类别的判定指引（如 structure 类：只看本章正文、不必取证设定）。',
      '',
      '【checklist】把规则拆成若干原子断言，每条都能被独立验证，并推断 type：',
      "- 'word-count'：字数/篇幅量化要求。params: { target: 数字, tol?: 容差 }。",
      "- 'must-appear'：要求某元素/角色必须出现。params: { element: 名称 }。",
      "- 'banned-words'：禁止出现某些词。params: { words: [词, …] }。",
      "- 'semantic'：需要语义判断的约束（人物动机、设定一致性、文风、叙事视角等），无需 params。",
      '只输出能从原文合理推断的断言，不要臆造作者没表达的约束。能机械判定的尽量归入前三类。若规则为空或无法解析，checklist 返回空数组、kind 用 other、judgingGuide 留空串。',
    ].join('\n'),

  buildUserMessage: (input) => `规则：\n${input.rule}`,
});
