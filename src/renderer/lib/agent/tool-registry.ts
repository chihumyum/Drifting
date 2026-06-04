/**
 * Agent tool registry (read subset) — the seed of a single source of truth for
 * tool SCHEMAS, consumed by the OpenAI-compatible function-calling loop (today:
 * the Shadow judge). Implementations already live in tool-handlers.ts
 * (`runAgentTool`); this file just declares each tool's name + description + JSON
 * Schema params + an access tag, so a caller can hand the model a scoped tool set.
 *
 * Only READ tools are listed here — Shadow is advise-not-block and must never get
 * write/canon-mutating tools. (The general co-writing agent keeps its own full
 * tool registration in main/agent/tools.ts for now; unifying the two onto this
 * registry is a deferred, behavior-preserving refactor.)
 *
 * Schemas mirror the agent tools in main/agent/tools.ts — entities are addressed
 * BY NAME (project-unique), so the args are names, not ids.
 */
import type { AITool } from '../ai/types';

export interface RegisteredTool {
  name: string;
  description: string;
  parametersSchema: object; // JSON Schema
  access: 'read' | 'write';
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false } as const;
const str = (description: string) => ({ type: 'string', description });

export const AGENT_READ_TOOLS: RegisteredTool[] = [
  {
    name: 'get_project_brief',
    description:
      "本书设定纲要:项目名、简介、作者的 key/value 事实(目标/风格/前提/参考)与结构计数。先调它定位全局。",
    parametersSchema: noArgs,
    access: 'read',
  },
  {
    name: 'list_elements',
    description:
      '按名字列出项目的元素类目与元素(角色/设定/物件):name · category · summary。名字项目内唯一,可直接作其他工具的 element/category 参数。',
    parametersSchema: noArgs,
    access: 'read',
  },
  {
    name: 'read_element',
    description: '读一个元素(角色/设定/物件):名称、简介、别名、分组、类目、KV 事实与正文。',
    parametersSchema: {
      type: 'object',
      properties: { element: str('元素名称') },
      required: ['element'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'get_element_patches',
    description:
      '一个元素跨章被接受的状态变更(patches)——角色/物件如何随剧情演变,每条带来源章节(名)与正文。',
    parametersSchema: {
      type: 'object',
      properties: { element: str('元素名称') },
      required: ['element'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'get_node_context',
    description:
      '章节/drift 的廉价概览(不含全文正文):标题、梗概、字数、状态、滚动小节摘要、它引用的元素、所属故事线、关系(都按名)。先调它,真需要再 read_node。',
    parametersSchema: {
      type: 'object',
      properties: { node: str('章节或 drift 名') },
      required: ['node'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'read_node',
    description:
      '把一段正文读成按段编号的紧凑列表(每段一行 `<n>\\t<text>`)。章节/drift 还会带标题/状态/字数表头、梗概、appears 行。读元素/故事线/类目正文则设 kind。',
    parametersSchema: {
      type: 'object',
      properties: {
        node: str('章节/drift 名(或元素/故事线/类目名,配合 kind)'),
        kind: str('element / storyline / category 时读对应正文;省略=章节/drift'),
      },
      required: ['node'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'get_storyline',
    description: '一条故事线的梗概、KV 事实、以及按阅读顺序的成员章节(含哪条是主线)。',
    parametersSchema: {
      type: 'object',
      properties: { storyline: str('故事线名') },
      required: ['storyline'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'get_entity_relations',
    description:
      '列出触及某实体的策展关系边(出+入两向),如 ally-of / belongs-to / located-in。用于走作者定义的故事图谱。',
    parametersSchema: {
      type: 'object',
      properties: {
        kind: str('实体类型 element/node/storyline/category/...'),
        name: str('实体名'),
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'where_does_entity_appear',
    description:
      '找一个结构实体在哪些章节/drift 的正文里被提及(出场/反链),按来源分组带提及计数与片段。从某角色/地点/物件快速到所有相关场景。',
    parametersSchema: {
      type: 'object',
      properties: {
        kind: str('目标类型 element/node/storyline/category/patch'),
        name: str('目标实体名'),
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'search_prose',
    description:
      '在章节/drift 正文与元素正文里做大小写不敏感全文检索。返回 {kind, title, block, snippet}。按内容找场景/段落用它。',
    parametersSchema: {
      type: 'object',
      properties: {
        query: str('要在正文中查找的文本'),
        limit: { type: 'number', description: '最多匹配数(默认 30,上限 100)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'search_project',
    description:
      '跨 章节/drift 标题、元素名/简介/别名、故事线名 的快速元数据检索(不含正文)。返回 {kind, label}。查正文内容用 search_prose。',
    parametersSchema: {
      type: 'object',
      properties: { query: str('要检索的文本') },
      required: ['query'],
      additionalProperties: false,
    },
    access: 'read',
  },
  {
    name: 'resolve_entity',
    description: '把一个名字消歧/取回底层 id(返回 {found,id,kind,label} 或 {ambiguous:[…]})。一般用不到。',
    parametersSchema: {
      type: 'object',
      properties: {
        name: str('实体确切名称'),
        kind: str('限定类型 element/node/storyline/category(可选)'),
      },
      required: ['name'],
      additionalProperties: false,
    },
    access: 'read',
  },
];

export const READ_TOOL_NAMES = new Set(AGENT_READ_TOOLS.map((t) => t.name));

export function toAITools(tools: RegisteredTool[]): AITool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersSchema: t.parametersSchema,
  }));
}
