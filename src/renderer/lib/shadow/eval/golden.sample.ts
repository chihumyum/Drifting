/**
 * A small but real-shaped golden project, used until you export your own polished
 * novel to this format (see README). Two chapters, two elements, three rules — one
 * mechanical (banned-words, no LLM) and two semantic (POV, handedness). The
 * mechanical rule makes part of the eval runnable with NO key.
 *
 * The golden is authored CLEAN (zero violations under its rules). Mutations below
 * inject known faults whose expected verdict is true by construction.
 */
import type { EvalProject } from './model';
import {
  changeDependency,
  changeDependencyIrrelevant,
  cleanBaseline,
  contradictInProse,
  injectBannedWord,
  injectBlock,
  type ExpectFlag,
  type Mutation,
} from './mutations';

const R_BANNED = 'rule-banned';
const R_POV = 'rule-pov';
const R_FACT = 'rule-fact';

export function goldenSample(): EvalProject {
  return {
    projectId: 'eval-sample',
    facts: {
      人称视角: '第三人称限知（仅奥伦视角）',
      时代背景: '架空冷兵器，无现代器物',
    },
    elements: [
      { id: 'el-grey', name: '奥伦', facts: { 惯用手: '左手', 身份: '退役剑士' } },
      { id: 'el-sword', name: '青鳞剑', facts: { 材质: '寒铁', 持有者: '奥伦' } },
    ],
    rules: [
      {
        id: R_BANNED,
        checklist: [
          {
            id: 'bn1',
            assertion: '禁止出现现代网络用语',
            type: 'banned-words',
            params: { words: ['卧槽', '尼玛', 'OK'] },
          },
        ],
      },
      {
        id: R_POV,
        checklist: [
          {
            id: 'pov1',
            assertion:
              '全文须保持第三人称限知视角，只呈现奥伦本人的所见所感；写出其他角色的内心活动、或奥伦当时不可能知道的信息，即为违反（头跳/全知）。',
            type: 'semantic',
          },
        ],
      },
      {
        id: R_FACT,
        checklist: [
          {
            id: 'fact1',
            assertion:
              '人物的手部动作（握剑、挥剑、持物等）须与该角色设定中的「惯用手」一致；写成与设定相反的那只手即为违反。',
            type: 'semantic',
          },
        ],
      },
    ],
    chapters: [
      {
        id: 'ch1',
        title: '第一章·夜访',
        summary: '奥伦夜里独自值守，察觉门外有人。',
        blocks: [
          { id: 'b1-1', text: '奥伦用左手握住青鳞剑，寒铁的凉意顺着掌心爬上来。' },
          { id: 'b1-2', text: '他听见门外有脚步声，却看不清来人是谁。' },
          { id: 'b1-3', text: '心跳骤然加快，他屏住呼吸，等那道身影靠近。' },
        ],
      },
      {
        id: 'ch2',
        title: '第二章·追击',
        summary: '奥伦追出门外，与黑影周旋。',
        blocks: [
          { id: 'b2-1', text: '奥伦左手提剑冲出门，夜风灌进衣襟。' },
          { id: 'b2-2', text: '那道黑影翻过墙头，他紧追不舍。' },
          { id: 'b2-3', text: '他不知道墙后还藏着什么，只能凭直觉向前。' },
        ],
      },
    ],
  };
}

const ALL_PAIRS: Omit<ExpectFlag, 'shouldFlag'>[] = [
  { chapterId: 'ch1', ruleId: R_BANNED },
  { chapterId: 'ch1', ruleId: R_POV },
  { chapterId: 'ch1', ruleId: R_FACT },
  { chapterId: 'ch2', ruleId: R_BANNED },
  { chapterId: 'ch2', ruleId: R_POV },
  { chapterId: 'ch2', ruleId: R_FACT },
];

/** Mechanical-only mutations — exact, no LLM (the no-key plumbing/regression set). */
export function deterministicMutations(): Mutation[] {
  return [
    cleanBaseline(ALL_PAIRS.filter((p) => p.ruleId === R_BANNED)),
    injectBannedWord('m-banned', 'ch1', 'b1-2', 'OK', R_BANNED),
  ];
}

/** Full labeled corpus — mechanical + semantic + dependency changes (needs a key
 *  for the semantic/dep cases). */
export function sampleMutations(): Mutation[] {
  return [
    cleanBaseline(ALL_PAIRS),
    injectBannedWord('m-banned', 'ch1', 'b1-2', 'OK', R_BANNED),
    injectBlock('m-headhop', 'ch1', '门外的黑衣人按住刀柄，心中冷笑：奥伦插翅难逃。', R_POV, '注入头跳 · ch1'),
    contradictInProse('m-fact', 'ch1', 'b1-1', '左手', '右手', R_FACT),
    // canon flips 左→右, prose in BOTH chapters still says 左 → both go stale.
    changeDependency('m-dep', '奥伦', '惯用手', '右手', [
      { chapterId: 'ch1', ruleId: R_FACT },
      { chapterId: 'ch2', ruleId: R_FACT },
    ]),
    // unrelated fact (剑材质) → both chapters must stay clean (false-positive guard).
    changeDependencyIrrelevant('m-dep-irrel', '青鳞剑', '材质', '玄铁', [
      { chapterId: 'ch1', ruleId: R_FACT },
      { chapterId: 'ch2', ruleId: R_FACT },
    ]),
  ];
}
