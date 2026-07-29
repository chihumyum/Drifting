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
