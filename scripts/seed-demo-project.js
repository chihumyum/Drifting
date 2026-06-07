#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'demo-gray-tide-chronicle-v1';
const PROJECT_NAME = '灰潮纪：盐冠与黑岭';
const DEFAULT_CHAPTERS = 54;
const DEFAULT_CHAPTER_CHARS = 5600;
const CREATED_AT = '2026-06-07T00:00:00.000Z';

const CJK_IDEOGRAPH = /[㐀-䶿一-鿿]/g;
const CJK_STRIPPABLE = /[　-〿㐀-䶿一-鿿＀-￯]/g;

function usage() {
  return [
    'Usage:',
    '  node scripts/seed-demo-project.js --db /path/to/user_drifting.db --user-id USER_ID',
    '',
    'Options:',
    '  --db <path>            SQLite database file. If omitted, creates .local-data/databases/demo-user_drifting.db',
    '  --user-id <id>         Project owner user_id. Inferred from "*_drifting.db" when possible.',
    '  --chapters <n>         Chapter count. Default 54. Values below 51 are rejected.',
    '  --chapter-chars <n>    Approx raw characters per chapter. Default 5600 (~5000 UI words).',
    '  --project-id <id>      Override deterministic project id.',
    '  --purge-only           Delete the demo project/Yjs/outbox rows from this local DB and exit.',
    '  --no-migrate           Skip Drizzle migrations before seeding.',
    '  --help                 Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    db: '',
    userId: '',
    chapters: DEFAULT_CHAPTERS,
    chapterChars: DEFAULT_CHAPTER_CHARS,
    projectId: PROJECT_ID,
    migrate: true,
    purgeOnly: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--') {
      continue;
    } else if (arg === '--db') {
      out.db = next();
    } else if (arg === '--user-id') {
      out.userId = next();
    } else if (arg === '--chapters') {
      out.chapters = Number(next());
    } else if (arg === '--chapter-chars') {
      out.chapterChars = Number(next());
    } else if (arg === '--project-id') {
      out.projectId = next();
    } else if (arg === '--purge-only') {
      out.purgeOnly = true;
    } else if (arg === '--no-migrate') {
      out.migrate = false;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!Number.isInteger(out.chapters) || out.chapters < 51) {
    throw new Error('--chapters must be an integer >= 51');
  }
  if (!Number.isInteger(out.chapterChars) || out.chapterChars < 1000) {
    throw new Error('--chapter-chars must be an integer >= 1000');
  }
  out.db = resolveDbPath(out.db);
  if (!out.userId) out.userId = inferUserIdFromDb(out.db);
  return out;
}

function resolveDbPath(input) {
  if (input) return path.resolve(process.cwd(), input);
  const dir = process.env.DRIFTING_DB_DIR
    ? path.resolve(process.cwd(), process.env.DRIFTING_DB_DIR)
    : path.resolve(process.cwd(), '.local-data/databases');
  return path.join(dir, 'demo-user_drifting.db');
}

function inferUserIdFromDb(dbPath) {
  const base = path.basename(dbPath);
  if (base === 'drifting-library.db') return 'anonymous';
  if (base.endsWith('_drifting.db')) return base.slice(0, -'_drifting.db'.length);
  return 'demo-user';
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function runMigrations(db) {
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const { migrate } = require('drizzle-orm/better-sqlite3/migrator');
  const migrationsFolder = path.resolve(__dirname, '../drizzle');
  migrate(drizzle(db), { migrationsFolder });
}

function id(prefix, value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `demo-${prefix}-${slug || hashCodeUnits(String(value))}`;
}

function json(value) {
  return JSON.stringify(value);
}

function kv(entries) {
  return json(entries.map(([key, value]) => ({ key, value })));
}

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cjkCount = trimmed.match(CJK_IDEOGRAPH)?.length ?? 0;
  const latinCount = trimmed
    .replace(CJK_STRIPPABLE, ' ')
    .split(/\s+/)
    .reduce((n, token) => (/[A-Za-z0-9]/.test(token) ? n + 1 : n), 0);
  return cjkCount + latinCount;
}

function countDocWords(contentJson) {
  const doc = JSON.parse(contentJson);
  const collect = (node) => {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return node.text || '';
    return Array.isArray(node.content) ? node.content.map(collect).join(' ') : '';
  };
  return countWords(collect(doc));
}

function hashCodeUnits(input) {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

function plainDoc(paragraphs, blockPrefix, mentionTargets = []) {
  const sortedTargets = [...mentionTargets]
    .flatMap((target) => {
      const names = [target.name, ...(target.aliases || [])].filter(Boolean);
      return names.map((name) => ({ ...target, surface: name }));
    })
    .sort((a, b) => b.surface.length - a.surface.length);

  const mentions = [];
  const blocks = paragraphs.map((text, index) => {
    const blockId = `${blockPrefix}-p${String(index + 1).padStart(2, '0')}`;
    const content = markText(text, blockId, sortedTargets, mentions);
    return {
      blockId,
      text,
      node: {
        type: 'paragraph',
        attrs: { id: blockId },
        content: content.length > 0 ? content : [],
      },
    };
  });
  return {
    contentJson: json({ type: 'doc', content: blocks.map((b) => b.node) }),
    blocks,
    mentions,
  };
}

function markText(text, blockId, targets, mentions) {
  const matches = [];
  for (const target of targets) {
    let start = 0;
    while (start < text.length) {
      const at = text.indexOf(target.surface, start);
      if (at < 0) break;
      const to = at + target.surface.length;
      if (!matches.some((m) => rangesOverlap(at, to, m.from, m.to))) {
        matches.push({ from: at, to, target, text: target.surface });
      }
      start = at + target.surface.length;
    }
  }
  matches.sort((a, b) => a.from - b.from || b.to - a.to);

  const nodes = [];
  let pos = 0;
  for (const match of matches) {
    if (match.from > pos) nodes.push({ type: 'text', text: text.slice(pos, match.from) });
    nodes.push({
      type: 'text',
      text: text.slice(match.from, match.to),
      marks: [
        {
          type: 'entityLink',
          attrs: {
            targetKind: match.target.kind,
            targetId: match.target.id,
            targetBlockId: null,
          },
        },
      ],
    });
    mentions.push({
      fromBlockId: blockId,
      from: match.from,
      to: match.to,
      text: match.text,
      toKind: match.target.kind,
      toId: match.target.id,
    });
    pos = match.to;
  }
  if (pos < text.length) nodes.push({ type: 'text', text: text.slice(pos) });
  return nodes;
}

function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

function groupedMentionRows(projectId, fromKind, fromId, mentions, now) {
  const buckets = new Map();
  for (const mention of mentions) {
    const key = `${mention.fromBlockId}:${mention.toKind}:${mention.toId}`;
    const bucket = buckets.get(key) || {
      fromBlockId: mention.fromBlockId,
      toKind: mention.toKind,
      toId: mention.toId,
      spans: [],
    };
    bucket.spans.push({ from: mention.from, to: mention.to, text: mention.text });
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((bucket, index) => ({
    id: `${fromKind}-${fromId}-mention-${index + 1}`,
    projectId,
    fromKind,
    fromId,
    fromBlockId: bucket.fromBlockId,
    fromSpansJson: json(bucket.spans),
    toKind: bucket.toKind,
    toId: bucket.toId,
    createdAt: now,
    updatedAt: now,
  }));
}

const CATEGORY_DEFS = [
  {
    key: 'roles',
    name: '角色',
    color: '#b84a62',
    template: kv([
      ['阵营', ''],
      ['公开身份', ''],
      ['秘密', ''],
      ['欲望', ''],
      ['弱点', ''],
    ]),
  },
  {
    key: 'locations',
    name: '地点',
    color: '#4f8a8b',
    template: kv([
      ['地貌', ''],
      ['控制者', ''],
      ['危险', ''],
      ['风俗', ''],
    ]),
  },
  {
    key: 'factions',
    name: '家族与势力',
    color: '#8a6f3d',
    template: kv([
      ['利益', ''],
      ['盟友', ''],
      ['敌人', ''],
      ['资源', ''],
    ]),
  },
  {
    key: 'customs',
    name: '风俗与制度',
    color: '#7a5c9e',
    template: kv([
      ['适用地区', ''],
      ['执行者', ''],
      ['代价', ''],
      ['漏洞', ''],
    ]),
  },
  {
    key: 'objects',
    name: '器物与文书',
    color: '#a35f34',
    template: kv([
      ['持有者', ''],
      ['来历', ''],
      ['用途', ''],
      ['隐患', ''],
    ]),
  },
  {
    key: 'myths',
    name: '传说与信仰',
    color: '#5570a7',
    template: kv([
      ['信众', ''],
      ['禁忌', ''],
      ['历史依据', ''],
      ['误读', ''],
    ]),
  },
];

const MAIN_ROLES = [
  ['阿蕾莎·维岚', '盐冠旁支的长女，被流放到北岭作人质。', '盐冠王室', '夺回被篡改的继承誓书', '害怕自己也会把人当筹码'],
  ['宁铎·黑松', '黑松关少主，山道守军事实统帅。', '黑松家', '守住三峰道，同时摆脱盐冠债务', '会把沉默误当忠诚'],
  ['莫尔文·烛档', '鸦钟修院的抄经士，负责修补旧王朝档案。', '鸦钟修院', '证明圣契不是神谕而是账本', '相信文字胜过活人'],
  ['塞弥娅·潮眼', '雾纹海走私船长，能读懂潮汐暗号。', '白鹿商社', '把弟弟从盐狱赎出', '从不相信无代价的善意'],
  ['伊德里斯·灰冠', '摄政王，曾是先王最亲近的财政官。', '灰冠摄政府', '用铁税统一诸港', '惧怕旧誓书重现'],
  ['芙兰嘉·红砧', '红砧军团统帅，因火刑案背负恶名。', '红砧军团', '让军团拥有合法封地', '习惯先烧掉证据'],
  ['赛温·白鹿', '白鹿商社继承人，表面圆滑，暗中资助山民。', '白鹿商社', '把贸易从贵族手里夺回来', '总把亲密关系也做成契约'],
  ['赫兰·鸦母', '鸦钟修院院长，保存三朝忏悔录。', '鸦钟修院', '维持修院中立', '知道太多却不敢说全'],
  ['塔温·井盐', '盐井工会的盲眼会计。', '盐井工会', '让盐工获得迁徙权', '用假账保护真账'],
  ['萝缇·石花', '北岭向导，熟悉冻土道路和路祭。', '山民盟约', '寻找失踪的母亲', '看似玩世不恭，实则记仇极久'],
  ['卡斯帕·雾弓', '边境猎手，宁铎的旧友。', '黑松家', '查清黑松关内奸', '不愿承认自己想离开边境'],
  ['尤娜·银线', '宫廷织图师，能把密信织进旗纹。', '盐冠王室', '保存维岚血脉的证据', '把真相拆得太细，连自己也迷路'],
  ['巴彦·冻钟', '东岭牧首，掌管冬封仪式。', '山民盟约', '阻止外来军队穿越圣路', '宁愿牺牲少数人守古法'],
  ['莱萨·赤誓', '红砧军团副官，曾经是盐狱囚犯。', '红砧军团', '杀死出卖自己的审判官', '害怕被赦免后无处可去'],
  ['欧岑·断潮', '退位的海军提督，被软禁在阴盐城。', '旧海军', '找回断潮冠', '把失败归咎于天象'],
  ['蜜拉·纸鸢', '街头信使，能穿过内城水闸。', '无', '攒钱买一条合法姓氏', '把每个人的秘密都当故事'],
  ['斐烈·三钉', '铁税巡官，忠于数字胜过君主。', '灰冠摄政府', '查出盐税漏斗', '不理解怜悯的账面价值'],
  ['阿洛·灰灯', '游方修灯人，传说见过无面圣徒。', '无面教团', '找到灰灯真正的燃料', '说谎时反而最温柔'],
  ['缇安娜·雪契', '被送入修院的贵族遗孤，莫尔文的学生。', '鸦钟修院', '弄清父亲为何被除名', '把知识当作复仇'],
  ['多伦·黑麦', '山道粮商，给三方军队同时供粮。', '河税同盟', '让战争永远差一口气结束', '贪财但讨厌浪费生命'],
  ['苏赫·蓝盐', '盐井童工出身的工头。', '盐井工会', '拆掉井下债契', '不信任何贵族的承诺'],
  ['纳嘉·霜皮', '北岭草药师，掌握灰潮病的旧方。', '山民盟约', '隐瞒灰潮病源', '救人时也在筛选幸存者'],
  ['维克托·铜祷', '圣契审判官，追捕伪经。', '鸦钟修院', '证明灰潮是神罚', '最怕神并不存在'],
  ['兰瑟·盐鸥', '先王私生子传闻的核心人物。', '旧海军', '摆脱所有血统叙事', '越否认越像王子'],
];

const LOCATION_NAMES = [
  '阴盐城',
  '黑松关',
  '三峰道',
  '鸦钟修院',
  '雾纹海',
  '东岭石路',
  '灰潮滩',
  '碎湾码头',
  '白鹿市集',
  '盐狱',
  '冻钟牧场',
  '红砧营',
  '井盐下城',
  '银线织坊',
  '旧王坟场',
  '潮母礁',
  '断桥驿',
  '北风隘',
  '鹿骨河',
  '黑麦仓',
  '镜湖堡',
  '千阶灯塔',
  '石花谷',
  '灰冠宫',
];

const FACTION_NAMES = [
  '盐冠王室',
  '黑松家',
  '鸦钟修院',
  '白鹿商社',
  '灰冠摄政府',
  '红砧军团',
  '盐井工会',
  '山民盟约',
  '旧海军',
  '河税同盟',
  '无面教团',
  '银线织坊',
  '冻钟牧首团',
  '碎湾船会',
  '镜湖守备',
  '灯塔行会',
  '盐狱审判庭',
  '鹿骨驿盟',
];

const CUSTOM_NAMES = [
  '盐誓',
  '路祭',
  '灰婚',
  '冬封',
  '钟税',
  '断潮审',
  '三夜换姓',
  '灯债',
  '井下赎身',
  '黑松客权',
  '白鹿平账',
  '鸦钟沉默日',
  '雾船禁语',
  '鹿骨继承宴',
  '潮母忏',
  '铁税复核',
];

const OBJECT_NAMES = [
  '断潮冠',
  '铁税册',
  '黑松钥',
  '灰灯',
  '银线旗',
  '盐冠誓书',
  '鸦钟残页',
  '雾纹罗盘',
  '红砧火印',
  '冻钟铃',
  '白鹿账牌',
  '三峰路碑',
  '潮母骨匣',
  '盐狱锁链',
  '镜湖密函',
  '蓝盐针',
  '旧王海图',
  '鹿骨酒杯',
  '灰冠印玺',
  '无面圣像',
];

const MYTH_NAMES = [
  '潮母',
  '无面圣徒',
  '三次落雪',
  '灰潮病',
  '盐冠诅咒',
  '黑松守夜歌',
  '鸦钟末响',
  '鹿骨河神',
  '铁雨预言',
  '镜湖倒影',
  '冻钟回魂',
  '雾纹七船',
  '千阶灯火',
  '井盐地脉',
];

const STORYLINES = [
  {
    key: 'crown',
    name: '盐冠继承线',
    color: '#b84a62',
    summary:
      '阿蕾莎在阴盐城、白鹿市集与灰冠宫之间寻找被篡改的继承誓书，逐步发现铁税改革不是财政政策，而是摄政王清洗旧盟约的工具。',
    pov: ['阿蕾莎·维岚', '尤娜·银线', '赛温·白鹿', '伊德里斯·灰冠', '斐烈·三钉'],
    places: ['阴盐城', '灰冠宫', '白鹿市集', '银线织坊', '盐狱'],
  },
  {
    key: 'ridge',
    name: '北岭山道线',
    color: '#4f8a8b',
    summary:
      '宁铎守三峰道，面对山民、红砧军团、走私船会和粮商的多重压力；每一次道路开启都意味着一个旧誓要被重新定价。',
    pov: ['宁铎·黑松', '萝缇·石花', '卡斯帕·雾弓', '巴彦·冻钟', '多伦·黑麦'],
    places: ['黑松关', '三峰道', '东岭石路', '冻钟牧场', '断桥驿', '北风隘'],
  },
  {
    key: 'archive',
    name: '鸦钟圣契线',
    color: '#5570a7',
    summary:
      '莫尔文与缇安娜追查鸦钟残页，发现灰潮病、无面圣徒与先王失踪有关；圣契的每一次翻译都改变一场战争的合法性。',
    pov: ['莫尔文·烛档', '赫兰·鸦母', '缇安娜·雪契', '维克托·铜祷', '阿洛·灰灯'],
    places: ['鸦钟修院', '旧王坟场', '千阶灯塔', '潮母礁', '镜湖堡'],
  },
];

function buildElements(projectId) {
  const categories = CATEGORY_DEFS.map((category, index) => ({
    id: id('cat', category.key),
    key: category.key,
    name: category.name,
    color: category.color,
    projectId,
    contentJson: '{}',
    elementTemplateJson: '{}',
    elementTemplateKvJson: category.template,
    layoutMode: 'auto',
    gridX: index * 3,
    gridY: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }));

  const byCategory = Object.fromEntries(categories.map((category) => [category.key, []]));
  const all = [];
  const add = (categoryKey, name, summary, kvJson, options = {}) => {
    const element = {
      id: id(categoryKey.slice(0, 4), name),
      projectId,
      categoryId: id('cat', categoryKey),
      kind: 'element',
      categoryKey,
      name,
      summary,
      contentJson: '{}',
      kvJson,
      aliasesJson: json(options.aliases || []),
      groupName: options.groupName || null,
      major: Boolean(options.major),
      patchCount: options.patchCount || 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    byCategory[categoryKey].push(element);
    all.push(element);
    return element;
  };

  for (const [name, summary, faction, desire, weakness] of MAIN_ROLES) {
    add(
      'roles',
      name,
      summary,
      kv([
        ['阵营', faction],
        ['公开身份', summary],
        ['核心欲望', desire],
        ['弱点', weakness],
        ['弧线', '从把秘密当武器，到明白秘密也会反噬持有者。'],
      ]),
      { major: true, patchCount: 2, groupName: faction, aliases: [name.split('·')[0]] },
    );
  }

  const minorSurnames = ['维岚', '黑松', '白鹿', '红砧', '灰冠', '银线', '冻钟', '雾弓', '石花', '蓝盐'];
  const minorNames = [
    '艾南',
    '贝洛',
    '塞拉',
    '德温',
    '厄雅',
    '法洛',
    '格温',
    '赫汀',
    '伊珂',
    '嘉伦',
    '柯萨',
    '莉昂',
    '穆恩',
    '妮夏',
    '欧柏',
    '佩林',
    '琴娜',
    '瑞姆',
    '索恩',
    '塔雅',
  ];
  let minorIndex = 0;
  while (byCategory.roles.length < 100) {
    const family = minorSurnames[minorIndex % minorSurnames.length];
    const given = minorNames[Math.floor(minorIndex / minorSurnames.length) % minorNames.length];
    const name = `${given}·${family}`;
    const faction = FACTION_NAMES[minorIndex % FACTION_NAMES.length];
    add(
      'roles',
      name,
      `${faction}的次级人物，掌握一条局部信息或一个实际资源。`,
      kv([
        ['阵营', faction],
        ['公开身份', ['税吏', '哨兵', '药师', '船副', '抄写员', '驿长'][minorIndex % 6]],
        ['秘密', ['欠下灯债', '藏有伪姓', '见过灰潮', '替人改过账', '知道一条旧路'][minorIndex % 5]],
        ['用途', '压力测试用群像节点：可被章节、元素 patch 与关系图引用。'],
      ]),
      { groupName: faction },
    );
    minorIndex += 1;
  }

  LOCATION_NAMES.forEach((name, index) => {
    add(
      'locations',
      name,
      `${name}是灰潮纪中的关键空间，承担政治、地貌与民俗三重压力。`,
      kv([
        ['地貌', ['盐雾港城', '针叶山隘', '冻土石路', '潮汐礁群', '地下盐井'][index % 5]],
        ['控制者', FACTION_NAMES[index % FACTION_NAMES.length]],
        ['危险', ['灰潮病', '塌方', '走私', '旧誓审判', '粮税暴动'][index % 5]],
        ['叙事功能', ['继承证据', '山道战争', '档案谜题', '贸易谈判'][index % 4]],
      ]),
      { major: index < 10, patchCount: index < 10 ? 2 : 0 },
    );
  });

  FACTION_NAMES.forEach((name, index) => {
    add(
      'factions',
      name,
      `${name}在盐税、山道或圣契解释权上拥有明确利益。`,
      kv([
        ['利益', ['继承合法性', '道路通行权', '盐税分账', '圣契解释权', '海贸垄断'][index % 5]],
        ['资源', ['兵权', '账册', '路权', '船队', '仪式权威', '矿井'][index % 6]],
        ['主要敌人', FACTION_NAMES[(index + 5) % FACTION_NAMES.length]],
        ['妥协底线', '只要核心资源不被公开剥夺，就会在局部章节里交易。'],
      ]),
      { major: index < 10, patchCount: index < 10 ? 2 : 0 },
    );
  });

  CUSTOM_NAMES.forEach((name, index) => {
    add(
      'customs',
      name,
      `${name}是一套会影响继承、通行、婚约或税务的地方规则。`,
      kv([
        ['适用地区', LOCATION_NAMES[index % LOCATION_NAMES.length]],
        ['执行者', FACTION_NAMES[(index + 2) % FACTION_NAMES.length]],
        ['代价', ['一袋盐', '三夜沉默', '公开账册', '血亲担保', '放弃旧姓'][index % 5]],
        ['漏洞', '外地人常把它当迷信，本地人则把它当法律。'],
      ]),
      { major: index < 6, patchCount: index < 6 ? 1 : 0 },
    );
  });

  OBJECT_NAMES.forEach((name, index) => {
    add(
      'objects',
      name,
      `${name}是推动证据、权力或信仰转移的实体物件。`,
      kv([
        ['当前持有者', MAIN_ROLES[index % MAIN_ROLES.length][0]],
        ['来历', ['先王遗物', '修院复制品', '走私抵押物', '山民祭器', '摄政府公文'][index % 5]],
        ['用途', ['证明血统', '开启路门', '记录欠税', '识别灰潮', '召集旧军'][index % 5]],
        ['隐患', '任何人只要公开使用它，就会同时暴露一条更旧的债。'],
      ]),
      { major: index < 10, patchCount: index < 10 ? 2 : 0 },
    );
  });

  MYTH_NAMES.forEach((name, index) => {
    add(
      'myths',
      name,
      `${name}既是信仰，也是被不同势力挪用的政治语言。`,
      kv([
        ['信众', FACTION_NAMES[(index + 3) % FACTION_NAMES.length]],
        ['禁忌', ['不可直呼真名', '不可在盐井点灯', '不可跨过第三场雪', '不可让钟响四次'][index % 4]],
        ['历史依据', ['旧王坟场铭文', '鸦钟残页', '山民口传', '海图边注'][index % 4]],
        ['误读', '传说中的神迹往往是财政、疫病或道路工程的残影。'],
      ]),
      { major: index < 6, patchCount: index < 6 ? 1 : 0 },
    );
  });

  return { categories, byCategory, all };
}

function attachElementBodies(elements, mentionTargets) {
  for (const element of elements.all) {
    const paragraphs =
      element.major || element.categoryKey === 'roles'
        ? majorElementParagraphs(element)
        : minorElementParagraphs(element);
    const doc = plainDoc(paragraphs, `${element.id}-body`, mentionTargets);
    element.contentJson = doc.contentJson;
    element.bodyMentions = doc.mentions;
  }
}

function majorElementParagraphs(element) {
  return [
    `${element.name}的公开记录故意写得干净：只列身份、归属和一两句能被审判庭接受的履历。但在灰潮纪里，真正有用的是记录之间的缝隙。${element.name}每次出场都要同时承担一个外部目标和一个隐藏代价，读者能看到行动，却要到后续章节才理解账目为何这样平。`,
    `围绕${element.name}的矛盾来自三组压力：盐税与血统、道路与饥荒、圣契与伪经。任何一方试图把它简化成忠诚或背叛，都会误判。这个元素的正文故意保留可扩展空间，后续 patch 会把章节里的变化沉淀为局部正史。`,
    `写作时使用${element.name}要注意两点。第一，外号、别称和正式称谓代表不同权力场合；第二，${element.name}知道的信息永远少于读者在全局图上看到的信息。这样同一件物在不同章节里会形成误读，而不是简单重复设定。`,
  ];
}

function minorElementParagraphs(element) {
  return [
    `${element.name}是支撑大型项目密度的中层设定。它不一定承担主线转折，但会给章节提供可追踪的地点、风俗、物证或人际压力。`,
    `在正文中引用${element.name}时，它应当带来一个具体限制：道路是否能走、账册是否可信、仪式是否必须完成，或者某个角色是否因此背上一笔新债。`,
  ];
}

function buildStorylines(projectId) {
  return STORYLINES.map((line, index) => {
    const doc = plainDoc(
      [
        `${line.name}围绕“谁有资格解释秩序”展开。表面问题是继承、山道或圣契，深层问题是旧王朝把道德写成契约后，后人是否还能把契约改回道德。`,
        `${line.summary}这条线的节奏不是单纯升级冲突，而是每隔几章改变一次证据的意义：同一份账册、同一条道路、同一个仪式，会在不同阵营手中变成完全不同的武器。`,
        `终局时，${line.name}必须和另外两条线合流。盐冠继承需要山道粮路支持，山道战争需要圣契合法化，圣契真相则需要王权保护才能公开。`,
      ],
      `demo-storyline-${line.key}`,
    );
    return {
      id: id('story', line.key),
      projectId,
      name: line.name,
      color: line.color,
      summary: line.summary,
      orderKey: index,
      contentJson: doc.contentJson,
      kvJson: kv([
        ['主视角', line.pov.join(' / ')],
        ['核心冲突', ['继承与财政', '道路与饥荒', '信仰与档案'][index]],
        ['终局合流', '第48章以后与另外两条主线互相证明。'],
      ]),
      nodeContentTemplateJson: '{}',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      bodyMentions: doc.mentions,
    };
  });
}

function buildOutlineNode(projectId, mentionTargets) {
  const paragraphs = [
    `《${PROJECT_NAME}》总纲：故事发生在灰潮之后的盐冠诸港。先王失踪，摄政王伊德里斯·灰冠以铁税册重整财政；北岭的黑松关掌握通往内陆粮仓的三峰道；鸦钟修院保管的圣契则决定每一次继承、审判和赦免是否合法。`,
    `三条主线互相嵌套。盐冠继承线以阿蕾莎·维岚为中心，她从人质变成证据的持有人；北岭山道线以宁铎·黑松为中心，他发现守路不是军事问题，而是把饥饿、仪式和债务同时压在一条山脊上；鸦钟圣契线以莫尔文·烛档为中心，他要证明神谕其实是被反复改写的财政档案。`,
    `第一幕（1-18章）：建立权力格局。阴盐城宣布铁税复核，黑松关准备冬封，鸦钟修院发现鸦钟残页缺了同一枚印。角色们都以为自己面对的是地方危机，实际上三处危机都指向盐冠誓书被调包。`,
    `第二幕（19-36章）：证据开始互相否定。阿蕾莎得到银线旗，却发现旗纹证明的是另一个人的继承权；宁铎打开东岭石路救粮，却放进红砧军团；莫尔文找回残页，却发现灰潮病的记录被故意写成神罚。`,
    `第三幕（37-54章）：所有阵营必须公开下注。断潮冠、黑松钥、铁税册和鸦钟残页各自只能证明一部分真相，只有当三条主线在千阶灯塔汇合时，才会显示先王失踪不是失败，而是一次未完成的退位仪式。`,
    `世界观规则：任何誓言都必须有物证，任何物证都必须有见证人，任何见证人都可以被债务污染。角色之间的冲突应尽量落在具体制度上，例如盐誓、路祭、灰婚、冬封、钟税、铁税复核，而不是抽象地谈忠诚。`,
    `写作口吻：冷静、具象、带有政治账目感。山道景色需要成为制度压力的一部分：碎石、冻雾、驮铃、路祭灰烬、边境雪线，都要提示通行权的代价。宫廷场景则强调盐雾、织旗、印玺、水闸和账册。修院场景强调纸张、钟声、刮除痕、译注和沉默。`,
    `可录制 GIF 的展示点：项目拥有超过五十章正文、上百角色、六类元素、大量跨章节引用与元素 patch。打开任一主要角色如阿蕾莎·维岚、宁铎·黑松、莫尔文·烛档，都能看到基础设定、kv facts、章节沉淀 patch 与反向引用。`,
  ];
  for (let i = 0; i < 10; i += 1) {
    paragraphs.push(
      `后续伏笔 ${i + 1}：${OBJECT_NAMES[i]}表面属于${MAIN_ROLES[i][0]}，但真正使它生效的是${CUSTOM_NAMES[i]}。当它在第${10 + i * 3}章再次出现时，读者应意识到早期场景不是装饰，而是一次延迟兑现的契约。`,
    );
  }
  const doc = plainDoc(paragraphs, 'demo-outline-drift', mentionTargets);
  return {
    id: id('node', 'outline'),
    projectId,
    title: `总纲：${PROJECT_NAME}`,
    summary: '三条主线、六类元素、五十四章的结构总纲，用 drift node 保存。',
    bookOrder: null,
    narrativeOrder: 0,
    wordCount: countDocWords(doc.contentJson),
    writingStatus: 'drifting',
    kind: 'drift',
    positionX: -420,
    positionY: -160,
    contentJson: doc.contentJson,
    outlineJson: '[]',
    blocks: doc.blocks,
    mentions: doc.mentions,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function buildChapters(projectId, storylines, elements, mentionTargets, count, targetChars) {
  const chapters = [];
  for (let order = 1; order <= count; order += 1) {
    const storyline = storylines[(order - 1) % storylines.length];
    const arc = Math.floor((order - 1) / 18) + 1;
    const slot = Math.floor((order - 1) / 3);
    const povName = STORYLINES[(order - 1) % STORYLINES.length].pov[slot % 5];
    const placeName = STORYLINES[(order - 1) % STORYLINES.length].places[slot % STORYLINES[(order - 1) % STORYLINES.length].places.length];
    const companionName = pickCompanion(order, povName);
    const objectName = OBJECT_NAMES[(order + slot) % OBJECT_NAMES.length];
    const customName = CUSTOM_NAMES[(order + arc) % CUSTOM_NAMES.length];
    const factionName = FACTION_NAMES[(order + slot * 2) % FACTION_NAMES.length];
    const mythName = MYTH_NAMES[(order * 2 + arc) % MYTH_NAMES.length];
    const title = chapterTitle(order, storyline.name, povName, objectName, customName);
    const summary = chapterSummary(order, arc, povName, placeName, objectName, customName, factionName);
    const paragraphTexts = generateChapterParagraphs({
      order,
      arc,
      slot,
      title,
      storyline,
      povName,
      companionName,
      placeName,
      objectName,
      customName,
      factionName,
      mythName,
      targetChars,
    });
    const doc = plainDoc(paragraphTexts, `demo-ch${String(order).padStart(2, '0')}`, mentionTargets);
    chapters.push({
      id: id('node', `chapter-${String(order).padStart(2, '0')}`),
      projectId,
      title,
      summary,
      bookOrder: order * 5,
      narrativeOrder: order * 10,
      wordCount: countDocWords(doc.contentJson),
      writingStatus: order % 9 === 0 ? 'revising' : order % 7 === 0 ? 'finished' : 'draft',
      kind: 'chapter',
      positionX: 120 + (order % 18) * 180,
      positionY: 80 + ((order - 1) % 3) * 160,
      storylineId: storyline.id,
      secondaryStorylineId: order % 6 === 0 ? storylines[(order + 1) % storylines.length].id : null,
      contentJson: doc.contentJson,
      outlineJson: json([
        { id: `${order}-a`, title: '进入场景', summary: `${povName}抵达${placeName}，发现${customName}被重新解释。` },
        { id: `${order}-b`, title: '证据翻转', summary: `${objectName}把${factionName}牵入本章冲突。` },
        { id: `${order}-c`, title: '尾声钩子', summary: `${mythName}的传闻留下跨线伏笔。` },
      ]),
      blocks: doc.blocks,
      mentions: doc.mentions,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  }
  return chapters;
}

function pickCompanion(order, povName) {
  const pool = MAIN_ROLES.map((r) => r[0]).filter((name) => name !== povName);
  return pool[(order * 5) % pool.length];
}

function chapterTitle(order, _storylineName, _povName, _objectName, customName) {
  const nouns = ['盐雾', '石路', '残页', '灯债', '冻钟', '潮线', '铁雨', '黑钥', '白账'];
  const suffix = nouns[order % nouns.length];
  return `第${String(order).padStart(2, '0')}章 ${suffix}之${customName}`;
}

function chapterSummary(order, arc, povName, placeName, objectName, customName, factionName) {
  return `第${order}章属于第${arc}幕：${povName}在${placeName}处理${customName}引发的冲突，${objectName}把${factionName}的隐秘利益带到台前。`;
}

function generateChapterParagraphs(spec) {
  const state = {
    debt: ['盐债', '路债', '灯债', '血债', '钟债'][spec.order % 5],
    weather: ['冻雾', '斜雪', '盐雨', '灰潮后的湿风', '贴地的山岚'][spec.order % 5],
    evidence: ['刮除的印痕', '重复的账目', '错位的见证人', '被盐水泡皱的签名', '多出来的一行译注'][spec.slot % 5],
    pressure: ['粮队滞留', '军令提前', '继承宴延期', '修院封门', '船会抬价'][spec.order % 5],
  };
  const base = [
    `清晨的${spec.placeName}被${state.weather}压得很低。${spec.povName}沿着石阶或栈道往前走，靴底粘着细盐和黑泥，远处的驮铃像被冻住的钟声。这里的道路从来不是风景，它决定谁能把粮食送到城里，谁必须把孩子抵给盐井，谁又能在${spec.customName}之后仍然保留自己的姓。`,
    `${spec.companionName}在路边等他，披风上别着一枚并不属于自己的扣针。两人没有立刻谈${spec.objectName}，而是先数经过关卡的车轴；在盐冠诸港，车轴比誓言可靠，因为每一道泥痕都会在账册里留下影子。${spec.povName}明白，今天的问题不是谁说谎，而是谁拥有让谎言变成制度的权力。`,
    `负责盘查的是${spec.factionName}的人。他们把${spec.customName}解释成临时税令，要求每支队伍交出一名见证人和两袋蓝盐。山民在火堆旁沉默，商人把算盘拨得很轻，红砧士兵则故意让甲片互相摩擦。每一种声音都在提醒${spec.povName}：战争不一定从拔剑开始，也可能从一条新格式的收据开始。`,
    `${spec.objectName}第一次被拿出来时，所有人都假装没看见。它被包在灰布里，边缘有盐霜，正面刻着旧王朝的短句，背面却有摄政府近年才使用的缩写。${spec.povName}没有伸手，只让${spec.companionName}读出那行字，因为在${spec.placeName}，亲手触碰证物就等于承认自己是证词的一部分。`,
    `关于${spec.mythName}的传闻在队伍里传开。有人说这是神罚，有人说是修院为了抬高钟税编出的故事，还有人说${spec.mythName}其实是一种旧病名，被贵族改写成了圣迹。${spec.povName}不急着判断真假；他更在意传闻流向哪里，因为谣言像雪水，总会沿着最低的债务缝隙流下去。`,
    `午后，${spec.placeName}的道路显出东欧山地般的冷硬：杉林被削成倾斜的黑线，碎石路绕过裸露的山脊，车轮在冰壳里压出窄窄的银槽。远方村落的烟不往上升，而是贴着坡面横移，像有人把整座山放进未干的墨里。${spec.povName}在这片景色中看到的不是辽阔，而是每一步通行都被计算过的狭窄。`,
    `${spec.customName}的主持人宣读旧条文时，故意跳过第三句。${spec.companionName}听见了，${spec.povName}也听见了，但两人都没有当场指出。第三句规定外来军队不得在冬封前越过路碑，若公开提醒，就会逼${spec.factionName}立刻承认自己已经违法；若暂时沉默，则可以看清还有哪些人跟着违法。`,
    `傍晚的谈判被安排在一间矮屋里。屋梁挂满干草药和旧路牌，桌上只有盐、水、黑麦面包和一盏灰灯。${spec.povName}把每个人的座位记在心里：靠门的人准备逃，靠窗的人准备传信，背对火的人不怕被看见表情。${spec.objectName}被放在桌心，像一块还没判明归属的骨头。`,
    `${spec.factionName}提出的条件听上去合理：先交税，再放粮，最后由鸦钟修院补写见证。问题在于补写见证这四个字。${spec.povName}想起莫尔文·烛档说过，所有灾难都喜欢披上补写的外衣，因为补写意味着原本存在的空白已经被允许消失。`,
    `冲突真正爆发时，没有人喊口号。一名盐井工人突然跪下，撕开袖子给众人看灰潮病留下的斑痕；一名红砧士兵立刻后退，像看见火药；白鹿商社的账房则低头把刚才那页账撕掉。${spec.povName}意识到${state.evidence}不是意外，而是有人故意让不同恐惧在同一刻相撞。`,
    `${spec.companionName}把${spec.povName}拉到屋后，声音压得很低。他说${spec.objectName}上的缩写和盐冠誓书的失踪日期相差三天，而那三天里，${spec.placeName}的路祭记录被改过两次。三天在普通账册里只是空格，在继承法里却足以让一个孩子从合法变成伪名。`,
    `夜里，山道上的火把一支支熄灭。${spec.povName}听见远处有人唱黑松守夜歌，歌词被风吹断，只剩“不要把钟带过第三场雪”反复回到耳边。他忽然理解为什么老人们害怕${spec.mythName}：不是因为神会出现，而是因为神话让人们有借口不承认自己亲手改过账。`,
    `本章的第一个选择落在${spec.povName}面前：公开${spec.objectName}，就能暂时压住${spec.factionName}，但会让${spec.companionName}暴露；隐藏它，则粮队可能在北风里冻死。灰潮纪里的选择很少是善恶对照，更多是把一种伤害换成另一种伤害，并要求角色记住自己亲手换过。`,
    `他最终没有宣布胜利，只要求重新举行${spec.customName}。这个决定看似保守，却改变了在场所有人的身份：商人从旁观者变成见证人，士兵从执法者变成被审者，修院抄写员从记录者变成未来的证据。${spec.povName}知道，真正的政治不是让敌人闭嘴，而是让敌人的每句话都必须写进同一本册子。`,
    `重举行仪式时，${spec.placeName}的风停了一瞬。盐被撒在门槛上，黑麦面包被掰成三份，灰灯照出每个人脸上不同方向的阴影。${spec.objectName}在灯下显出第二层刻痕，那不是文字，而是一段被磨掉的路标编号。${spec.companionName}立刻明白，证据指向的不是王座，而是一条被取消的旧路。`,
    `消息在午夜传来：${state.pressure}。这意味着本章所有谈判都只是前奏，真正的压力从下一章开始。${spec.povName}把${spec.objectName}重新包好，忽然觉得它比早晨重了许多；不是因为金属吸了水，而是因为它已经开始吸收人的命运。`,
    `尾声里，一个无名信使穿过${spec.placeName}的背街，把写有${spec.mythName}的纸条塞进墙缝。纸条没有署名，只画着鸦钟修院的短羽标记和白鹿商社的账牌。这个细节不会在本章得到解释，但会在后续章节里回到阿蕾莎·维岚、宁铎·黑松和莫尔文·烛档面前，迫使三条主线互相作证。`,
  ];

  const expansions = [
    `补记一：${spec.povName}后来回想这一日时，记住的不是争吵，而是${spec.placeName}路边那些被雪压弯的木桩。每根木桩都刻着曾经交过路税的家族名，有些名字已经无人认领，有些名字被新漆覆盖。政治在这里不是宫廷里一句命令，而是旧名被刮掉时木屑落进雪里的声音。`,
    `补记二：${spec.customName}的老规矩要求见证人喝一口盐水。${spec.companionName}喝得太快，咳嗽时把袖口里的纸灰抖了出来。${spec.povName}看见纸灰上有银线织坊的蓝色纤维，便知道这件事已经穿过宫廷、商社和修院，不再只是${spec.placeName}的一场地方争执。`,
    `补记三：${spec.factionName}的代表在离开前留下半句威胁，说铁税册会记住今天所有人的名字。${spec.povName}没有回答。他想，账册当然会记住名字，但账册不会记住饥饿、冻伤、失去路权后的沉默；而他要做的，正是把这些账册不愿记的东西变成另一种证据。`,
    `补记四：关于${spec.mythName}，本地孩子有另一种说法。他们说它不会惩罚坏人，只会让撒谎的人在梦里反复走同一条路，直到承认自己在哪里转了弯。${spec.povName}听完没有笑，因为他知道大人们所谓的政治判断，有时也不过是拒绝承认自己已经迷路。`,
    `补记五：当夜的火堆旁，萝缇·石花给众人讲东岭石路的旧故事：那条路不是为了军队修的，而是为了把盐井病人送到高处等死。后来贵族嫌故事难听，便把它改成英雄开路。${spec.objectName}上的路标编号，使这个被改写的故事忽然有了可以核对的边角。`,
    `补记六：${spec.povName}在账册页边写下三个词：谁付款，谁见证，谁沉默。这三个问题会贯穿整部《${PROJECT_NAME}》。每当一个角色说自己只是服从法律，读者都应该回到这三个词，看见法律背后那只正在拨算盘的手。`,
  ];

  const paragraphs = [...base];
  let i = 0;
  while (paragraphs.join('').length < spec.targetChars) {
    paragraphs.push(expansions[i % expansions.length]);
    i += 1;
  }
  return paragraphs;
}

function buildPatches(projectId, elements, chapters, mentionTargets) {
  const patches = [];
  const patchable = elements.all.filter((element) => element.patchCount > 0);
  for (const [elementIndex, element] of patchable.entries()) {
    for (let n = 0; n < element.patchCount; n += 1) {
      const chapter = chapters[(elementIndex * 3 + n * 7) % chapters.length];
      const block = chapter.blocks[(2 + n * 5) % chapter.blocks.length];
      const title = `${element.name}：第${String(chapter.bookOrder / 5).padStart(2, '0')}章沉淀 ${n + 1}`;
      const paragraphs = [
        `${chapter.title}之后，${element.name}的状态发生局部变化。这个 patch 不覆盖基础设定，只把章节中已经发生的事实沉淀为可供后续 Shadow、Agent 或人工查阅的增量正史。`,
        `来源段落显示：${block.text.slice(0, 140)}…… 该段把${element.name}和${chapter.title}中的证据链连接起来，后续若正文改写，应检查这个 patch 是否仍然有效。`,
      ];
      const doc = plainDoc(paragraphs, `${element.id}-patch-${n + 1}`, mentionTargets);
      patches.push({
        id: `${element.id}-patch-${n + 1}`,
        projectId,
        elementId: element.id,
        sourceNodeId: chapter.id,
        sourceBlockId: block.blockId,
        sourceBlockText: block.text,
        textAnchorJson: null,
        invalidatedAt: null,
        title,
        contentJson: doc.contentJson,
        orderKey: n,
        mentions: doc.mentions,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
    }
  }
  return patches;
}

function buildRelations(projectId, elements, chapters) {
  const rows = [];
  const add = (fromKind, fromId, toKind, toId, kind) => {
    rows.push({
      id: `demo-rel-${rows.length + 1}`,
      projectId,
      fromKind,
      fromId,
      toKind,
      toId,
      kind,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  };

  const roles = elements.byCategory.roles;
  const factions = elements.byCategory.factions;
  const locations = elements.byCategory.locations;
  const objects = elements.byCategory.objects;
  const customs = elements.byCategory.customs;

  roles.forEach((role, index) => {
    add('element', role.id, 'element', factions[index % factions.length].id, '隶属/交易');
    add('element', role.id, 'element', locations[(index * 2) % locations.length].id, '常驻/出没');
    if (index < objects.length) add('element', role.id, 'element', objects[index].id, '持有/追索');
  });
  factions.forEach((faction, index) => {
    add('element', faction.id, 'element', locations[index % locations.length].id, '控制');
    add('element', faction.id, 'element', customs[index % customs.length].id, '执行');
  });
  for (let i = 0; i < chapters.length - 1; i += 1) {
    add('node', chapters[i].id, 'node', chapters[i + 1].id, 'reading-next');
  }
  for (let i = 0; i < chapters.length; i += 4) {
    add('node', chapters[i].id, 'element', objects[i % objects.length].id, '证物出现');
    add('node', chapters[i].id, 'element', customs[i % customs.length].id, '制度触发');
  }
  return rows;
}

function buildDemo(options) {
  const projectId = options.projectId;
  const elements = buildElements(projectId);
  const mentionTargets = elements.all.map((element) => ({
    kind: 'element',
    id: element.id,
    name: element.name,
    aliases: JSON.parse(element.aliasesJson),
  }));
  attachElementBodies(elements, mentionTargets);
  const storylines = buildStorylines(projectId);
  const outline = buildOutlineNode(projectId, mentionTargets);
  const chapters = buildChapters(
    projectId,
    storylines,
    elements,
    mentionTargets,
    options.chapters,
    options.chapterChars,
  );
  const patches = buildPatches(projectId, elements, chapters, mentionTargets);
  const relations = buildRelations(projectId, elements, chapters);
  const project = {
    id: projectId,
    name: PROJECT_NAME,
    summary:
      '大型原创群像奇幻 demo：三条故事线、五十四章、百名角色、六类元素、地点/制度/物件/信仰交叉引用，用于压力测试 Drifting 的长篇项目能力。',
    kvJson: kv([
      ['本书目标', '复杂群像政治奇幻，突出本地写作工具的大型项目组织能力。'],
      ['文风', '冷静、具象、带制度压力的中文叙述。'],
      ['写作人称', '第三人称有限视角，章节随主线轮换 POV。'],
      ['章节目标字数', String(options.chapterChars)],
      ['写法', '每章推进一个制度冲突、一个物证变化、一个跨线伏笔。'],
      ['对标作品', '原创，不复刻具体作品；复杂度参考多线政治奇幻。'],
    ]),
    storylineTemplateKvJson: kv([
      ['主视角', ''],
      ['核心冲突', ''],
      ['终局合流', ''],
    ]),
    userId: options.userId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return { project, elements, storylines, nodes: [outline, ...chapters], chapters, patches, relations };
}

function purgeProject(db, projectId) {
  const nodeIds = rows(db, 'SELECT id FROM book_node WHERE project_id = ?', [projectId]).map((r) => r.id);
  const elementIds = rows(db, 'SELECT id FROM element WHERE project_id = ?', [projectId]).map((r) => r.id);
  const storylineIds = rows(db, 'SELECT id FROM storylines WHERE project_id = ?', [projectId]).map((r) => r.id);
  const categoryIds = rows(db, 'SELECT id FROM element_category WHERE project_id = ?', [projectId]).map((r) => r.id);
  const docIds = [
    ...nodeIds.map((x) => `node-content:${x}`),
    ...elementIds.map((x) => `element:${x}`),
    ...storylineIds.map((x) => `storyline:${x}`),
    ...categoryIds.map((x) => `category:${x}`),
  ];

  deleteWhereIn(db, 'yjs_updates', 'document_id', docIds);
  deleteWhereIn(db, 'yjs_snapshots', 'document_id', docIds);
  deleteWhereIn(db, 'yjs_sync_cursor', 'doc_id', docIds);
  deleteWhereIn(db, 'node_storyline_link', 'node_id', nodeIds);
  deleteWhereIn(db, 'node_content', 'node_id', nodeIds);

  for (const table of [
    'inline_mention',
    'entity_relation',
    'element_patch',
    'block_section',
    'comment_action',
    'comment',
    'library_item',
    'shadow_job',
    'project_rule',
    'local_sync_mutation',
    'book_node',
    'element',
    'storylines',
    'element_category',
  ]) {
    if (tableExists(db, table) && columnExists(db, table, 'project_id')) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
  }
  if (tableExists(db, 'project')) {
    db.prepare('DELETE FROM project WHERE id = ?').run(projectId);
  }
}

function rows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function tableExists(db, table) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function deleteWhereIn(db, table, column, values) {
  if (!tableExists(db, table) || values.length === 0) return;
  const stmt = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
  for (const value of values) stmt.run(value);
}

function insertDemo(db, demo) {
  const tx = db.transaction(() => {
    purgeProject(db, demo.project.id);

    db.prepare(
      `INSERT INTO project (id, name, summary, kv_json, storyline_template_kv_json, user_id, created_at, updated_at)
       VALUES (@id, @name, @summary, @kvJson, @storylineTemplateKvJson, @userId, @createdAt, @updatedAt)`,
    ).run(demo.project);

    const insertCategory = db.prepare(
      `INSERT INTO element_category
       (id, name, content_json, element_template_json, element_template_kv_json, color, project_id, layout_mode, grid_x, grid_y, created_at, updated_at)
       VALUES (@id, @name, @contentJson, @elementTemplateJson, @elementTemplateKvJson, @color, @projectId, @layoutMode, @gridX, @gridY, @createdAt, @updatedAt)`,
    );
    for (const category of demo.elements.categories) insertCategory.run(category);

    const insertStoryline = db.prepare(
      `INSERT INTO storylines
       (id, project_id, name, color, summary, order_key, content_json, kv_json, node_content_template_json, created_at, updated_at)
       VALUES (@id, @projectId, @name, @color, @summary, @orderKey, @contentJson, @kvJson, @nodeContentTemplateJson, @createdAt, @updatedAt)`,
    );
    for (const storyline of demo.storylines) insertStoryline.run(storyline);

    const insertElement = db.prepare(
      `INSERT INTO element
       (id, project_id, category_id, name, summary, content_json, kv_json, aliases_json, group_name, created_at, updated_at)
       VALUES (@id, @projectId, @categoryId, @name, @summary, @contentJson, @kvJson, @aliasesJson, @groupName, @createdAt, @updatedAt)`,
    );
    for (const element of demo.elements.all) insertElement.run(element);

    const insertNode = db.prepare(
      `INSERT INTO book_node
       (id, title, summary, book_order, narrative_order, project_id, word_count, writing_status, kind, created_at, updated_at, position_x, position_y)
       VALUES (@id, @title, @summary, @bookOrder, @narrativeOrder, @projectId, @wordCount, @writingStatus, @kind, @createdAt, @updatedAt, @positionX, @positionY)`,
    );
    const insertContent = db.prepare(
      `INSERT INTO node_content (node_id, content_json, outline_json, created_at, updated_at)
       VALUES (@nodeId, @contentJson, @outlineJson, @createdAt, @updatedAt)`,
    );
    for (const node of demo.nodes) {
      insertNode.run(node);
      insertContent.run({
        nodeId: node.id,
        contentJson: node.contentJson,
        outlineJson: node.outlineJson,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      });
    }

    const insertLink = db.prepare(
      `INSERT INTO node_storyline_link (node_id, storyline_id, is_primary)
       VALUES (@nodeId, @storylineId, @isPrimary)`,
    );
    for (const chapter of demo.chapters) {
      insertLink.run({ nodeId: chapter.id, storylineId: chapter.storylineId, isPrimary: 1 });
      if (chapter.secondaryStorylineId) {
        insertLink.run({
          nodeId: chapter.id,
          storylineId: chapter.secondaryStorylineId,
          isPrimary: 0,
        });
      }
    }

    const insertPatch = db.prepare(
      `INSERT INTO element_patch
       (id, project_id, element_id, source_node_id, source_block_id, source_block_text, text_anchor_json, invalidated_at, title, content_json, order_key, created_at, updated_at)
       VALUES (@id, @projectId, @elementId, @sourceNodeId, @sourceBlockId, @sourceBlockText, @textAnchorJson, @invalidatedAt, @title, @contentJson, @orderKey, @createdAt, @updatedAt)`,
    );
    for (const patch of demo.patches) insertPatch.run(patch);

    const insertRelation = db.prepare(
      `INSERT INTO entity_relation
       (id, project_id, from_kind, from_id, to_kind, to_id, kind, created_at, updated_at)
       VALUES (@id, @projectId, @fromKind, @fromId, @toKind, @toId, @kind, @createdAt, @updatedAt)`,
    );
    for (const relation of demo.relations) insertRelation.run(relation);

    const mentionRows = collectMentionRows(demo);
    const insertMention = db.prepare(
      `INSERT INTO inline_mention
       (id, project_id, from_kind, from_id, from_block_id, from_spans_json, to_kind, to_id, created_at, updated_at)
       VALUES (@id, @projectId, @fromKind, @fromId, @fromBlockId, @fromSpansJson, @toKind, @toId, @createdAt, @updatedAt)`,
    );
    for (const mention of mentionRows) insertMention.run(mention);
  });
  tx();
}

function collectMentionRows(demo) {
  const out = [];
  for (const node of demo.nodes) {
    out.push(...groupedMentionRows(demo.project.id, 'node', node.id, node.mentions, CREATED_AT));
  }
  for (const element of demo.elements.all) {
    out.push(
      ...groupedMentionRows(demo.project.id, 'element', element.id, element.bodyMentions || [], CREATED_AT),
    );
  }
  for (const storyline of demo.storylines) {
    out.push(
      ...groupedMentionRows(
        demo.project.id,
        'storyline',
        storyline.id,
        storyline.bodyMentions || [],
        CREATED_AT,
      ),
    );
  }
  for (const patch of demo.patches) {
    out.push(...groupedMentionRows(demo.project.id, 'patch', patch.id, patch.mentions, CREATED_AT));
  }
  return out.map((row, index) => ({ ...row, id: `demo-inline-${index + 1}` }));
}

function printStats(db, projectId) {
  const q = (table) => db.prepare(`SELECT count(*) as n FROM ${table} WHERE project_id = ?`).get(projectId).n;
  const nodeCount = q('book_node');
  const chapterCount = db
    .prepare("SELECT count(*) as n FROM book_node WHERE project_id = ? AND kind = 'chapter'")
    .get(projectId).n;
  const driftCount = db
    .prepare("SELECT count(*) as n FROM book_node WHERE project_id = ? AND kind = 'drift'")
    .get(projectId).n;
  const wordCount = db
    .prepare("SELECT coalesce(sum(word_count), 0) as n FROM book_node WHERE project_id = ?")
    .get(projectId).n;
  console.log(`Seeded ${PROJECT_NAME}`);
  console.log(`  project_id     ${projectId}`);
  console.log(`  nodes          ${nodeCount} (${chapterCount} chapters, ${driftCount} drift)`);
  console.log(`  words/chars    ${wordCount}`);
  console.log(`  categories     ${q('element_category')}`);
  console.log(`  elements       ${q('element')}`);
  console.log(`  storylines     ${q('storylines')}`);
  console.log(`  patches        ${q('element_patch')}`);
  console.log(`  relations      ${q('entity_relation')}`);
  console.log(`  inline refs    ${q('inline_mention')}`);
}

function main() {
  const options = parseArgs(process.argv);
  ensureDir(options.db);
  const Database = require('better-sqlite3');
  const db = new Database(options.db);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    if (options.migrate) runMigrations(db);
    if (options.purgeOnly) {
      purgeProject(db, options.projectId);
      console.log(`Purged local demo project ${options.projectId} from ${options.db}`);
      return;
    }
    const demo = buildDemo(options);
    insertDemo(db, demo);
    console.log(`DB ${options.db}`);
    console.log(`user_id ${options.userId}`);
    printStats(db, demo.project.id);
  } finally {
    db.close();
  }
}

module.exports = {
  buildDemo,
  PROJECT_ID,
  PROJECT_NAME,
  DEFAULT_CHAPTERS,
  DEFAULT_CHAPTER_CHARS,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
}
