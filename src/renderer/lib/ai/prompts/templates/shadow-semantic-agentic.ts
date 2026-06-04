import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// The agentic variant of the semantic judge (shadow-semantic-eval). Instead of a
// single shot over a fixed background, this judge runs in a loop: each round it
// either (a) RULES — returns violations and sets done=true — or (b) asks for more
// canon it needs first (done=false + requests). The harness fetches the requested
// evidence with the project's read tools, appends it, and re-invokes — so a deep
// rule (POV limits, cross-chapter continuity, a setting bible in a drift node) can
// pull exactly the ground-truth it needs before judging, while a shallow rule
// still rules in one round (no cost regression).
//
// Output is NOT a discriminated union (those are brittle under forced-tool JSON);
// it's a flat object with a `done` flag gating which arm the harness reads:
//   done=false → act on `requests`, ignore `violations`
//   done=true  → act on `violations`, ignore `requests`
export const shadowSemanticAgenticPrompt = definePrompt({
  id: 'shadow-semantic-agentic',
  version: 1,
  model: 'gemini-3.5-flash',
  description:
    '取证式语义审阅：判官可先索取 element/drift/前文章节等设定证据，再判断章节是否违反一条语义约束。',

  input: Type.Object({
    assertion: Type.String(),
    context: Type.String(),
    blocks: Type.String(),
    catalog: Type.String(),
    evidence: Type.String(),
    mustDecide: Type.Boolean(),
  }),

  output: Type.Object({
    done: Type.Boolean({
      description:
        'true=证据已足够，本轮直接给出最终裁决（violations）；false=还需更多设定证据，先在 requests 列出',
    }),
    requests: Type.Array(
      Type.Object({
        kind: Type.String({
          description:
            '证据类型，取值之一：element（角色/物件档案+设定facts）｜element_evolution（该element的跨章状态演变/patches）｜drift（某 drift 节点全文，先看目录里的 summary 再决定是否索取）｜chapter（某章正文，用于跨章连续性核对）',
        }),
        name: Type.String({ description: '目标的名称/标题，照抄「可用证据目录」中的名字' }),
        why: Type.String({ description: '一句话：为判断这条约束，为什么需要它' }),
      }),
      { description: 'done=false 时填写：本轮需要先取回的证据（建议 ≤4 条，只取真正需要的）' },
    ),
    violations: Type.Array(
      Type.Object({
        violated: Type.Boolean({ description: 'true=该段确实违反约束；false=不违反（会被丢弃）' }),
        blockStart: Type.Number({ description: '违反范围起始段编号（1 起）；0=整章级、无法定位到具体段' }),
        blockEnd: Type.Number({ description: '违反范围结束段编号（含）；单段时与 blockStart 相同；整章级为 0' }),
        reason: Type.String({ description: '一句话说明为什么违反约束（解释原因，不要照抄原文）' }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      { description: 'done=true 时填写：最终裁决。整章都满足时为空数组。' },
    ),
  }),

  buildSystem: () =>
    [
      '你是小说写作 CI 的取证式审阅器。给你一条「约束」、一段「背景设定」、一份「可用证据目录」、若干「已取回证据」、和一章正文（按段编号）。',
      '你可以分多轮工作。每一轮二选一：',
      '1) 还缺设定才能判 → done=false，在 requests 里列出要取回的证据（照抄目录里的名字）。系统会取回后让你再看一轮。',
      '2) 证据已足够 → done=true，在 violations 里给出最终裁决。',
      '',
      '何时该取证（务必克制，只取真正影响判断的）：',
      '- element：要核对某角色/物件的设定、能力边界、身份（如「视角角色不该知道的事」「用了不该会的能力」）。',
      '- element_evolution：要核对某 element 跨章的状态变化（如某物已损毁/某人已离开/已习得）。',
      '- drift：目录里的 drift 节点可能装着设定集或额外规则；先读它的 summary，相关才索取全文。',
      '- chapter：要核对跨章连续性（如前文已死、时间线、此前已发生/未发生的事）。',
      '克制原则：能直接判就别取证，done=true 一轮结束。只在约束确实依赖你手上没有的设定时才 requests。已取回过的证据不要重复索取。',
      '',
      '裁决（done=true 时）规则，与单轮审阅一致：',
      '- violated：true=该段确实违反；false=不违反。只有 true 的会被采用。不确定、依据不足一律 false。',
      '- 连续若干段因同一原因违反，合并成一条（blockStart/blockEnd 表示连续范围，含两端，单段时相同）。不连续或原因不同的分多条。',
      '- blockStart/blockEnd：段落编号（1 起）。整章级、无法定位到具体段时两者都用 0。',
      '- reason：一句话解释为什么违反（不要照抄原文）。confidence：把握 0~1。',
      '- 重要：不要把"符合/未违反"的段落作为 violation 输出。整章都满足时返回空 violations。宁可漏报也别误报。',
      '- 当被告知"必须裁决"时，不要再 requests，用现有证据 done=true 给出裁决。',
    ].join('\n'),

  buildUserMessage: (input) =>
    [
      `约束：${input.assertion}`,
      '',
      `背景设定：\n${input.context}`,
      '',
      `可用证据目录（可按需索取，drift/章节先看 summary）：\n${input.catalog}`,
      '',
      `已取回证据：\n${input.evidence || '（暂无）'}`,
      '',
      input.mustDecide
        ? '【必须裁决】已达取证轮数上限，本轮请直接 done=true 给出最终裁决，不要再 requests。'
        : '若证据已足够请直接 done=true 裁决；否则 done=false 并在 requests 中索取证据。',
      '',
      `正文（按段编号）：\n${input.blocks}`,
    ].join('\n'),
});
