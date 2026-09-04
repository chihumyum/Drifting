/**
 * Canonical Agent tool catalog and provider-exposure policy.
 *
 * `runAgentTool` remains the renderer-owned dispatcher. This catalog describes
 * every dispatcher surface (General and deprecated aliases) plus
 * runtime-only virtual tools. Providers only receive canonical entries selected
 * by an explicit policy; aliases are metadata and are never emitted twice.
 *
 * Entity arguments are project-unique names unless a description explicitly
 * calls out an opaque handle such as blockId, relationId, patchId or commentId.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { AITool } from '../ai/types';
import type {
  AgentProviderToolPolicy,
  AgentToolApproval,
  AgentToolConcurrency,
  AgentToolEffect,
  AgentToolRetry,
  AgentToolRevertStrategy,
  AgentToolRisk,
  AgentToolScope,
  RegisteredTool,
} from './tool-registry.types';

export type {
  AgentProviderToolPolicy,
  AgentToolAccess,
  AgentToolApproval,
  AgentToolCertification,
  AgentToolConcurrency,
  AgentToolEffect,
  AgentToolRetry,
  AgentToolRevertStrategy,
  AgentToolRisk,
  AgentToolScope,
  RegisteredTool,
} from './tool-registry.types';

const CATALOG_VERSION = 1;
const DEFAULT_RESULT_BUDGET_CHARS = 12_000;

const noArgs = Type.Object({}, { additionalProperties: false });
const str = (description: string) => Type.String({ description });
const optionalStr = (description: string) => Type.Optional(Type.String({ description }));
const optionalInteger = (description: string) =>
  Type.Optional(Type.Integer({ minimum: 1, description }));
const expectedRevision = Type.Object(
  {
    receiptId: str('最近一次依赖读取返回的 freshness.receiptId'),
    observationId: str('同一次读取返回的目标实体 freshness observation id'),
    revision: str('同一 observation 返回的精确 revision；不得自行生成'),
  },
  {
    additionalProperties: false,
    description: '必须逐字段复制最近一次目标实体读取的 freshness 引用',
  },
);

const fact = Type.Object(
  {
    key: str('事实键'),
    value: str('事实值'),
  },
  { additionalProperties: false },
);
const facts = (description: string) => Type.Array(fact, { minItems: 1, description });
const optionalFacts = (description: string) => Type.Optional(Type.Array(fact, { description }));
const domainEntityType = Type.Union(
  [
    Type.Literal('chapter'),
    Type.Literal('inspiration'),
    Type.Literal('element'),
    Type.Literal('storyline'),
    Type.Literal('element_category'),
  ],
  { description: '实体类型；只能使用列出的稳定值' },
);
const relationSourceDomainType = Type.Union(
  [
    Type.Literal('chapter'),
    Type.Literal('inspiration'),
    Type.Literal('element'),
    Type.Literal('storyline'),
    Type.Literal('element_category'),
    Type.Literal('comment'),
    Type.Literal('material'),
  ],
  { description: '关系源端可用的作者领域实体类型' },
);
const relationTargetDomainType = domainEntityType;

const proseEntityTarget = {
  kind: Type.Optional(
    Type.Union([Type.Literal('node'), Type.Literal('chapter'), Type.Literal('drift')], {
      description: 'P5 已认证的正文写入仅支持 node/chapter/drift；默认 node',
    }),
  ),
  entity: str('章节或 drift 的项目内唯一名称'),
  expectedRevision,
};

interface ReadToolSpec {
  name: string;
  description: string;
  parametersSchema: TSchema;
  aliases?: readonly string[];
  handlerAliases?: readonly string[];
  resultBudgetChars?: number;
  certificationNote?: string;
}

interface ClassifiedToolSpec {
  name: string;
  description: string;
  parametersSchema: TSchema;
  risk: AgentToolRisk;
  effect: AgentToolEffect;
  concurrency: AgentToolConcurrency;
  approval: AgentToolApproval;
  retry: AgentToolRetry;
  revertStrategy: AgentToolRevertStrategy;
  aliases?: readonly string[];
  handlerAliases?: readonly string[];
  resultBudgetChars?: number;
  certification?: 'unavailable' | 'write-certified';
  certificationNote?: string;
}

interface InternalToolSpec extends ClassifiedToolSpec {
  scope: Exclude<AgentToolScope, 'general'>;
  access: 'read' | 'write';
  certificationNote: string;
}

function reversibleFrom(strategy: AgentToolRevertStrategy): boolean {
  return strategy === 'exact_inverse' || strategy === 'compensating';
}

function registerReadTool(spec: ReadToolSpec): RegisteredTool {
  return {
    ...spec,
    version: CATALOG_VERSION,
    scope: 'general',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    reversible: true,
    resultBudgetChars: spec.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS,
    certification: 'read-certified',
    certificationNote:
      spec.certificationNote ??
      'P1 read-only runtime certification: schema validation, project isolation, no write capability.',
    aliases: spec.aliases ?? [],
    handlerAliases: spec.handlerAliases ?? [],
  };
}

function registerWriteTool(spec: ClassifiedToolSpec): RegisteredTool {
  return {
    ...spec,
    version: CATALOG_VERSION,
    scope: 'general',
    access: 'write',
    reversible: reversibleFrom(spec.revertStrategy),
    resultBudgetChars: spec.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS,
    certification: spec.certification ?? 'unavailable',
    certificationNote:
      spec.certificationNote ??
      'Classified for P3 inventory only; provider execution remains unavailable until mutation, recovery, review and revert certification passes.',
    aliases: spec.aliases ?? [],
    handlerAliases: spec.handlerAliases ?? [],
  };
}

function registerInternalTool(spec: InternalToolSpec): RegisteredTool {
  return {
    ...spec,
    version: CATALOG_VERSION,
    reversible: reversibleFrom(spec.revertStrategy),
    resultBudgetChars: spec.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS,
    certification: 'internal-certified',
    aliases: spec.aliases ?? [],
    handlerAliases: spec.handlerAliases ?? [],
  };
}

// ---------------------------------------------------------------------------
// General read tools
// ---------------------------------------------------------------------------

const GENERAL_READ_TOOL_SPECS: ReadToolSpec[] = [
  {
    name: 'get_overview',
    description: '一次返回项目设定纲要、故事线、章节/drift 与元素目录。开始全书任务时优先调用。',
    parametersSchema: noArgs,
    aliases: ['overview', '项目概览', '全书概览'],
    resultBudgetChars: 24_000,
  },
  {
    name: 'get_project_brief',
    description: '本书设定纲要：项目名、简介、作者的 key/value 事实与结构计数。',
    parametersSchema: noArgs,
    aliases: ['project brief', '项目设定'],
  },
  {
    name: 'list_nodes',
    description: '按名字列出项目故事线、章节与 drift。章节包含状态、字数和主故事线。',
    parametersSchema: noArgs,
    aliases: ['nodes', 'chapters', '章节列表', '漂流列表'],
    resultBudgetChars: 20_000,
    certificationNote:
      'P3 read audit: projectId-filtered Zustand projection only; it calls no write usecase and exposes no cross-project rows.',
  },
  {
    name: 'list_elements',
    description: '按名字列出项目的元素类目与元素（角色/设定/物件）：name · category · summary。',
    parametersSchema: noArgs,
    aliases: ['elements', '角色列表', '元素列表'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'read_element',
    description: '读一个元素（角色/设定/物件）：名称、简介、别名、分组、类目、KV 事实与正文。',
    parametersSchema: Type.Object({ element: str('元素名称') }, { additionalProperties: false }),
    aliases: ['element detail', '读取角色', '读取元素'],
  },
  {
    name: 'get_element_patches',
    description: '读取一个元素跨章被接受的状态变更，每条带来源章节与正文。',
    parametersSchema: Type.Object({ element: str('元素名称') }, { additionalProperties: false }),
    aliases: ['element evolution', '角色演变', '元素补丁'],
  },
  {
    name: 'read_node',
    description:
      '把正文读成按段编号的紧凑列表。传 prose:false 只读表头；kind 可指定 element/storyline/category。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名；配合 kind 时也可传其他正文实体名'),
        kind: Type.Optional(str('element / storyline / category；省略表示章节或 drift')),
        prose: Type.Optional(
          Type.Boolean({
            description: '是否包含正文（默认 true）；false 只返回表头',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    aliases: ['read chapter', 'read prose', '读取章节', '读取正文'],
    resultBudgetChars: 32_000,
  },
  {
    name: 'read_block',
    description:
      '按稳定 blockId 读取一个正文块的 live Yjs 文本，返回当前段号、类型与文本；块已删除时返回 found:false。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名；配合 kind 时也可传其他正文实体名'),
        kind: Type.Optional(str('element / storyline / category；省略表示章节或 drift')),
        blockId: str('正文块 uuid'),
      },
      { additionalProperties: false },
    ),
    aliases: ['read live block', '读取段落'],
    certificationNote:
      'P3 read audit: resolves the scoped entity then reads getEntityContentJson/live Yjs truth; no mutation helper or write usecase is reachable.',
  },
  {
    name: 'lookup_block',
    description: '按 1-based 段号和/或文本片段查找正文块的稳定 blockId；不会修改或补写 blockId。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名；配合 kind 时也可传其他正文实体名'),
        kind: Type.Optional(str('element / storyline / category；省略表示章节或 drift')),
        ordinal: optionalInteger('来自 read_node 的 1-based 段号'),
        contains: optionalStr('段落文本的大小写不敏感子串'),
      },
      { additionalProperties: false },
    ),
    aliases: ['find block id', '查找段落'],
    certificationNote:
      'P3 read audit: searches a scoped live Yjs-derived snapshot with findBlocks only; it does not materialize ids or call a write usecase.',
  },
  {
    name: 'get_storyline',
    description: '读取一条故事线的梗概、KV 事实，以及按阅读顺序排列的成员章节。',
    parametersSchema: Type.Object({ storyline: str('故事线名') }, { additionalProperties: false }),
    aliases: ['storyline detail', '故事线'],
  },
  {
    name: 'get_entity_relations',
    description: '列出触及某实体的策展关系边（出向与入向），用于走作者定义的故事图谱。',
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
    name: 'get_relation_types',
    description: '列出项目级关系类型定义、方向、角色和允许的端点类型。',
    parametersSchema: noArgs,
    aliases: ['relation types', '关系类型定义'],
  },
  {
    name: 'where_does_entity_appear',
    description: '找一个结构实体在哪些章节/drift 正文里被提及，按来源分组返回计数与片段。',
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
    description: '在章节、灵感与写作要素正文里做大小写不敏感全文检索。',
    parametersSchema: Type.Object(
      {
        query: str('要在正文中查找的文本'),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: '最多匹配数（默认 30，上限 100）',
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
    description: '跨章节、灵感标题、要素名/简介/别名与故事线名做快速资料检索，不搜索正文。',
    parametersSchema: Type.Object({ query: str('要检索的文本') }, { additionalProperties: false }),
    aliases: ['project search', '项目搜索'],
  },
  {
    name: 'list_comments',
    description: '列出项目批注、TODO 与作者标记，可按目标、状态或是否仅看 TODO 过滤。',
    parametersSchema: Type.Object(
      {
        targetType: Type.Optional(domainEntityType),
        targetName: optionalStr('目标实体纯名称；与 targetType 一起提供'),
        status: Type.Optional(
          Type.Union([
            Type.Literal('open'),
            Type.Literal('resolved'),
            Type.Literal('converted'),
          ]),
        ),
        onlyTodos: Type.Optional(Type.Boolean({ description: '只返回 TODO' })),
      },
      { additionalProperties: false },
    ),
    aliases: ['comments', 'todos', '批注', '待办'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'list_memory',
    description: '列出本项目仍有效或待确认的 Agent 记忆，包括偏好、否决和长期指令。',
    parametersSchema: noArgs,
    aliases: ['memories', '记忆', '长期指令'],
  },
  {
    name: 'list_materials',
    description: '按标题列出项目素材库：title · kind · source；text 素材附 chars。',
    parametersSchema: noArgs,
    aliases: ['materials', '素材库'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'read_material',
    description: '按标题读取一个素材。text 返回全文，image/pdf/url 返回元数据。',
    parametersSchema: Type.Object(
      { material: str('素材标题（来自 list_materials）') },
      { additionalProperties: false },
    ),
    aliases: ['material detail', '读取素材'],
    resultBudgetChars: 24_000,
  },
];

// ---------------------------------------------------------------------------
// General writes — classified, deliberately not provider-certified yet.
// ---------------------------------------------------------------------------

const GENERAL_WRITE_TOOL_SPECS: ClassifiedToolSpec[] = [
  {
    name: 'update_element',
    description: '更新元素名称、简介、别名、分组、类目或结构化事实；只修改提供的字段。',
    parametersSchema: Type.Object(
      {
        element: str('元素名称'),
        name: optionalStr('新名称'),
        summary: optionalStr('新简介'),
        aliases: Type.Optional(Type.Array(Type.String())),
        groupName: optionalStr('新分组名'),
        category: optionalStr('新类目名称'),
        facts: optionalFacts('替换元素结构化事实'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['update character', '更新元素'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: hard pre-execution authorization, exact element freshness, atomic element/outbox receipt, crash reconciliation, and guarded exact inverse.',
  },
  {
    name: 'set_entity_body',
    description: '整体替换元素、故事线或类目的长正文；章节/drift 必须使用 block 工具。',
    parametersSchema: Type.Object(
      {
        kind: str('element | storyline | category'),
        entity: str('实体名称'),
        body: str('完整新正文；空行分段'),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['set_element_body', 'set element body', '整体替换实体正文'],
    handlerAliases: ['set_element_body'],
  },
  {
    name: 'create_element',
    description: '在指定类目下创建一个角色、地点、物件或其他元素。',
    parametersSchema: Type.Object(
      {
        category: str('类目名称'),
        name: str('元素名称'),
        summary: optionalStr('简介'),
        body: optionalStr('初始长正文'),
        aliases: Type.Optional(Type.Array(Type.String())),
        groupName: optionalStr('可选分组名'),
        facts: optionalFacts('新元素的结构化事实'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'compensating',
    aliases: ['create character', '创建元素'],
    certification: 'write-certified',
    certificationNote:
      'Domain create certification: runtime-owned project freshness, deterministic identity, atomic entity/prose/outbox receipt, review projection and guarded exact inverse.',
  },
  {
    name: 'rename_node',
    description: '重命名章节或 drift。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名'),
        title: str('新标题'),
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['rename chapter', '重命名章节'],
    certification: 'write-certified',
    certificationNote:
      'P3 exact field-write certification: hard pre-execution authorization, durable idempotency/effect receipt, renderer rename usecase, and guarded exact inverse.',
  },
  {
    name: 'set_node_summary',
    description: '设置章节或 drift 的梗概。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名'),
        summary: str('新梗概'),
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['set chapter summary', '设置章节梗概'],
    certification: 'write-certified',
    certificationNote:
      'P3 exact field-write certification: hard pre-execution authorization, durable idempotency/effect receipt, renderer update usecase, and guarded exact inverse.',
  },
  {
    name: 'edit_block',
    description: '原位替换一个正文块的文本，可按 read_node 段号或稳定 blockId 定位。',
    parametersSchema: Type.Object(
      {
        ...proseEntityTarget,
        block: optionalInteger('来自 read_node 的 1-based 段号'),
        blockId: optionalStr('正文块 uuid（与 block 二选一）'),
        text: str(
          '替换后的纯内容文本；read_node 显示的 heading「# 」或引用「> 」仅表示块类型，不要复制进 text',
        ),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['replace paragraph', '改写段落'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: hard pre-execution authorization, exact read freshness, deterministic command, atomic Yjs/projection/outbox receipt, and guarded semantic inverse.',
  },
  {
    name: 'edit_blocks',
    description: '在同一实体内原子替换多个正文块。',
    parametersSchema: Type.Object(
      {
        ...proseEntityTarget,
        edits: Type.Array(
          Type.Object(
            {
              block: optionalInteger('1-based 段号'),
              blockId: optionalStr('正文块 uuid'),
              text: str('替换后的纯内容文本；不要复制 read_node 的「# 」或「> 」块类型前缀'),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['replace paragraphs', '批量改写段落'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: non-contiguous edits share one deterministic command and exact semantic inverse.',
  },
  {
    name: 'append_paragraph',
    description: '在正文末尾追加一个新段落。',
    parametersSchema: Type.Object(
      { ...proseEntityTarget, text: str('新段落文本') },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['append prose', '追加段落'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: deterministic block id, atomic Yjs/projection/outbox receipt, and exact semantic inverse.',
  },
  {
    name: 'remove_blocks',
    description: '按段号和/或 blockId 删除一个或多个正文块。',
    parametersSchema: Type.Object(
      {
        ...proseEntityTarget,
        blockNumbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
        blockIds: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['delete paragraphs', '删除段落'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: exact block-set freshness, atomic removal receipt, and fail-closed semantic inverse.',
  },
  {
    name: 'replace_block_range',
    description: '把一个含首尾的正文块区间替换成新的段落数组。',
    parametersSchema: Type.Object(
      {
        ...proseEntityTarget,
        fromBlock: optionalInteger('区间起点段号'),
        toBlock: optionalInteger('区间终点段号'),
        fromBlockId: optionalStr('区间起点 blockId'),
        toBlockId: optionalStr('区间终点 blockId'),
        blocks: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['replace prose range', '替换段落区间'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: exact range freshness, deterministic replacement ids, and exact semantic inverse.',
  },
  {
    name: 'insert_blocks',
    description: '在指定正文块之后插入多个新段落；不指定位置时插到开头。',
    parametersSchema: Type.Object(
      {
        ...proseEntityTarget,
        afterBlock: optionalInteger('插入点段号'),
        afterBlockId: optionalStr('插入点 blockId'),
        blocks: Type.Array(Type.String(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['insert paragraphs', '插入段落'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: exact insertion anchor freshness, deterministic block ids, and exact semantic inverse.',
  },
  {
    name: 'link_chapter_to_storyline',
    description: '把章节加入一条故事线；drift 不可加入故事线。',
    parametersSchema: Type.Object(
      {
        chapter: str('章节名'),
        storyline: str('故事线名'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['link storyline', '章节加入故事线'],
  },
  {
    name: 'unlink_chapter_from_storyline',
    description: '从故事线移除一个章节。',
    parametersSchema: Type.Object(
      {
        chapter: str('章节名'),
        storyline: str('故事线名'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_entity',
    approval: 'confirm_before',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['unlink storyline', '章节移出故事线'],
  },
  {
    name: 'set_primary_storyline',
    description: '把一条故事线设为章节主线，必要时自动加入成员关系。',
    parametersSchema: Type.Object(
      {
        chapter: str('章节名'),
        storyline: str('故事线名'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['primary storyline', '设置主故事线'],
  },
  {
    name: 'add_relation',
    description: '按项目关系类型创建一条作者策展的跨实体关系边。',
    parametersSchema: Type.Object(
      {
        fromKind: str('源实体类型'),
        from: str('源实体名称'),
        toKind: str('目标实体类型'),
        to: str('目标实体名称'),
        relationType: str('关系类型名称'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['create relation', '添加关系'],
  },
  {
    name: 'remove_relation',
    description: '按 relationId 删除一条策展关系边。',
    parametersSchema: Type.Object(
      { relationId: str('来自 get_entity_relations 的 relationId') },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['delete relation', '删除关系'],
  },
  {
    name: 'assign_relation_type',
    description: '按 relationId 指定另一个项目关系类型。',
    parametersSchema: Type.Object(
      {
        relationId: str('来自 get_entity_relations 的 relationId'),
        relationType: str('关系类型名称'),
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['assign relation type', '指定关系类型'],
  },
  {
    name: 'create_relation_type',
    description: '创建项目级关系类型定义。',
    parametersSchema: Type.Object(
      {
        name: str('关系类型名称'),
        description: optionalStr('说明'),
        orientation: Type.Union([Type.Literal('directed'), Type.Literal('symmetric')]),
        sourceRole: str('源端角色'),
        targetRole: str('目标端角色'),
        sourceKinds: Type.Array(relationSourceDomainType, { minItems: 1 }),
        targetKinds: Type.Array(relationTargetDomainType, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['define relation type', '创建关系类型'],
    certification: 'write-certified',
    certificationNote:
      'Project relation-type certification: runtime-owned freshness, explicit endpoint semantics, atomic type/endpoints/outbox receipt, crash reconciliation, and guarded exact inverse.',
  },
  {
    name: 'update_relation_type',
    description: '完整更新项目级关系类型定义。',
    parametersSchema: Type.Object(
      {
        relationType: str('当前关系类型名称'),
        name: str('新名称'),
        description: optionalStr('说明'),
        orientation: Type.Union([Type.Literal('directed'), Type.Literal('symmetric')]),
        sourceRole: str('源端角色'),
        targetRole: str('目标端角色'),
        sourceKinds: Type.Array(relationSourceDomainType, { minItems: 1 }),
        targetKinds: Type.Array(relationTargetDomainType, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['edit relation type', '更新关系类型'],
    certification: 'write-certified',
    certificationNote:
      'Project relation-type certification: exact type freshness, atomic definition/endpoints/relation projection/outbox receipt, and guarded exact inverse.',
  },
  {
    name: 'delete_relation_type',
    description: '删除一个未被关系使用的项目级关系类型。',
    parametersSchema: Type.Object(
      { relationType: str('关系类型名称') },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'destructive',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['remove relation type', '删除关系类型'],
    certification: 'write-certified',
    certificationNote:
      'Project relation-type deletion certification: exact freshness, default author confirmation, usage guard, atomic delete/outbox receipt, and exact restore inverse.',
  },
  {
    name: 'create_storyline',
    description: '创建一条新故事线。',
    parametersSchema: Type.Object(
      {
        name: str('故事线名'),
        summary: optionalStr('梗概'),
        body: optionalStr('初始长正文'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'review_after',
    retry: 'inspect_before_retry',
    revertStrategy: 'compensating',
    aliases: ['new storyline', '创建故事线'],
    certification: 'write-certified',
    certificationNote:
      'Domain create certification: runtime-owned project freshness, deterministic identity, atomic storyline/prose/outbox receipt, review projection and guarded exact inverse.',
  },
  {
    name: 'update_storyline',
    description: '更新故事线名称、梗概或结构化事实。',
    parametersSchema: Type.Object(
      {
        storyline: str('故事线名'),
        name: optionalStr('新名称'),
        summary: optionalStr('新梗概'),
        facts: optionalFacts('按 key 合并的结构化事实'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['edit storyline', '更新故事线'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: hard pre-execution authorization, exact storyline freshness, atomic storyline/outbox receipt, crash reconciliation, and guarded exact inverse.',
  },
  {
    name: 'create_category',
    description: '创建一个元素类目。',
    parametersSchema: Type.Object({ name: optionalStr('类目名') }, { additionalProperties: false }),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'compensating',
    aliases: ['new category', '创建类目'],
  },
  {
    name: 'update_category',
    description: '合并更新类目的新元素模板事实。',
    parametersSchema: Type.Object(
      {
        category: str('类目名'),
        templateFacts: facts('按 key 合并的模板事实'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['update category template', '更新类目模板'],
  },
  {
    name: 'update_project_facts',
    description: '按 key 合并更新项目级治理事实，例如文风、POV 与写作约束。',
    parametersSchema: Type.Object(
      {
        facts: facts('按 key 合并的项目事实'),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['update book facts', '更新项目事实'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: hard pre-execution authorization, exact project freshness, atomic project/outbox receipt, crash reconciliation, and guarded exact inverse.',
  },
  {
    name: 'remember',
    description: '保存作者级长期偏好、否决或指令；故事事实应写入 canon 而不是记忆。',
    parametersSchema: Type.Object(
      {
        kind: str('preference | veto | directive'),
        body: str('自包含的记忆文本'),
        target: optionalStr('可选关联实体名称'),
        targetKind: optionalStr('node | element | storyline | category'),
        supersedes: optionalStr('被替代记忆的 memoryId'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'memory',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['save memory', '记住'],
  },
  {
    name: 'forget',
    description: '按 memoryId 软删除一条 Agent 记忆。',
    parametersSchema: Type.Object(
      { memoryId: str('来自 list_memory 的 memoryId') },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'memory',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['retire memory', '忘记'],
  },
  {
    name: 'create_node',
    description: '创建 chapter 或自由漂浮的 drift 节点。',
    parametersSchema: Type.Object(
      {
        kind: str('chapter | drift'),
        title: optionalStr('标题'),
        storyline: optionalStr('chapter 可选主故事线名称'),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'compensating',
    aliases: ['create chapter', '创建章节', '创建漂流'],
  },
  {
    name: 'set_summary',
    description: '读取内容后，为 node、element 或 storyline 写入摘要。',
    parametersSchema: Type.Object(
      {
        targetKind: str('node | element | storyline'),
        target: str('目标实体名称'),
        summary: str('新摘要'),
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['write summary', '写摘要'],
  },
  {
    name: 'create_element_patch',
    description: '记录元素在故事时间线某一点的状态变更。',
    parametersSchema: Type.Object(
      {
        element: str('元素名'),
        title: optionalStr('补丁标题'),
        body: optionalStr('补丁正文'),
        sourceChapter: optionalStr('变化发生的章节名'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['record evolution', '创建元素补丁'],
    certification: 'write-certified',
    certificationNote:
      'P5 element-patch certification: hard pre-execution authorization, exact patch-set freshness, deterministic id, atomic patch/outbox receipt, and guarded exact delete inverse.',
  },
  {
    name: 'update_element_patch',
    description: '按 patchId 更新元素补丁标题或正文。',
    parametersSchema: Type.Object(
      {
        element: str('要素名'),
        patchId: str('来自 get_element_patches 的 patchId'),
        title: optionalStr('新标题'),
        body: optionalStr('新正文'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['edit evolution', '更新元素补丁'],
    certification: 'write-certified',
    certificationNote:
      'P5 element-patch certification: hard pre-execution authorization, exact patch freshness, atomic patch/outbox receipt, crash reconciliation, and guarded exact field inverse.',
  },
  {
    name: 'delete_element_patch',
    description: '按 patchId 删除元素补丁；默认在执行前由作者确认。',
    parametersSchema: Type.Object(
      {
        element: str('要素名'),
        patchId: str('来自 get_element_patches 的 patchId'),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['remove evolution', '删除元素补丁'],
    certification: 'write-certified',
    certificationNote:
      'P5 element-patch deletion certification: exact patch freshness, default pre-execution author confirmation with an explicit dangerous-operation override, atomic delete/outbox receipt, crash reconciliation, dependency guard, and exact restore inverse.',
  },
  {
    name: 'create_comment',
    description: '创建批注或 TODO。要挂到正文块时，传目标实体和能唯一定位该块的原文片段。',
    parametersSchema: Type.Object(
      {
        body: str('批注正文'),
        kind: Type.Optional(Type.Union([Type.Literal('note'), Type.Literal('todo')])),
        targetType: Type.Optional(domainEntityType),
        targetName: optionalStr('目标实体纯名称；与 targetType 一起提供'),
        targetText: optionalStr(
          '目标正文块中可唯一定位该块的原文片段；运行时解析为稳定 blockId，不要传 blockId',
        ),
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'annotation',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['add todo', '创建批注', '创建待办'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: project freshness, deterministic comment id, atomic comment/outbox receipt, crash reconciliation, and guarded exact delete inverse.',
  },
  {
    name: 'delete_comment',
    description: '按 commentId 删除批注或 TODO；默认在执行前请求作者确认。',
    parametersSchema: Type.Object(
      { commentId: str('来自 list_comments 的 commentId') },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'destructive',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['delete todo', '删除批注'],
    certification: 'write-certified',
    certificationNote:
      'Domain delete certification: runtime-owned comment freshness, immutable preimage, atomic delete receipt and guarded exact restore inverse.',
  },
  {
    name: 'set_comment_status',
    description: '把批注或 TODO 设为 resolved 或重新打开。',
    parametersSchema: Type.Object(
      {
        commentId: str('来自 list_comments 的 commentId'),
        status: str('resolved | open'),
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'annotation',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['resolve todo', '设置批注状态'],
  },
  {
    name: 'set_comment_kind',
    description: '把批注类型改为 todo 或 note。',
    parametersSchema: Type.Object(
      {
        commentId: str('来自 list_comments 的 commentId'),
        kind: Type.Union([Type.Literal('todo'), Type.Literal('note')]),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'annotation',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['convert todo', '设置批注类型'],
  },
  {
    name: 'delete_element',
    description: '删除一个元素；默认在执行前由作者明确确认。',
    parametersSchema: Type.Object({ element: str('元素名') }, { additionalProperties: false }),
    risk: 'critical',
    effect: 'destructive',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['delete character', '删除元素'],
    certification: 'write-certified',
    certificationNote:
      'Domain delete certification: runtime-owned element freshness, dependency guard, immutable preimage, atomic delete receipt and guarded exact restore inverse.',
  },
];

const domainCursor = Type.Optional(
  Type.Integer({ minimum: 0, description: '上一次读取返回的 cursor；首次读取省略' }),
);
const domainReadLimit = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 32_000,
    description: '本次最多返回的字符数；默认 16000',
  }),
);
const domainTextChanges = Type.Array(
  Type.Object(
    {
      currentText: Type.String({ minLength: 1, description: '当前正文中的原文' }),
      revisedText: Type.String({ description: '替换后的文字；可为空字符串' }),
      allOccurrences: Type.Optional(
        Type.Boolean({ description: '是否替换该对象内的所有相同原文；默认 false' }),
      ),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 100, description: '按当前原文精确修改的列表' },
);
function domainRuntimeReadSpec(
  name: string,
  description: string,
  parametersSchema: TSchema = noArgs,
  resultBudgetChars = DEFAULT_RESULT_BUDGET_CHARS,
): InternalToolSpec {
  return {
    name,
    description,
    parametersSchema,
    scope: 'runtime-virtual',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    aliases: [],
    certificationNote:
      'Runtime-certified domain read: resolves one explicit author-domain target and delegates to project-scoped canonical reads.',
    resultBudgetChars,
  };
}

function domainRuntimeWriteSpec(
  name: string,
  description: string,
  parametersSchema: TSchema,
  options: {
    risk?: AgentToolRisk;
    effect?: AgentToolEffect;
    concurrency?: AgentToolConcurrency;
    approval?: AgentToolApproval;
    retry?: AgentToolRetry;
    revertStrategy?: AgentToolRevertStrategy;
  } = {},
): InternalToolSpec {
  return {
    name,
    description,
    parametersSchema,
    scope: 'runtime-virtual',
    access: 'write',
    risk: options.risk ?? 'medium',
    effect: options.effect ?? 'canon',
    concurrency: options.concurrency ?? 'exclusive_entity',
    approval: options.approval ?? 'automatic',
    retry: options.retry ?? 'inspect_before_retry',
    revertStrategy: options.revertStrategy ?? 'exact_inverse',
    aliases: [],
    certificationNote:
      'Runtime-certified domain write: the public schema contains only author-domain fields; freshness, identity resolution, durable receipts and guarded inverse remain runtime-owned.',
  };
}

const DOMAIN_RUNTIME_READ_TOOL_SPECS: InternalToolSpec[] = [
  domainRuntimeReadSpec(
    'get_project_overview',
    '读取项目概览：书名、简介、章节、灵感、故事线与写作要素目录。',
    noArgs,
    24_000,
  ),
  domainRuntimeReadSpec('get_project_facts', '读取项目级事实与写作约束。'),
  domainRuntimeReadSpec('list_chapters', '按阅读顺序列出全部章节。', noArgs, 20_000),
  domainRuntimeReadSpec(
    'read_chapter',
    '读取一章的当前正文与摘要；较长正文按返回的 cursor 继续。',
    Type.Object(
      { chapter: str('章节名'), cursor: domainCursor, maxCharacters: domainReadLimit },
      { additionalProperties: false },
    ),
    32_000,
  ),
  domainRuntimeReadSpec('list_inspirations', '列出全部自由灵感节点。', noArgs, 20_000),
  domainRuntimeReadSpec(
    'read_inspiration',
    '读取一个灵感的当前正文与摘要。',
    Type.Object(
      { inspiration: str('灵感名'), cursor: domainCursor, maxCharacters: domainReadLimit },
      { additionalProperties: false },
    ),
    32_000,
  ),
  domainRuntimeReadSpec('list_element_categories', '列出写作要素分类。', noArgs, 20_000),
  domainRuntimeReadSpec(
    'read_element_category',
    '读取一个写作要素分类的正文与模板事实。',
    Type.Object(
      { category: str('要素分类名'), cursor: domainCursor, maxCharacters: domainReadLimit },
      { additionalProperties: false },
    ),
    32_000,
  ),
  domainRuntimeReadSpec(
    'find_element_appearances',
    '查找一个写作要素在哪些章节或灵感正文中出现。',
    Type.Object({ element: str('要素名') }, { additionalProperties: false }),
    20_000,
  ),
  domainRuntimeReadSpec('list_storylines', '列出全部故事线。', noArgs, 20_000),
  domainRuntimeReadSpec(
    'read_storyline',
    '读取一条故事线的正文、摘要、事实和成员章节。',
    Type.Object(
      { storyline: str('故事线名'), cursor: domainCursor, maxCharacters: domainReadLimit },
      { additionalProperties: false },
    ),
    32_000,
  ),
  domainRuntimeReadSpec('list_relations', '列出项目内的实体关系。', noArgs, 20_000),
  domainRuntimeReadSpec(
    'list_relation_types',
    '列出项目级关系类型定义、方向、端点角色和允许的实体类型。',
    noArgs,
    20_000,
  ),
  domainRuntimeReadSpec(
    'list_entity_relations',
    '列出与一个具体实体相连的入向和出向关系。',
    Type.Object(
      { entityType: domainEntityType, entity: str('实体名，不要包含类型包装') },
      { additionalProperties: false },
    ),
    20_000,
  ),
  domainRuntimeReadSpec('list_author_rules', '列出 Agent 保存的作者偏好、否决和长期指令。'),
];

const DOMAIN_RUNTIME_WRITE_TOOL_SPECS: InternalToolSpec[] = [
  domainRuntimeWriteSpec(
    'create_chapter',
    '新建一章；标题必填，正文和摘要可同时初始化。',
    Type.Object(
      { title: str('章节标题'), body: optionalStr('初始正文'), summary: optionalStr('初始摘要') },
      { additionalProperties: false },
    ),
    { effect: 'canon', concurrency: 'exclusive_project', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'rename_chapter',
    '重命名一章。',
    Type.Object({ chapter: str('当前章节名'), title: str('新标题') }, { additionalProperties: false }),
  ),
  domainRuntimeWriteSpec(
    'set_chapter_summary',
    '设置一章的摘要。',
    Type.Object({ chapter: str('章节名'), summary: str('新摘要') }, { additionalProperties: false }),
  ),
  domainRuntimeWriteSpec(
    'revise_chapter',
    '按当前原文局部修改一章正文。',
    Type.Object({ chapter: str('章节名'), changes: domainTextChanges }, { additionalProperties: false }),
    { effect: 'prose', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'replace_chapter_body',
    '完整替换一章正文；必须先通读该章。可同时更新摘要。',
    Type.Object(
      { chapter: str('章节名'), body: str('完整新正文'), summary: optionalStr('同时设置的新摘要') },
      { additionalProperties: false },
    ),
    { risk: 'high', effect: 'prose', approval: 'review_after', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'delete_chapter',
    '删除一章；默认在执行前请求作者确认。',
    Type.Object({ chapter: str('章节名') }, { additionalProperties: false }),
    { risk: 'critical', effect: 'destructive', concurrency: 'exclusive_project', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'create_inspiration',
    '新建一个自由灵感节点。',
    Type.Object(
      { title: str('灵感标题'), body: optionalStr('初始正文'), summary: optionalStr('初始摘要') },
      { additionalProperties: false },
    ),
    { effect: 'canon', concurrency: 'exclusive_project', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'rename_inspiration',
    '重命名一个灵感节点。',
    Type.Object({ inspiration: str('当前灵感名'), title: str('新标题') }, { additionalProperties: false }),
  ),
  domainRuntimeWriteSpec(
    'set_inspiration_summary',
    '设置一个灵感节点的摘要。',
    Type.Object({ inspiration: str('灵感名'), summary: str('新摘要') }, { additionalProperties: false }),
  ),
  domainRuntimeWriteSpec(
    'revise_inspiration',
    '按当前原文局部修改一个灵感节点。',
    Type.Object({ inspiration: str('灵感名'), changes: domainTextChanges }, { additionalProperties: false }),
    { effect: 'prose', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'replace_inspiration_body',
    '完整替换一个灵感节点的正文；必须先通读。',
    Type.Object({ inspiration: str('灵感名'), body: str('完整新正文') }, { additionalProperties: false }),
    { risk: 'high', effect: 'prose', approval: 'review_after', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'delete_inspiration',
    '删除一个灵感节点；默认请求作者确认。',
    Type.Object({ inspiration: str('灵感名') }, { additionalProperties: false }),
    { risk: 'critical', effect: 'destructive', concurrency: 'exclusive_project', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'revise_element',
    '按当前原文局部修改一个写作要素的长正文。',
    Type.Object({ element: str('要素名'), changes: domainTextChanges }, { additionalProperties: false }),
    { effect: 'prose', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'replace_element_body',
    '完整替换一个写作要素的长正文；必须先通读。',
    Type.Object({ element: str('要素名'), body: str('完整新正文') }, { additionalProperties: false }),
    { risk: 'high', effect: 'prose', approval: 'review_after', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'create_element_category',
    '新建写作要素分类。',
    Type.Object({ name: str('分类名'), body: optionalStr('分类说明正文') }, { additionalProperties: false }),
    { concurrency: 'exclusive_project', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'update_element_category',
    '更新写作要素分类的名称或新要素模板事实。',
    Type.Object(
      { category: str('当前分类名'), name: optionalStr('新分类名'), templateFacts: optionalFacts('完整的模板事实') },
      { additionalProperties: false },
    ),
  ),
  domainRuntimeWriteSpec(
    'replace_element_category_body',
    '完整替换写作要素分类说明正文。',
    Type.Object({ category: str('分类名'), body: str('完整新正文') }, { additionalProperties: false }),
    { risk: 'high', effect: 'prose', approval: 'review_after', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'delete_element_category',
    '删除一个空的写作要素分类；默认请求作者确认。',
    Type.Object({ category: str('分类名') }, { additionalProperties: false }),
    { risk: 'critical', effect: 'destructive', concurrency: 'exclusive_project', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'revise_storyline',
    '按当前原文局部修改一条故事线的长正文。',
    Type.Object({ storyline: str('故事线名'), changes: domainTextChanges }, { additionalProperties: false }),
    { effect: 'prose', approval: 'review_after' },
  ),
  domainRuntimeWriteSpec(
    'replace_storyline_body',
    '完整替换一条故事线的长正文；必须先通读。',
    Type.Object({ storyline: str('故事线名'), body: str('完整新正文') }, { additionalProperties: false }),
    { risk: 'high', effect: 'prose', approval: 'review_after', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'delete_storyline',
    '删除一条故事线；默认请求作者确认。',
    Type.Object({ storyline: str('故事线名') }, { additionalProperties: false }),
    { risk: 'critical', effect: 'destructive', concurrency: 'exclusive_project', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'add_chapter_to_storyline',
    '把一章加入一条故事线。',
    Type.Object({ chapter: str('章节名'), storyline: str('故事线名') }, { additionalProperties: false }),
    { effect: 'graph' },
  ),
  domainRuntimeWriteSpec(
    'remove_chapter_from_storyline',
    '把一章从一条故事线移除；默认请求作者确认。',
    Type.Object({ chapter: str('章节名'), storyline: str('故事线名') }, { additionalProperties: false }),
    { risk: 'high', effect: 'graph', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'set_chapter_primary_storyline',
    '设置一章的主故事线，必要时自动加入该故事线。',
    Type.Object({ chapter: str('章节名'), storyline: str('故事线名') }, { additionalProperties: false }),
    { effect: 'graph' },
  ),
  domainRuntimeWriteSpec(
    'replace_storyline_chapters',
    '用给定的完整章节列表替换故事线成员；可能移除旧关系。',
    Type.Object(
      { storyline: str('故事线名'), chapters: Type.Array(Type.String(), { description: '按阅读顺序排列的完整章节名列表' }) },
      { additionalProperties: false },
    ),
    { risk: 'high', effect: 'graph', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'create_relation',
    '用一个项目关系类型，在两个已存在的实体之间新建关系。名称参数只传纯名称。',
    Type.Object(
      {
        fromType: domainEntityType,
        fromName: str('起点实体纯名称'),
        toType: domainEntityType,
        toName: str('终点实体纯名称'),
        relationType: str('来自 list_relation_types 的关系类型名称'),
      },
      { additionalProperties: false },
    ),
    { effect: 'graph', concurrency: 'exclusive_project' },
  ),
  domainRuntimeWriteSpec(
    'update_relation',
    '按 relationId 指定另一个项目关系类型。',
    Type.Object(
      {
        relationId: str('来自 list_relations 或 list_entity_relations'),
        relationType: str('来自 list_relation_types 的关系类型名称'),
      },
      { additionalProperties: false },
    ),
    { effect: 'graph', concurrency: 'exclusive_project' },
  ),
  domainRuntimeWriteSpec(
    'delete_relation',
    '按 relationId 删除一条实体关系；默认请求作者确认。',
    Type.Object({ relationId: str('来自 list_relations 或 list_entity_relations') }, { additionalProperties: false }),
    { risk: 'high', effect: 'destructive', concurrency: 'exclusive_project', approval: 'confirm_before', retry: 'never' },
  ),
  domainRuntimeWriteSpec(
    'update_comment',
    '更新批注或 TODO 的文字、类型或状态；只修改传入的字段。',
    Type.Object(
      {
        commentId: str('来自 list_comments'),
        body: optionalStr('新文字'),
        kind: Type.Optional(Type.Union([Type.Literal('note'), Type.Literal('todo')])),
        status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved')])),
      },
      { additionalProperties: false },
    ),
    { effect: 'annotation', concurrency: 'exclusive_project' },
  ),
  domainRuntimeWriteSpec(
    'create_author_rule',
    '保存一条作者长期偏好、否决或指令。',
    Type.Object(
      {
        kind: Type.Union([Type.Literal('preference'), Type.Literal('veto'), Type.Literal('directive')]),
        body: str('自包含的规则文字'),
      },
      { additionalProperties: false },
    ),
    { effect: 'memory', concurrency: 'exclusive_project' },
  ),
  domainRuntimeWriteSpec(
    'update_author_rule',
    '更新一条 Agent 创建的作者规则。',
    Type.Object(
      {
        ruleId: str('来自 list_author_rules 的 memoryId'),
        kind: Type.Optional(Type.Union([Type.Literal('preference'), Type.Literal('veto'), Type.Literal('directive')])),
        body: optionalStr('新规则文字'),
      },
      { additionalProperties: false },
    ),
    { effect: 'memory', concurrency: 'exclusive_project' },
  ),
  domainRuntimeWriteSpec(
    'delete_author_rule',
    '删除一条 Agent 创建的作者规则；默认请求作者确认。',
    Type.Object({ ruleId: str('来自 list_author_rules 的 memoryId') }, { additionalProperties: false }),
    { risk: 'high', effect: 'memory', concurrency: 'exclusive_project', approval: 'confirm_before', retry: 'never' },
  ),
];


// ---------------------------------------------------------------------------
// Runtime-only virtual contracts
// ---------------------------------------------------------------------------

const RUNTIME_VIRTUAL_TOOL_SPECS: InternalToolSpec[] = [
  ...DOMAIN_RUNTIME_READ_TOOL_SPECS,
  ...DOMAIN_RUNTIME_WRITE_TOOL_SPECS,
  {
    name: 'read_working_memory',
    description: '读取同项目所有 General Agent 共享的近期 WORKING_MEMORY.md。',
    parametersSchema: noArgs,
    scope: 'runtime-virtual',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    certificationNote:
      'Runtime-certified project-scoped rolling Working Memory read.',
    resultBudgetChars: 32_000,
  },
  {
    name: 'checkpoint_working_memory',
    description: '最终回复前更新或明确不更新共享 Working Memory。',
    parametersSchema: Type.Object(
      {
        operation: Type.Union([Type.Literal('update'), Type.Literal('noop')], {
          description: '使用 update 替换 Working Memory；无需改动时使用 noop',
        }),
        expectedRevision: Type.Integer({
          minimum: 0,
          description: '回合开始时或重新读取后得到的精确 Working Memory revision',
        }),
        contentMd: Type.Optional(
          Type.String({
            maxLength: 64_000,
            description: 'update 时提供完整替换 Markdown；noop 时省略',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    scope: 'runtime-virtual',
    access: 'write',
    risk: 'low',
    effect: 'memory',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'unavailable',
    certificationNote:
      'Runtime-certified project-scoped Markdown checkpoint with revision CAS and bounded compaction.',
    resultBudgetChars: 12_000,
  },
  {
    name: 'ask_user',
    description:
      'Pause the current turn and ask the author one focused question when a real author decision is required. Do not use it for facts available through Drifting read tools.',
    parametersSchema: Type.Object(
      {
        prompt: Type.String({
          minLength: 1,
          maxLength: 4_000,
          description:
            'One focused question for the author, including the choice or missing decision that blocks progress',
        }),
      },
      { additionalProperties: false },
    ),
    scope: 'runtime-virtual',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'exclusive_project',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    certificationNote:
      'P5 runtime-certified durable elicitation; implemented by the control plane and never dispatched through runAgentTool.',
    resultBudgetChars: 12_000,
  },
  {
    name: 'read_tool_result',
    description: 'Continue reading a truncated tool result by resultRef until truncated=false.',
    parametersSchema: Type.Object(
      {
        resultRef: Type.String({
          minLength: 1,
          description: 'resultRef returned by a truncated read tool',
        }),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: 'Unicode character offset' }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 16_000,
            description: 'Maximum Unicode characters to return',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    scope: 'runtime-virtual',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    certificationNote:
      'P1 runtime-certified session-scoped result paging; implemented by the runtime and never dispatched through runAgentTool.',
    resultBudgetChars: 16_000,
  },
];

function freezeCatalogEntry(tool: RegisteredTool): RegisteredTool {
  return Object.freeze({
    ...tool,
    aliases: Object.freeze([...tool.aliases]),
    handlerAliases: Object.freeze([...tool.handlerAliases]),
  });
}

export const AGENT_TOOL_CATALOG: readonly RegisteredTool[] = Object.freeze([
  ...GENERAL_READ_TOOL_SPECS.map(registerReadTool).map(freezeCatalogEntry),
  ...GENERAL_WRITE_TOOL_SPECS.map(registerWriteTool).map(freezeCatalogEntry),
  ...RUNTIME_VIRTUAL_TOOL_SPECS.map(registerInternalTool).map(freezeCatalogEntry),
]);

const CERTIFIED_STATUSES = new Set(['read-certified', 'write-certified', 'internal-certified']);

export const GENERAL_READ_ONLY_PROVIDER_POLICY: AgentProviderToolPolicy = {
  scopes: ['general'],
  accesses: ['read'],
  certifications: ['read-certified'],
};

export function isCertifiedTool(tool: RegisteredTool): boolean {
  return CERTIFIED_STATUSES.has(tool.certification);
}

export function isToolAllowedByPolicy(
  tool: RegisteredTool,
  policy: AgentProviderToolPolicy,
): boolean {
  if (!isCertifiedTool(tool)) return false;
  if (!policy.scopes.includes(tool.scope)) return false;
  if (!policy.accesses.includes(tool.access)) return false;
  if (!policy.certifications.includes(tool.certification)) return false;
  if (policy.allowNames && !policy.allowNames.includes(tool.name)) return false;
  if (policy.denyNames?.includes(tool.name)) return false;
  return true;
}

/**
 * Return canonical definitions only. Handler aliases and search aliases never
 * become separate provider schemas, preventing duplicate tools and split policy.
 */
export function selectProviderTools(
  policy: AgentProviderToolPolicy,
  catalog: readonly RegisteredTool[] = AGENT_TOOL_CATALOG,
): RegisteredTool[] {
  return catalog.filter((tool) => isToolAllowedByPolicy(tool, policy));
}

export const AGENT_READ_TOOLS: RegisteredTool[] = selectProviderTools(
  GENERAL_READ_ONLY_PROVIDER_POLICY,
);

export const READ_TOOL_NAMES = new Set(AGENT_READ_TOOLS.map((tool) => tool.name));

/** Resolve only real dispatcher names. Human/search aliases are not executable. */
export function resolveRegisteredDispatchTool(name: string): RegisteredTool | undefined {
  return AGENT_TOOL_CATALOG.find(
    (tool) => tool.name === name || tool.handlerAliases.includes(name),
  );
}

/** Stable lookup used by the write runtime; deprecated handler aliases resolve
 * to the one canonical entry instead of creating a second policy record. */
export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return resolveRegisteredDispatchTool(name);
}

export function registeredDispatchNames(tool: RegisteredTool): readonly string[] {
  return [tool.name, ...tool.handlerAliases];
}

export interface ListProviderToolsOptions {
  allowWrite?: boolean;
  scopes?: readonly AgentToolScope[];
  allowNames?: readonly string[];
  denyNames?: readonly string[];
}

/**
 * Convenient General Agent provider view. `allowWrite` only admits tools that
 * have independently reached `write-certified`; the current P3.1 result is
 * therefore still read-only even when a caller requests writes.
 */
export function listProviderTools(options: ListProviderToolsOptions = {}): RegisteredTool[] {
  const allowWrite = options.allowWrite === true;
  return selectProviderTools({
    scopes: options.scopes ?? ['general'],
    accesses: allowWrite ? ['read', 'write'] : ['read'],
    certifications: allowWrite ? ['read-certified', 'write-certified'] : ['read-certified'],
    allowNames: options.allowNames,
    denyNames: options.denyNames,
  });
}

/**
 * Convert to provider schemas after applying policy again at the final boundary.
 * Passing the full catalog is therefore safe: unavailable writes and internal
 * tools cannot leak through an accidentally broad caller-side array.
 */
export function toAITools(
  tools: readonly RegisteredTool[],
  policy: AgentProviderToolPolicy = GENERAL_READ_ONLY_PROVIDER_POLICY,
): AITool[] {
  return selectProviderTools(policy, tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
  }));
}
