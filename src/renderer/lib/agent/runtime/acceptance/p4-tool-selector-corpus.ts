import type {
  ToolSearchMetadataByName,
} from '../tool-selector';

export interface ToolSelectorAcceptanceIntent {
  id: string;
  query: string;
  expectedTool: string;
  safety?: boolean;
}

/**
 * Product vocabulary kept outside the canonical executable catalog. These
 * phrases improve retrieval without creating provider-visible aliases or a
 * second authorization surface.
 */
export const P4_TOOL_SEARCH_METADATA: ToolSearchMetadataByName = {
  get_overview: {
    searchIntents: [
      'orient across the whole book',
      'start a full book task',
      '全书鸟瞰',
      '开始全书任务',
      '宏观查看整部小说内容',
    ],
  },
  get_project_brief: {
    searchIntents: [
      'book premise and author facts',
      'project setup brief',
      '作品简介与设定事实',
      '项目基础设定',
    ],
  },
  list_nodes: {
    searchIntents: [
      'browse chapter and drift titles',
      'show manuscript structure',
      '列出章节和漂流节点',
      '查看章节目录',
    ],
  },
  list_elements: {
    searchIntents: [
      'browse characters settings and objects',
      'list story bible entities',
      '列出角色设定物件',
      '查看元素目录',
    ],
  },
  read_element: {
    searchIntents: [
      'inspect one character profile',
      'read story bible entity detail',
      '查看单个角色档案',
      '读取元素详情',
      '查看单个物件正文与事实',
    ],
  },
  get_element_patches: {
    searchIntents: [
      'trace character evolution across chapters',
      'accepted entity state changes',
      '追踪角色跨章演变',
      '查看元素状态补丁',
    ],
  },
  read_node: {
    searchIntents: [
      'read one chapter prose',
      'open numbered manuscript paragraphs',
      '只读章节正文',
      '打开节点正文',
    ],
  },
  read_block: {
    searchIntents: [
      'inspect one live paragraph by block id',
      'read exact yjs block',
      '按块标识读取实时段落',
      '查看单个正文块',
    ],
  },
  lookup_block: {
    searchIntents: [
      'find stable block id from paragraph number',
      'locate paragraph handle by text',
      '按段号查找块标识',
      '定位正文段落句柄',
    ],
  },
  get_storyline: {
    searchIntents: [
      'inspect one plot thread',
      'read storyline members and facts',
      '读取一条故事线详情',
      '查看情节线成员章节',
    ],
  },
  get_entity_relations: {
    searchIntents: [
      'inspect graph edges around an entity',
      'follow curated story relationships',
      '只查看实体关系边',
      '读取故事图谱关系',
    ],
  },
  where_does_entity_appear: {
    searchIntents: [
      'find chapters mentioning a character',
      'locate entity appearances in prose',
      '查角色在哪些章节出场',
      '定位实体提及位置',
    ],
  },
  search_prose: {
    searchIntents: [
      'full text search manuscript',
      'find phrase inside chapter prose',
      '全文搜索小说正文',
      '在段落内容中检索',
    ],
  },
  search_project: {
    searchIntents: [
      'search project titles and metadata',
      'find entity by name without prose',
      '搜索标题和简介元数据',
      '快速查找项目实体名',
    ],
  },
  list_comments: {
    searchIntents: [
      'browse open notes and todos',
      'inspect unresolved annotations',
      '只列出开放批注待办',
      '查看作者评论标记',
    ],
  },
  list_memory: {
    searchIntents: [
      'inspect agent preferences and instructions',
      'show remembered author decisions',
      '只查看长期记忆',
      '列出写作偏好与否决',
    ],
  },
  list_materials: {
    searchIntents: [
      'browse research library titles',
      'list reference assets',
      '列出素材库目录',
      '查看参考资料清单',
    ],
  },
  read_material: {
    searchIntents: [
      'open one research source',
      'read reference material content',
      '读取单份素材全文',
      '打开一个参考资料',
    ],
  },
  rename_node: {
    searchIntents: [
      'rename a chapter or drift',
      'change manuscript node title',
      '重命名章节或漂流',
      '修改节点标题',
    ],
  },
  set_node_summary: {
    searchIntents: [
      'change chapter synopsis',
      'update node summary only',
      '修改章节梗概',
      '设置节点摘要',
    ],
  },
};

function intents(
  expectedTool: string,
  queries: readonly (string | { query: string; safety: true })[],
): ToolSelectorAcceptanceIntent[] {
  return queries.map((entry, index) => ({
    id: `${expectedTool}-${String(index + 1).padStart(2, '0')}`,
    query: typeof entry === 'string' ? entry : entry.query,
    expectedTool,
    safety: typeof entry === 'string' ? undefined : entry.safety,
  }));
}

/**
 * 150 bilingual, non-empty intents. Ten tool groups contain eight cases and
 * ten contain seven cases, so accidental fixture shrinkage is caught exactly.
 */
export const P4_TOOL_SELECTOR_CORPUS: readonly ToolSelectorAcceptanceIntent[] =
  Object.freeze([
    ...intents('get_overview', [
      '开始分析整本书前先给我一个全书鸟瞰',
      'I need orientation across the whole book',
      '准备全书任务，先汇总所有主要目录',
      'show the complete project overview',
      '从宏观上看看这部小说有哪些内容',
      'before a book-wide task gather the overview',
      '全书概览包含设定故事线章节与元素',
      'get_overview',
    ]),
    ...intents('get_project_brief', [
      '这本书的简介和作者设定事实是什么',
      'show the project setup brief',
      '读取作品 premise 和基础统计',
      'what are the author facts for this book',
      '项目名称简介以及 key value 设定',
      'summarize the book premise without opening prose',
      '给我项目基础设定',
      'get_project_brief',
    ]),
    ...intents('list_nodes', [
      '列出全部章节和 drift 标题',
      'browse the manuscript chapter list',
      '给我看看小说的章节目录',
      'show nodes with status and word counts',
      '有哪些章节与漂流灵感节点',
      'inspect the manuscript structure by title',
      {
        query: '不要重命名任何章节，只查看当前节点清单',
        safety: true,
      },
      'list_nodes',
    ]),
    ...intents('list_elements', [
      '列出角色设定和重要物件',
      'browse all story bible entities',
      '这个项目有哪些角色',
      'show element names grouped by category',
      '查看人物地点物件目录',
      'list characters settings and objects',
      '元素类目清单',
      'list_elements',
    ]),
    ...intents('read_element', [
      '读取林默这个角色的详细档案',
      'inspect one character profile and facts',
      '打开元素详情看看别名和简介',
      'read the full story bible entry for an entity',
      '查看某个物件的正文与结构化事实',
      'show one setting element in detail',
      {
        query: '绝对不要删除角色，先只读取这个元素的详情',
        safety: true,
      },
      'read_element',
    ]),
    ...intents('get_element_patches', [
      '追踪这个角色跨章节的状态演变',
      'show accepted entity changes over time',
      '这个人物在各章发生过哪些变化',
      'read element evolution patches',
      '查看角色的来源章节与变更正文',
      'trace setting updates across the manuscript',
      '元素状态补丁列表',
      'get_element_patches',
    ]),
    ...intents('read_node', [
      '打开第一章并按段读取正文',
      'read one chapter prose',
      '查看这个 drift 的正文内容',
      'show numbered manuscript paragraphs',
      '只读取节点表头不要正文',
      'open the prose for a named chapter',
      {
        query: '不要编辑或追加内容，只读当前章节正文',
        safety: true,
      },
      'read_node',
    ]),
    ...intents('read_block', [
      '按 blockId 读取这一段实时正文',
      'inspect one exact live paragraph',
      '查看稳定块标识对应的文字',
      'read the Yjs block without changing it',
      '这个正文块现在是什么类型和文本',
      'open a single block by its uuid',
      {
        query: 'do not edit the paragraph, only inspect the live block',
        safety: true,
      },
      'read_block',
    ]),
    ...intents('lookup_block', [
      '按第三段查找稳定 blockId',
      'locate a paragraph handle from its text',
      '我只有段号，需要找到正文块标识',
      'find block id containing this phrase',
      '通过文本片段定位段落句柄',
      'look up the live block uuid by ordinal',
      '查找段落但不要补写新的 id',
      'lookup_block',
    ]),
    ...intents('get_storyline', [
      '读取爱情线的梗概和成员章节',
      'inspect one plot thread',
      '这条故事线有哪些结构化事实',
      'show storyline detail and ordered chapters',
      '查看主线的成员节点',
      'read facts for a named narrative thread',
      '故事线详情',
      'get_storyline',
    ]),
    ...intents('get_entity_relations', [
      '查看这个角色周围的图谱关系边',
      'inspect incoming and outgoing entity relations',
      '沿着作者策展的故事关系继续探索',
      'show graph edges touching this entity',
      '读取角色与地点之间的关系',
      {
        query: '不要新增或删除关系，只查看实体关系边',
        safety: true,
      },
      'get_entity_relations',
    ]),
    ...intents('where_does_entity_appear', [
      '这个角色在哪些章节里出现',
      'find prose mentions of an entity',
      '定位某件物品的出场位置',
      'which chapters mention this setting',
      '按来源汇总人物提及次数和片段',
      {
        query: '删除角色前先确认它在哪些章节出场',
        safety: true,
      },
      'where_does_entity_appear',
    ]),
    ...intents('search_prose', [
      '在所有小说正文中全文搜索这句话',
      'find this phrase inside manuscript paragraphs',
      '搜索章节内容而不是标题',
      'full text search the prose',
      '在元素正文和章节正文里检索关键词',
      'search paragraph text case insensitively',
      'search_prose',
    ]),
    ...intents('search_project', [
      '按名字快速搜索项目实体',
      'find a chapter title without scanning prose',
      '搜索元素简介和别名元数据',
      'project metadata search',
      '查找标题里含有月亮的节点',
      'search storyline and entity names',
      'search_project',
    ]),
    ...intents('list_comments', [
      '列出开放的批注和 TODO',
      'show unresolved author annotations',
      '查看这个章节上的评论',
      'browse comments filtered by status',
      '只看作者标记的待办事项',
      {
        query: '不要删除或解决待办，只列出当前开放批注',
        safety: true,
      },
      'list_comments',
    ]),
    ...intents('list_memory', [
      '列出 Agent 记住的写作偏好',
      'show remembered author decisions',
      '有哪些长期指令和否决',
      'inspect active and pending agent memories',
      '查看项目记忆清单',
      {
        query: '不要遗忘任何内容，只读取长期记忆',
        safety: true,
      },
      'list_memory',
    ]),
    ...intents('list_materials', [
      '列出素材库里的全部标题',
      'browse research library assets',
      '有哪些参考资料和来源',
      'show material titles grouped by kind',
      '查看图片 PDF 链接和文本素材目录',
      'list reference sources without opening them',
      'list_materials',
    ]),
    ...intents('read_material', [
      '打开这一份研究素材的全文',
      'read one reference source',
      '查看指定素材标题对应的内容',
      'open a single library material',
      '读取这份 text 素材',
      {
        query: '不要删除素材，先打开并读取这份参考资料',
        safety: true,
      },
      'read_material',
    ]),
    ...intents('rename_node', [
      '把第一章重命名为潮汐',
      'rename this chapter title',
      '修改 drift 节点的名称',
      'change manuscript node title only',
      '给这个章节换一个新名字',
      'rename_node',
      '重命名章节或漂流',
    ]),
    ...intents('set_node_summary', [
      '把这一章的梗概改成新的摘要',
      'update the chapter synopsis only',
      '设置节点 summary',
      'change the drift summary',
      '修改章节简介但不要动标题',
      {
        query: '不要改正文，只设置当前节点摘要',
        safety: true,
      },
      'set_node_summary',
    ]),
  ]);
