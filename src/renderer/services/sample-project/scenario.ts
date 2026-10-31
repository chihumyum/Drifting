// The sample project recipe: a deterministic workspace of original synthetic
// names and prose, expressed as the same journaled workspace tools the General
// Agent uses. The development seed (src/dev-cli/seed.ts) runs it headless; the
// app runs its built-in variant once for a new local library
// (./built-in-sample.ts).

import { allocateSeedLengths, SEED_PRESETS, type SeedPreset } from './presets';
import { createSeedMarkdown, createSeedProse, seedProsePlainText } from './prose';

export const SEED_STORYLINES = ['灯塔的秘密', '老船长的旧账', '潮汐档案'] as const;
const places = ['北岬', '旧码头', '盐仓', '渡轮站', '观潮台', '气象站', '修船厂', '防波堤', '白沙湾', '灯塔'];
const clues = ['缺页日志', '黄铜钥匙', '停摆的钟', '旧海图', '录音带', '潮位记录', '航标灯', '未寄出的信', '船票', '玻璃浮标'];
const chapterTopics = ['雾中来客', '夜航信号', '空白海图', '盐仓回声', '玻璃浮标', '失约的船', '雨夜电报', '南岸来信', '隐没的航道', '第二盏灯', '封存档案', '倒转的钟', '旧日证词', '避风港', '无名礁', '潮痕', '风暴前夕', '回航', '灯下重逢', '黎明的海'];
const phases = ['归岛', '寻访', '追潮', '风暴', '回灯'];

export const SEED_CATEGORIES = [
  ['人物', '岛民', '巡潮员', '轮机师', '邮递员', '档案员'],
  ['地点', '潮沟', '堤岸', '水闸', '礁洞', '岗亭'],
  ['组织', '船队', '工会', '观测组', '救援队', '档案室'],
  ['物品', '钥匙', '罗盘', '煤油灯', '水密盒', '铜哨'],
  ['事件', '夜航', '停电', '失联', '封港', '交接'],
  ['线索', '脚印', '盐渍', '指纹', '断绳', '划痕'],
  ['传说', '海铃', '归舟', '白鲸', '沉钟', '守灯人'],
  ['制度', '轮值表', '航行令', '封存令', '值夜规程', '港务约定'],
  ['技术', '灯镜', '潮尺', '发报机', '声呐', '雾号'],
  ['交通', '渡轮', '小艇', '拖船', '索道', '栈桥'],
  ['建筑', '灯室', '仓房', '泵房', '钟楼', '信号屋'],
  ['自然', '涌浪', '海雾', '暗流', '季风', '磷光'],
  ['习俗', '开灯礼', '送船节', '守潮夜', '迎风宴', '补网日'],
  ['文献', '航海日记', '报纸', '检修册', '口述稿', '值班簿'],
  ['声音', '汽笛', '钟声', '脚步', '电流声', '雨声'],
  ['意象', '微光', '空椅', '绳结', '灯影', '水线'],
] as const;

export function seedChapterTitle(index: number): string {
  return ['第一章 潮声', '第二章 北岬', '第三章 退潮'][index]
    ?? `第${String(index + 1).padStart(3, '0')}章 ${phases[Math.floor(index / 20)]}·${chapterTopics[index % 20]}`;
}

const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1–99 as Chinese numerals: 四, 十二, 二十. */
function chineseNumeral(value: number): string {
  if (value < 10) return chineseDigits[value];
  const tens = Math.floor(value / 10), ones = value % 10;
  return `${tens === 1 ? '' : chineseDigits[tens]}十${ones ? chineseDigits[ones] : ''}`;
}

/**
 * Chapter titles. The development seed keeps its zero-padded, phase-prefixed
 * titles (performance scripts look chapters up by them); the built-in sample
 * numbers every chapter alike: 第一章 潮声 … 第四章 盐仓回声.
 */
export function sampleChapterTitle(index: number, variant: SampleProjectVariant): string {
  if (variant === 'development' || index >= 99) return seedChapterTitle(index);
  return ['第一章 潮声', '第二章 北岬', '第三章 退潮'][index]
    ?? `第${chineseNumeral(index + 1)}章 ${chapterTopics[index % 20]}`;
}

/**
 * `development` is the dev-seed profile (`pnpm dev:seed`); `built-in` is the
 * first-run sample a new library receives. They share every chapter, element,
 * relation and review item; only development bookkeeping differs.
 */
export type SampleProjectVariant = 'development' | 'built-in';

/** The name the first-run sample project is created with. */
export const BUILT_IN_SAMPLE_PROJECT_NAME = '潮汐灯塔（示例）';

export function sampleProjectName(preset: SeedPreset, variant: SampleProjectVariant): string {
  if (variant === 'built-in') return BUILT_IN_SAMPLE_PROJECT_NAME;
  return preset.name === 'stress' ? '潮汐灯塔（重型性能样本）' : '潮汐灯塔（轻量功能样本）';
}

export function createDefaultProjectScenario(
  preset: SeedPreset = SEED_PRESETS.stress,
  variant: SampleProjectVariant = 'development',
) {
  const steps: Array<{
    kind: 'workspace.call'; tool: string; input: Record<string, unknown>; expect: { ok: boolean };
  }> = [];
  const call = (tool: string, input: Record<string, unknown>) => {
    steps.push({ kind: 'workspace.call', tool, input, expect: { ok: true } });
  };
  const storylines = SEED_STORYLINES.slice(0, preset.storylines.count);
  const chapterTitle = (index: number) => sampleChapterTitle(index, variant);
  const chapterLengths = allocateSeedLengths(preset.chapters, 101);
  const elementLengths = allocateSeedLengths(preset.elements, 102);
  const inspirationLengths = allocateSeedLengths(preset.inspirations, 103);
  const storylineLengths = allocateSeedLengths(preset.storylines, 104);
  const categoryLengths = allocateSeedLengths(preset.categories, 105);
  const chapterBodies = chapterLengths.map((length, i) => createSeedMarkdown(length, 1_000 + i));
  call('update_project_facts', { facts: [
    { key: '类型', value: '海岛悬疑' }, { key: '叙事视角', value: '第三人称限知，跟随林潮' },
    ...(variant === 'development'
      ? [{ key: '开发样本', value: preset.name === 'stress' ? '重型：性能与稳定性验证' : '轻量：快速功能验证' }]
      : []),
  ] });
  for (const [i, name] of storylines.entries()) call('create_storyline', {
    name, summary: `${name}：林潮、老船长与气象站的调查相互交错。`,
    body: createSeedMarkdown(storylineLengths[i], 2_000 + i),
  });
  for (let i = 0; i < preset.chapters.count; i++) call('create_chapter', {
    title: chapterTitle(i),
    summary: `林潮在${places[i % places.length]}核对${clues[i % clues.length]}，发现一段尚未解释的航程。`,
    body: chapterBodies[i],
  });
  for (let i = 0; i < preset.chapters.count; i++) {
    const primary = i % storylines.length;
    call('add_chapter_to_storyline', { chapter: chapterTitle(i), storyline: storylines[primary] });
    if (i % 5 === 0) call('add_chapter_to_storyline', { chapter: chapterTitle(i), storyline: storylines[(primary + 1) % storylines.length] });
  }
  const categories = SEED_CATEGORIES.slice(0, preset.categories.count);
  for (const [i, [name]] of categories.entries()) call('create_element_category', {
    name, body: createSeedMarkdown(categoryLengths[i], 3_000 + i),
  });
  const elementNames: string[] = [];
  for (let i = 0; i < preset.elements.count; i++) {
    const category = categories[i % categories.length];
    const serial = Math.floor(i / categories.length);
    const place = places[serial % places.length];
    const name = ['林潮', '老船长', '北岬灯塔'][i]
      ?? `${place}${category[1 + serial % 5]}·${String(serial + 1).padStart(2, '0')}`;
    elementNames.push(name);
    call('create_element', {
      category: i < 2 ? categories[0][0] : i === 2 ? categories[1][0] : category[0],
      name, aliases: [`${category[0]}档案${String(i + 1).padStart(3, '0')}`],
      summary: `${place}的${category[0]}记录，与${clues[serial % clues.length]}有关。`,
      body: createSeedMarkdown(elementLengths[i], 4_000 + i),
      facts: [{ key: '登记地', value: place }, { key: '档案编号', value: `BJ-${String(i + 1).padStart(3, '0')}` }],
    });
  }
  // Ideas (构想). The seed numbers its 200 stress ideas to keep titles unique;
  // the ten built-in ones each pair a place with its own clue.
  for (let i = 0; i < preset.inspirations.count; i++) call('create_inspiration', {
    title: variant === 'development'
      ? `构想${String(i + 1).padStart(3, '0')} · ${places[i % places.length]}的${clues[Math.floor(i / places.length) % clues.length]}`
      : `${places[i % places.length]}的${clues[i % clues.length]}`,
    summary: `${storylines[i % storylines.length]}的备选片段：让${elementNames[i % elementNames.length]}改变一次调查方向。`,
    body: createSeedMarkdown(inspirationLengths[i], 5_000 + i),
  });
  call('create_relation_type', { name: '出场于', orientation: 'directed', sourceRole: '要素', targetRole: '章节', sourceKinds: ['element'], targetKinds: ['chapter'] });
  call('create_relation_type', { name: '呼应', orientation: 'symmetric', sourceRole: '要素', targetRole: '要素', sourceKinds: ['element'], targetKinds: ['element'] });
  for (const [i, name] of elementNames.entries()) {
    call('create_relation', { fromType: 'element', fromName: name, toType: 'chapter', toName: chapterTitle((i * 7 + 3) % preset.chapters.count), relationType: '出场于' });
    if (i % 5 === 0) call('create_relation', { fromType: 'element', fromName: name, toType: 'element', toName: elementNames[(i + 1) % elementNames.length], relationType: '呼应' });
  }
  for (const kind of ['todo', 'note'] as const) {
    const lengths = allocateSeedLengths(kind === 'todo' ? preset.todos : preset.comments, kind === 'todo' ? 106 : 107);
    for (const [i, length] of lengths.entries()) {
      const chapterIndex = i * 7 % preset.chapters.count;
      const target = i % 4 === 0 ? {} : i % 4 === 1
        ? { targetType: 'element', targetName: elementNames[i * 3 % elementNames.length] }
        : { targetType: 'chapter', targetName: chapterTitle(chapterIndex) };
      call('create_comment', {
        kind, ...target,
        ...(i % 10 === 2 && 'targetType' in target && target.targetType === 'chapter'
          ? { targetText: chapterBodies[chapterIndex].split('\n\n')[1] } : {}),
        body: seedProsePlainText(createSeedProse(length, 6_000 + i + (kind === 'note' ? 1_000 : 0))),
      });
    }
  }
  call('create_project_memory', {
    body: variant === 'development'
      ? '作者偏好短句，场景描写克制，对白少而准。所有内容均为开发用合成材料。'
      : '作者偏好短句，场景描写克制，对白少而准。',
  });
  return {
    schemaVersion: 1 as const,
    name: variant === 'development' ? `${preset.name}-development-project` : `${preset.name}-built-in-sample`,
    steps,
  };
}
