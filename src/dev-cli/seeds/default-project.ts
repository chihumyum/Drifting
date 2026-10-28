// The only default seed: a deterministic large workspace of synthetic names
// and prose, built through the same journaled tools as the application.

export const DEVELOPMENT_SEED_COUNTS = {
  storylines: 3,
  chapters: 100,
  categories: 16,
  elements: 300,
  inspirations: 200,
  todos: 60,
  comments: 40,
  materialNotes: 60,
  conversations: 12,
  turnsPerConversation: 6,
} as const;

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

export function createDefaultProjectScenario() {
  const steps: Array<{
    kind: 'workspace.call'; tool: string; input: Record<string, unknown>; expect: { ok: boolean };
  }> = [];
  const call = (tool: string, input: Record<string, unknown>) => {
    steps.push({ kind: 'workspace.call', tool, input, expect: { ok: true } });
  };
  call('update_project_facts', { facts: [
    { key: '类型', value: '海岛悬疑' }, { key: '叙事视角', value: '第三人称限知，跟随林潮' },
  ] });
  for (const [i, name] of SEED_STORYLINES.entries()) call('create_storyline', {
    name,
    summary: [
      '林潮回到北岬，追查灯塔在大潮夜熄灭的原因。',
      '老船长二十年前的一次出海，和灯塔有关。',
      '气象站的年轻档案员整理一百天的潮位，发现记录中的时间差。',
    ][i],
    body: [
      '主线。每逢大潮，北岬灯塔都会熄灭一夜。',
      '旧日志里缺了三页，老船长始终没有说出那晚的航线。',
      '以潮位记录为线索，与林潮和老船长的调查交错推进。所有档案与潮位均为虚构。',
    ][i],
  });
  const firstChapterBodies = [
    '渡轮靠岸的时候，潮水正在退。\n\n林潮拎着箱子走下跳板，码头上只有一盏灯亮着。她抬头看向北岬，灯塔是黑的。',
    '退潮后的礁石露出水面，像一条通往灯塔的路。\n\n老船长坐在灯塔基座上补网，看见她的时候一点也不意外。“你还是回来了。”他说。',
    '日志的装订线上留着撕痕。\n\n林潮数了三遍，缺的正好是那年大潮前后的三天。',
  ];
  for (let i = 0; i < DEVELOPMENT_SEED_COUNTS.chapters; i++) {
    const place = places[i % places.length];
    const clue = clues[Math.floor(i / places.length) % clues.length];
    call('create_chapter', {
      title: seedChapterTitle(i), summary: `第${i + 1}次调查：林潮在${place}核对${clue}，${phases[Math.floor(i / 20)]}阶段出现新的时间差。`,
      body: firstChapterBodies[i] ?? [
        `## ${place}的${chapterTopics[i % 20]}`,
        `第${i + 1}天，林潮到达${place}时，海雾还没有散。远处的灯塔亮了一下，又被低云遮住。她把${clue}放在桌上，先记下时间，才打开随身的笔记本。`,
        `“你记得那晚的潮水吗？”她问。值班的人没有立刻回答，只把窗户推开一道缝。屋里有盐、柴油和旧纸混在一起的气味。墙上的值班表停在第${i + 2}号泊位交接的那一天。`,
        `档案员带来了另一份抄本。第${i + 1}行与原件相差${i % 9 + 1}分钟，字迹却出自同一只手。林潮没有把这个差异称为证据；她在页边画了一个小圈，写下“仍需核对”。`,
        `老船长指着${places[(i + 3) % places.length]}的方向说：“过去我们认那里的灯，不认钟。”他说完便沉默下来。林潮注意到他一直避开桌上的${clue}，也避开窗外的海。`,
        `午后，风转向了。${places[(i + 6) % places.length]}送来的消息提到${clues[(i + 2) % clues.length]}，这让三份原本无关的记录第一次有了交点。她在纸上列出已知的时间，把不确定的部分留白。`,
        `她沿着潮线往回走，鞋底的水在石阶上留下深色印子。每隔九秒，灯光扫过一次堤岸。第${i + 1}次经过那扇窗时，她看见玻璃里多了一个人的倒影。`,
        `这一页的最后，她只写了一句：到${places[(i + 1) % places.length]}去，确认${clues[(i + 1) % clues.length]}从谁手里经过。风把纸角掀起，下面压着的船票露出一截蓝边。`,
      ].join('\n\n'),
    });
  }
  for (let i = 0; i < DEVELOPMENT_SEED_COUNTS.chapters; i++) {
    const primary = i < 3 ? 0 : i % 3;
    call('add_chapter_to_storyline', { chapter: seedChapterTitle(i), storyline: SEED_STORYLINES[primary] });
    if (i === 1) call('add_chapter_to_storyline', { chapter: seedChapterTitle(i), storyline: SEED_STORYLINES[1] });
    if (i % 5 === 0) call('add_chapter_to_storyline', { chapter: seedChapterTitle(i), storyline: SEED_STORYLINES[(primary + 1) % 3] });
  }

  const elementNames = ['林潮', '老船长', '北岬灯塔'];
  for (const [name] of SEED_CATEGORIES) {
    call('create_element_category', { name, body: `${name}设定集：记录北岬群岛的${name}，用于交叉引用和一致性检查。` });
  }
  for (const input of [
    { category: '人物', name: '林潮', aliases: ['阿潮'], summary: '在城里做航海保险理赔的调查员，十年没回岛。', body: '不信天气预报，只信潮水。', facts: [{ key: '年龄', value: '二十七' }] },
    { category: '人物', name: '老船长', aliases: ['陈伯'], summary: '退休的渔船船长，每天在灯塔下补网。', body: '说话前总要先看一眼海。' },
    { category: '地点', name: '北岬灯塔', summary: '岛北端的老灯塔，退潮时才能步行走到。', body: '灯光每隔九秒扫过一次。' },
  ]) call('create_element', input);
  for (let i = 3; i < DEVELOPMENT_SEED_COUNTS.elements; i++) {
    const category = SEED_CATEGORIES[(i - 3) % SEED_CATEGORIES.length];
    const serial = Math.floor((i - 3) / SEED_CATEGORIES.length);
    const place = places[serial % places.length];
    const name = `${place}${category[1 + serial % 5]}·${String(serial + 1).padStart(2, '0')}`;
    elementNames.push(name);
    call('create_element', {
      category: category[0], name, aliases: [`${category[0]}档案${String(i + 1).padStart(3, '0')}`],
      summary: `${place}的${category[0]}记录，与${clues[serial % clues.length]}有关。`,
      body: `## ${name}\n\n这是北岬群岛的第${i + 1}号合成设定。林潮在${place}调查时首次记录它。\n\n### 叙事用途\n\n与${SEED_STORYLINES[i % 3]}交叉；先呈现可观察的细节，后揭示${clues[i % clues.length]}的来历。\n\n### 一致性\n\n保留旧记录的时间差，避免在第${i % 100 + 1}章以前提前揭露答案。`,
      facts: [{ key: '登记地', value: place }, { key: '档案编号', value: `BJ-${String(i + 1).padStart(3, '0')}` }],
    });
  }
  call('create_inspiration', { title: '灯塔为什么在大潮夜熄灭', summary: '也许不是故障，是有人在等船。', body: '灯塔熄灭的那一夜，海上应该有一条不想被看见的船。' });
  call('create_inspiration', { title: '撕掉的三页日志', body: '缺页的撕痕很新，撕的人最近才来过。' });
  for (let i = 2; i < DEVELOPMENT_SEED_COUNTS.inspirations; i++) {
    call('create_inspiration', {
      title: `灵感${String(i + 1).padStart(3, '0')} · ${places[i % 10]}的${clues[Math.floor(i / 10) % 10]}`,
      summary: `${SEED_STORYLINES[i % 3]}的备选片段：让${elementNames[i % elementNames.length]}改变一次调查方向。`,
      body: `如果${places[i % 10]}留下的${clues[Math.floor(i / 10) % 10]}不是遗失，而是有人刻意留下的呢？\n\n林潮可以先误读它，再在第${i % 100 + 1}章发现另一种解释。保留一个没有被解释的细节：${elementNames[(i * 7) % elementNames.length]}。\n\n备选对白：“潮水会回来，人说过的话不会。”`,
    });
  }
  call('create_relation_type', { name: '出场于', orientation: 'directed', sourceRole: '要素', targetRole: '章节', sourceKinds: ['element'], targetKinds: ['chapter'] });
  call('create_relation_type', { name: '相识', orientation: 'symmetric', sourceRole: '人物', targetRole: '人物', sourceKinds: ['element'], targetKinds: ['element'] });
  for (const [fromName, chapterIndex] of [['林潮', 0], ['老船长', 1], ['北岬灯塔', 1]] as const)
    call('create_relation', { fromType: 'element', fromName, toType: 'chapter', toName: seedChapterTitle(chapterIndex), relationType: '出场于' });
  call('create_relation', { fromType: 'element', fromName: '林潮', toType: 'element', toName: '老船长', relationType: '相识' });
  for (const [i, name] of elementNames.entries()) {
    call('create_relation', { fromType: 'element', fromName: name, toType: 'chapter', toName: seedChapterTitle((i * 7 + 20) % 100), relationType: '出场于' });
    if (i > 0 && i % 5 === 0) call('create_relation', { fromType: 'element', fromName: name, toType: 'element', toName: elementNames[(i + 1) % elementNames.length], relationType: '相识' });
  }
  call('create_comment', { kind: 'todo', targetType: 'chapter', targetName: seedChapterTitle(1), body: '补一段灯塔内部的描写。' });
  call('create_comment', { kind: 'note', targetType: 'element', targetName: '老船长', body: '他的口音要和岛上其他人不一样。' });
  call('create_comment', { kind: 'todo', body: '定下灯塔熄灭的真正原因。' });
  for (const kind of ['todo', 'note'] as const) {
    const start = kind === 'todo' ? 2 : 1;
    const count = kind === 'todo' ? DEVELOPMENT_SEED_COUNTS.todos : DEVELOPMENT_SEED_COUNTS.comments;
    for (let i = start; i < count; i++) {
      const target = i % 4 === 0 ? {} : i % 4 === 1
        ? { targetType: 'element', targetName: elementNames[i * 3 % 300] }
        : { targetType: 'chapter', targetName: seedChapterTitle(i * 7 % 100) };
      call('create_comment', {
        kind, ...target,
        ...(i % 10 === 2 && 'targetType' in target && target.targetType === 'chapter' && i * 7 % 100 >= 3 ? { targetText: '海雾还没有散。' } : {}),
        body: `${kind === 'todo' ? '修订任务' : '阅读批注'} ${String(i + 1).padStart(2, '0')}：${['核对潮位和出航时间', '补足人物动机', '减少解释性对白', '回收先前的伏笔', '明确场景的空间关系'][i % 5]}。参考${places[i % 10]}的${clues[Math.floor(i / 5) % 10]}。`,
      });
    }
  }
  call('create_project_memory', { body: '作者偏好短句，场景描写克制，对白少而准。' });
  return { schemaVersion: 1, name: 'large-development-project', steps };
}
