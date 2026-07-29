/**
 * Agent tool registry (read subset) — the seed of a single source of truth for
 * tool SCHEMAS, consumed by the OpenAI-compatible function-calling loop (today:
 * the Shadow judge). Implementations already live in tool-handlers.ts
 * (`runAgentTool`); this file just declares each tool's name + description + JSON
 * Schema params + an access tag, so a caller can hand the model a scoped tool set.
 *
 * Only READ tools are listed here — Shadow is advise-not-block and must never get
 * write/canon-mutating tools. A future General Agent transport can add a separate
 * write-capable view without weakening this allowlist.
 *
 * Entities are addressed BY NAME (project-unique), so args are names, not ids.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { AITool } from '../ai/types';

export interface RegisteredTool {
  name: string;
  version: number;
  description: string;
  parametersSchema: TSchema;
  access: 'read' | 'write';
  effect: 'none' | 'prose' | 'canon' | 'graph' | 'destructive' | 'external';
  concurrency: 'parallel' | 'exclusive_entity' | 'exclusive_project';
  approval: 'automatic' | 'soft_review' | 'confirm_before';
  retry: 'safe' | 'never' | 'inspect_before_retry';
  reversible: boolean;
  resultBudgetChars: number;
  certification:
    | 'unavailable'
    | 'protocol-conformant'
    | 'read-certified'
    | 'write-certified';
  aliases?: readonly string[];
}

const noArgs = Type.Object({}, { additionalProperties: false });
const str = (description: string) => Type.String({ description });

type ReadToolSpec = Pick<
  RegisteredTool,
  'name' | 'description' | 'parametersSchema'
> & {
  aliases?: readonly string[];
  resultBudgetChars?: number;
};

const AGENT_READ_TOOL_SPECS: ReadToolSpec[] = [
  {
    name: 'get_overview',
    description:
      '一次返回项目设定纲要、故事线、章节/drift 与元素目录。开始全书任务时优先调用。',
    parametersSchema: noArgs,
    aliases: ['overview', '项目概览', '全书概览'],
    resultBudgetChars: 24_000,
  },
  {
    name: 'get_project_brief',
    description:
      '本书设定纲要:项目名、简介、作者的 key/value 事实(目标/风格/前提/参考)与结构计数。先调它定位全局。',
    parametersSchema: noArgs,
    aliases: ['project brief', '项目设定'],
  },
  {
    name: 'list_elements',
    description:
      '按名字列出项目的元素类目与元素(角色/设定/物件):name · category · summary。名字项目内唯一,可直接作其他工具的 element/category 参数。',
    parametersSchema: noArgs,
    aliases: ['elements', '角色列表', '元素列表'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'read_element',
    description: '读一个元素(角色/设定/物件):名称、简介、别名、分组、类目、KV 事实与正文。',
    parametersSchema: Type.Object(
      { element: str('元素名称') },
      { additionalProperties: false },
    ),
    aliases: ['element detail', '读取角色', '读取元素'],
  },
  {
    name: 'get_element_patches',
    description:
      '一个元素跨章被接受的状态变更(patches)——角色/物件如何随剧情演变,每条带来源章节(名)与正文。',
    parametersSchema: Type.Object(
      { element: str('元素名称') },
      { additionalProperties: false },
    ),
    aliases: ['element evolution', '角色演变', '元素补丁'],
  },
  {
    name: 'read_node',
    description:
      '把一段正文读成按段编号的紧凑列表(每段一行 `<n>\\t<text>`)。章节/drift 还会带标题/状态/字数表头、梗概、appears、所属故事线、关系行。传 prose:false 只取该表头(不含正文)——廉价地浏览一章的梗概/关系而不拉全文。读元素/故事线/类目正文则设 kind。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名(或元素/故事线/类目名,配合 kind)'),
        kind: Type.Optional(
          str('element / storyline / category 时读对应正文;省略=章节/drift'),
        ),
        prose: Type.Optional(
          Type.Boolean({
            description: '是否含正文(默认 true);传 false 只取表头概览',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    aliases: ['read chapter', 'read prose', '读取章节', '读取正文'],
    resultBudgetChars: 32_000,
  },
  {
    name: 'get_storyline',
    description: '一条故事线的梗概、KV 事实、以及按阅读顺序的成员章节(含哪条是主线)。',
    parametersSchema: Type.Object(
      { storyline: str('故事线名') },
      { additionalProperties: false },
    ),
    aliases: ['storyline detail', '故事线'],
  },
  {
    name: 'get_entity_relations',
    description:
      '列出触及某实体的策展关系边(出+入两向),如 ally-of / belongs-to / located-in。用于走作者定义的故事图谱。',
    parametersSchema: Type.Object(
      {
        kind: str('实体类型 element/node/storyline/category/...'),
        name: str('实体名'),
      },
      { additionalProperties: false },
    ),
    aliases: ['relations', '关系', '实体关系'],
  },
  {
    name: 'where_does_entity_appear',
    description:
      '找一个结构实体在哪些章节/drift 的正文里被提及(出场/反链),按来源分组带提及计数与片段。从某角色/地点/物件快速到所有相关场景。',
    parametersSchema: Type.Object(
      {
        kind: str('目标类型 element/node/storyline/category/patch'),
        name: str('目标实体名'),
      },
      { additionalProperties: false },
    ),
    aliases: ['appearances', '出场位置', '提及位置'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'search_prose',
    description:
      '在章节/drift 正文与元素正文里做大小写不敏感全文检索。返回 {kind, title, block, snippet}。按内容找场景/段落用它。',
    parametersSchema: Type.Object(
      {
        query: str('要在正文中查找的文本'),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: '最多匹配数(默认 30,上限 100)',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    aliases: ['full text search', '全文搜索', '搜索正文'],
    resultBudgetChars: 24_000,
  },
  {
    name: 'search_project',
    description:
      '跨 章节/drift 标题、元素名/简介/别名、故事线名 的快速元数据检索(不含正文)。返回 {kind, label}。查正文内容用 search_prose。',
    parametersSchema: Type.Object(
      { query: str('要检索的文本') },
      { additionalProperties: false },
    ),
    aliases: ['project search', '项目搜索'],
  },
  {
    name: 'list_comments',
    description:
      '列出项目批注、TODO 与作者标记。可按实体、状态或 onlyTodos 过滤，返回锚点摘录和关联实体。',
    parametersSchema: Type.Object(
      {
        kind: Type.Optional(
          str('可选实体类型: node/element/storyline/category'),
        ),
        entity: Type.Optional(str('可选实体名称或 id；与 kind 配合')),
        status: Type.Optional(str('可选状态: open/resolved/converted')),
        onlyTodos: Type.Optional(
          Type.Boolean({ description: '只返回 TODO' }),
        ),
      },
      { additionalProperties: false },
    ),
    aliases: ['comments', 'todos', '批注', '待办'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'list_memory',
    description:
      '列出本项目仍有效或待确认的 Agent 记忆，包括偏好、否决和长期指令；这是只读操作。',
    parametersSchema: noArgs,
    aliases: ['memories', '记忆', '长期指令'],
  },
  {
    name: 'list_materials',
    description:
      '按标题列出项目素材库:title · kind (text/image/pdf/url) · source,text 类附 chars。text 素材是作者存的参考文本/可复用片段,用 read_material 读取。',
    parametersSchema: noArgs,
    aliases: ['materials', '素材库'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'read_material',
    description:
      '按标题读一个素材。text 类返回全文正文(作者提供的参考/可复用片段);image/pdf/url 返回元数据(uri/mime/size)。作者批注以 notes 返回。',
    parametersSchema: Type.Object(
      { material: str('素材标题(来自 list_materials)') },
      { additionalProperties: false },
    ),
    aliases: ['material detail', '读取素材'],
    resultBudgetChars: 24_000,
  },
];

export const AGENT_READ_TOOLS: RegisteredTool[] = AGENT_READ_TOOL_SPECS.map(
  (tool) => ({
    ...tool,
    version: 1,
    access: 'read',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    reversible: true,
    resultBudgetChars: tool.resultBudgetChars ?? 12_000,
    certification: 'read-certified',
  }),
);

export const READ_TOOL_NAMES = new Set(AGENT_READ_TOOLS.map((t) => t.name));

export function toAITools(tools: RegisteredTool[]): AITool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersSchema: t.parametersSchema,
  }));
}
