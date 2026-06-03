import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// Compiles ONE freeform author rule into a checklist of atomic, checkable
// assertions. The author writes naturally (a kv-ish line or prose); this
// normalizes it and INFERS each item's type — mechanical kinds (word-count /
// must-appear / banned-words) when the rule is quantitative/lexical, else
// 'semantic'. The author never picks a type.
export const shadowRuleCompilePrompt = definePrompt({
  id: 'shadow-rule-compile',
  version: 1,
  model: 'gemini-3.5-flash',
  description: '把作者写的自由文本写作规则编译成可检查的原子 checklist。',

  input: Type.Object({
    rule: Type.String(),
  }),

  output: Type.Object({
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
      '你是小说写作 CI 的「规则编译器」。把作者用自然语言写的一条写作规则，拆成若干原子断言（checklist），每条断言都能被独立验证。',
      '为每条断言推断一个 type：',
      "- 'word-count'：关于字数/篇幅的量化要求。params: { target: 数字, tol?: 容差 }。",
      "- 'must-appear'：要求某元素/角色必须在章节中出现。params: { element: 名称 }。",
      "- 'banned-words'：禁止出现某些词。params: { words: [词, …] }。",
      "- 'semantic'：以上都不适用、需要语义判断的约束（人物动机、设定一致性、文风、叙事视角等），无需 params。",
      '只输出能从原文合理推断的断言，不要臆造作者没表达的约束。能机械判定的尽量归入前三类。若规则为空或无法解析，返回空 checklist。',
    ].join('\n'),

  buildUserMessage: (input) => `规则：\n${input.rule}`,
});
