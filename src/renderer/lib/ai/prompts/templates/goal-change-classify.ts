import { Type } from '@sinclair/typebox';
import { definePrompt } from '../define-prompt';

// The semantic gate for /goal 一键演化 (shadow/GOAL-EVOLVE.md §3). Classifies one
// element-setting change so the orchestrator can decline the cases the evolve loop
// is structurally bad at. The loop's critic is contradiction-anchored (it reports
// prose that DIRECTLY contradicts the new value) — great for discrete, falsifiable
// changes (which surface as hard contradictions), blind to changes of a thing's
// fundamental ESSENCE/feel (whose wrongness lives diffusely in scene tone, not in
// any flat contradiction). An essence change would "converge" with a tiny residual
// while leaving the thing off across many scenes — a false "done". Decline those.
//
// An element is NOT necessarily a character — it can be a place, object, faction,
// rule/setting, concept. The discriminator (discrete-falsifiable vs diffuse-essence)
// is the same across all of them; only the examples differ by type.
export const goalChangeClassifyPrompt = definePrompt({
  id: 'goal-change-classify',
  version: 3,
  model: 'gemini-3.5-flash',
  description: '判断一次 element 设定改动是事实/离散型、本质/神韵型，还是二者混合（混合则拆分）。决定演化 loop 是否适用（element 可为角色/地点/物件/组织/规则等）。',

  input: Type.Object({
    elementName: Type.String(),
    field: Type.Optional(Type.String()),
    oldSetting: Type.String(),
    newSetting: Type.String(),
  }),

  output: Type.Object({
    kind: Type.Union([Type.Literal('factual'), Type.Literal('essence'), Type.Literal('mixed')], {
      description:
        'factual=离散、可被正文具体语句直接证伪的变更（硬矛盾，可逐处最小改动消解）；essence=对该事物本质/神韵/性质的根本改写（需重写场景，矛盾弥散、多为隐性）；mixed=同一改动里既有离散事实、又有本质改写',
    }),
    reason: Type.String({ description: '一句话依据' }),
    factualPart: Type.Optional(
      Type.String({
        description:
          '仅当 kind=mixed：把改动中【离散可证伪】的那部分单独提炼成一句「新值」（loop 将只针对它消解矛盾）。kind=factual/essence 时留空。',
      }),
    ),
    essencePart: Type.Optional(
      Type.String({
        description:
          '仅当 kind=mixed：把改动中【本质/神韵】的那部分单独提炼成一句（留给作者手动）。kind=factual/essence 时留空。',
      }),
    ),
  }),

  buildSystem: () =>
    [
      '你在判断小说里一次「设定(element)改动」属于哪一类，以决定能否用「机械矛盾消解」的方式把它铺到正文。',
      'element 可能是角色，也可能是地点、物件、组织、规则/设定、概念等——下面的判别标准对所有类型【通用】。',
      '',
      '核心测试：新值是不是【正文里具体语句能直接证伪】的离散属性？',
      '',
      "- 'factual'：离散、可被具体语句直接证伪的变更；正文不符会表现为【硬矛盾】，可逐处最小改动消解。跨类型示例：",
      '  · 角色：失明、死亡、改名、断腿、与某人决裂、不再拥有某物',
      '  · 地点：搬迁、被焚毁、易主、改名',
      '  · 物件：丢失、损坏、改名、易主',
      '  · 规则/设定：某能力被取消、数值/代价变更、某事从可行变不可行',
      '  · 组织：解散、改名、换领袖、阵营倒戈',
      "- 'essence'：对该事物【本质/神韵/性质】的根本改写；很少有字面硬矛盾——问题弥散在每场戏的气质里，需要重写场景而非补一行。跨类型示例：",
      '  · 角色：性格/价值观/说话声音重塑（善良→冷酷）',
      '  · 地点：整体氛围重塑（温馨小镇→压抑废墟），却无任何具体事实改变',
      '  · 物件：象征意义/分量被重新定位',
      '  · 规则/设定：魔法的整体调性从「冷峻科学」改成「狂野不可测」',
      '  · 组织：理念/气质的根本重构',
      "- 'mixed'：同一次改动里【既有离散事实变更、又有本质/神韵改写】，且两部分都实质、可分。例：「酒馆被烧毁(事实) + 从此整条街透着阴森(本质)」「断了一条腿(事实) + 整个人从开朗变阴郁(本质)」。",
      '  判 mixed 时必须【拆开】：factualPart 写离散可证伪的那部分（loop 只针对它消解矛盾）；essencePart 写本质/神韵的那部分（留给作者手动）。',
      '',
      '判别顺序：',
      '1. 主要是离散可证伪变更 → factual。',
      '2. 主要是本质/气质/性质的弥散改写、需重写而非订正 → essence。',
      '3. 两者都实质存在、且能清楚拆成两句 → mixed（并填 factualPart / essencePart）。',
      '不要轻易判 mixed：仅当本质成分【实质且可单独成句】时才拆；若本质成分只是事实变更的轻微余味，仍判 factual。拿不准 → factual。',
    ].join('\n'),

  buildUserMessage: (i) =>
    `设定《${i.elementName}》${i.field ? `（字段：${i.field}）` : ''}\n旧值：${i.oldSetting || '（未给）'}\n新值：${i.newSetting}`,
});
