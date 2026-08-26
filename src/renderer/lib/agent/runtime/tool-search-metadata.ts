import type { ToolSearchMetadataByName } from './tool-selector';

/**
 * Product vocabulary for retrieving canonical Agent tools.
 *
 * These phrases are search-only metadata: they never become provider-visible
 * aliases or executable names, and therefore cannot create a second
 * authorization surface.
 */
export const DRIFTING_TOOL_SEARCH_METADATA: ToolSearchMetadataByName = {
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

/**
 * Product vocabulary for the author-domain workspace surface, layered over the
 * canonical vocabulary above. Kept as a separate export so the canonical
 * index (evals, fixtures) keeps its exact historical ranking: several write
 * names exist in both surfaces, and enriching them here must not shift
 * relevance scores computed against the canonical catalog.
 */
export const DRIFTING_DOMAIN_TOOL_SEARCH_METADATA: ToolSearchMetadataByName = {
  ...DRIFTING_TOOL_SEARCH_METADATA,
  get_project_overview: {
    searchIntents: [
      'orient across the whole book',
      'start a full book task',
      'whole book overview',
      '全书鸟瞰',
      '开始全书任务',
      '介绍这部小说的整体内容',
    ],
  },
  get_project_facts: {
    searchIntents: [
      'book premise and author facts',
      'project setup brief',
      '作品简介与设定事实',
      '项目基础设定',
    ],
  },
  list_chapters: {
    searchIntents: [
      'browse the chapter directory',
      'show manuscript chapter list',
      '列出全部章节',
      '查看章节目录',
    ],
  },
  read_chapter: {
    searchIntents: [
      'read one chapter prose',
      'open the chapter body',
      '只读章节正文',
      '打开章节内容',
    ],
  },
  list_inspirations: {
    searchIntents: [
      'browse drift and inspiration titles',
      'list free floating ideas',
      '列出漂流灵感节点',
      '查看灵感目录',
    ],
  },
  read_inspiration: {
    searchIntents: [
      'read one drift idea body',
      'open an inspiration note',
      '读取漂流灵感正文',
      '打开灵感节点',
    ],
  },
  list_element_categories: {
    searchIntents: [
      'browse element category groups',
      'list story bible categories',
      '列出要素分类',
      '查看元素分组目录',
    ],
  },
  read_element_category: {
    searchIntents: [
      'inspect one element category',
      'read category template facts',
      '查看单个要素分类',
      '读取分类设定',
    ],
  },
  find_element_appearances: {
    searchIntents: [
      'find chapters mentioning a character',
      'locate element appearances in prose',
      '查角色在哪些章节出场',
      '定位要素提及位置',
    ],
  },
  list_storylines: {
    searchIntents: [
      'browse plot thread directory',
      'list storylines with members',
      '列出全部故事线',
      '查看情节线目录',
    ],
  },
  read_storyline: {
    searchIntents: [
      'inspect one plot thread',
      'read storyline members and facts',
      '读取一条故事线详情',
      '查看情节线成员章节',
    ],
  },
  list_relations: {
    searchIntents: [
      'inspect graph edges around an entity',
      'browse curated story relationships',
      '查看实体关系边',
      '读取故事图谱关系',
    ],
  },
  list_relation_types: {
    searchIntents: [
      'browse relation type definitions',
      'list allowed relationship kinds',
      '列出关系类型定义',
      '查看可用关系种类',
    ],
  },
  list_entity_relations: {
    searchIntents: [
      'relations connected to one entity',
      'follow relationships of a character',
      '查看某个实体的关系',
      '追踪角色关系网',
    ],
  },
  list_author_rules: {
    searchIntents: [
      'inspect standing author rules',
      'show remembered writing preferences',
      '查看作者规则',
      '列出写作偏好与否决',
    ],
  },
  create_chapter: {
    searchIntents: [
      'add a new chapter',
      'start another chapter draft',
      '新建一个章节',
      '创建章节草稿',
    ],
  },
  rename_chapter: {
    searchIntents: [
      'rename a chapter title',
      'change the chapter heading',
      '重命名章节',
      '修改章节标题',
    ],
  },
  set_chapter_summary: {
    searchIntents: [
      'change chapter synopsis',
      'update the chapter summary only',
      '修改章节梗概',
      '设置章节摘要',
    ],
  },
  revise_chapter: {
    searchIntents: [
      'edit chapter prose passages',
      'rewrite or polish chapter text',
      'rework the chapter opening or ending',
      '修改章节正文段落',
      '润色改写章节内容',
      '改写章节的开头或结尾',
      '增强正文的悬念与张力',
    ],
  },
  replace_chapter_body: {
    searchIntents: [
      'replace the whole chapter body',
      'rewrite the chapter from scratch',
      '整章替换正文',
      '重写整个章节',
    ],
  },
  delete_chapter: {
    searchIntents: ['delete one chapter', 'remove a chapter', '删除章节', '移除一个章节'],
  },
  create_inspiration: {
    searchIntents: [
      'capture a new drift idea',
      'add an inspiration note',
      '新建漂流灵感',
      '记录一个灵感',
    ],
  },
  rename_inspiration: {
    searchIntents: ['rename a drift idea', '重命名漂流灵感', '修改灵感标题'],
  },
  set_inspiration_summary: {
    searchIntents: ['update an inspiration summary', '设置灵感摘要', '修改漂流梗概'],
  },
  revise_inspiration: {
    searchIntents: [
      'edit drift idea passages',
      'polish an inspiration note',
      '修改漂流灵感正文',
      '润色灵感内容',
    ],
  },
  replace_inspiration_body: {
    searchIntents: ['replace the whole inspiration body', '整篇替换灵感正文', '重写漂流灵感'],
  },
  delete_inspiration: {
    searchIntents: ['delete a drift idea', '删除漂流灵感', '移除灵感节点'],
  },
  create_element: {
    searchIntents: [
      'add a new character or setting entity',
      'create a story bible entry',
      '新建角色或设定要素',
      '创建故事圣经条目',
    ],
  },
  update_element: {
    searchIntents: [
      'update element name aliases or facts',
      'edit character profile fields',
      '更新要素名称别名事实',
      '修改角色档案字段',
    ],
  },
  revise_element: {
    searchIntents: [
      'edit element body passages',
      'rewrite part of a character profile',
      '修改要素正文段落',
      '润色角色设定内容',
    ],
  },
  replace_element_body: {
    searchIntents: ['replace the whole element body', '整篇替换要素正文', '重写角色档案正文'],
  },
  delete_element: {
    searchIntents: ['delete a character or element', '删除角色或要素', '移除设定条目'],
  },
  create_element_category: {
    searchIntents: ['add an element category', '新建要素分类', '创建元素分组'],
  },
  update_element_category: {
    searchIntents: ['rename category or template facts', '更新要素分类设置', '修改分类模板事实'],
  },
  replace_element_category_body: {
    searchIntents: ['replace category description body', '整篇替换分类正文', '重写分类说明'],
  },
  delete_element_category: {
    searchIntents: ['delete an element category', '删除要素分类', '移除元素分组'],
  },
  create_storyline: {
    searchIntents: ['add a new plot thread', '新建故事线', '创建情节线'],
  },
  update_storyline: {
    searchIntents: [
      'update storyline name summary or facts',
      '更新故事线的名称与事实',
      '修改情节线设定',
    ],
  },
  revise_storyline: {
    searchIntents: ['edit storyline body passages', '修改故事线正文段落', '润色情节线描述'],
  },
  replace_storyline_body: {
    searchIntents: ['replace the whole storyline body', '整篇替换故事线正文', '重写情节线描述'],
  },
  delete_storyline: {
    searchIntents: ['delete a plot thread', '删除故事线', '移除情节线'],
  },
  add_chapter_to_storyline: {
    searchIntents: [
      'attach a chapter to a plot thread',
      '把章节加入故事线',
      '关联章节与情节线',
    ],
  },
  remove_chapter_from_storyline: {
    searchIntents: [
      'detach a chapter from a plot thread',
      '把章节移出故事线',
      '解除章节与情节线关联',
    ],
  },
  set_chapter_primary_storyline: {
    searchIntents: [
      'set the main storyline of a chapter',
      '设置章节主故事线',
      '指定章节主线',
    ],
  },
  replace_storyline_chapters: {
    searchIntents: [
      'reorder or replace storyline chapter members',
      '调整故事线章节顺序',
      '替换情节线章节列表',
    ],
  },
  create_relation: {
    searchIntents: [
      'connect two entities with a typed relation',
      '建立实体之间的关系',
      '新增关系边',
    ],
  },
  update_relation: {
    searchIntents: ['change the type of a relation', '更新关系类型', '修改关系边'],
  },
  delete_relation: {
    searchIntents: ['remove a relation edge', '删除实体关系', '移除关系边'],
  },
  create_relation_type: {
    searchIntents: ['define a new relation type', '新建关系类型', '定义关系种类'],
  },
  update_relation_type: {
    searchIntents: ['edit a relation type definition', '更新关系类型定义', '修改关系种类'],
  },
  delete_relation_type: {
    searchIntents: ['delete a relation type', '删除关系类型', '移除关系种类'],
  },
  create_comment: {
    searchIntents: [
      'leave an annotation or todo note',
      '创建批注或待办',
      '给正文添加评论',
    ],
  },
  update_comment: {
    searchIntents: ['edit or resolve a comment', '更新批注状态', '修改评论内容'],
  },
  delete_comment: {
    searchIntents: ['delete a comment or todo', '删除批注待办', '移除评论'],
  },
  update_project_facts: {
    searchIntents: [
      'edit author facts and premise fields',
      '更新项目设定事实',
      '修改作品基础设定',
    ],
  },
  create_author_rule: {
    searchIntents: [
      'remember a standing writing rule',
      '记住一条写作规则',
      '新增作者偏好规则',
    ],
  },
  update_author_rule: {
    searchIntents: ['edit a standing author rule', '更新作者规则', '修改写作偏好'],
  },
  delete_author_rule: {
    searchIntents: ['forget an author rule', '删除作者规则', '移除写作偏好'],
  },
  create_element_patch: {
    searchIntents: [
      'record a character state change',
      '记录角色演变补丁',
      '新增要素状态变化',
    ],
  },
  update_element_patch: {
    searchIntents: ['edit an element evolution patch', '更新要素演变补丁', '修改角色状态变化'],
  },
  delete_element_patch: {
    searchIntents: ['delete an element evolution patch', '删除要素演变补丁', '移除状态变化记录'],
  },
};
