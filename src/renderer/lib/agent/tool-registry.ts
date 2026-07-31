/**
 * Canonical Agent tool catalog and provider-exposure policy.
 *
 * `runAgentTool` remains the renderer-owned dispatcher. This catalog describes
 * every dispatcher surface (General, deprecated aliases, Shadow internals) plus
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
const optionalStr = (description: string) =>
  Type.Optional(Type.String({ description }));
const optionalInteger = (description: string) =>
  Type.Optional(Type.Integer({ minimum: 1, description }));
const expectedRevision = Type.Object(
  {
    receiptId: str('最近一次依赖读取返回的 freshness.receiptId'),
    observationId: str(
      '同一次读取返回的目标实体 freshness observation id',
    ),
    revision: str('同一 observation 返回的精确 revision；不得自行生成'),
  },
  {
    additionalProperties: false,
    description:
      '必须逐字段复制最近一次目标实体读取的 freshness 引用',
  },
);

const fact = Type.Object(
  {
    key: str('事实键'),
    value: str('事实值'),
  },
  { additionalProperties: false },
);
const facts = (description: string) =>
  Type.Array(fact, { minItems: 1, description });
const optionalFacts = (description: string) =>
  Type.Optional(Type.Array(fact, { description }));

const proseEntityTarget = {
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal('node'),
        Type.Literal('chapter'),
        Type.Literal('drift'),
      ],
      {
        description:
          'P5 已认证的正文写入仅支持 node/chapter/drift；默认 node',
      },
    ),
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
    resultBudgetChars:
      spec.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS,
    certification: 'read-certified',
    certificationNote:
      spec.certificationNote ??
      'P1 read-only runtime certification: schema validation, project isolation, no write capability.',
    aliases: spec.aliases ?? [],
    handlerAliases: spec.handlerAliases ?? [],
  };
}

function registerWriteTool(
  spec: ClassifiedToolSpec,
): RegisteredTool {
  return {
    ...spec,
    version: CATALOG_VERSION,
    scope: 'general',
    access: 'write',
    reversible: reversibleFrom(spec.revertStrategy),
    resultBudgetChars:
      spec.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS,
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
    resultBudgetChars:
      spec.resultBudgetChars ?? DEFAULT_RESULT_BUDGET_CHARS,
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
    description:
      '一次返回项目设定纲要、故事线、章节/drift 与元素目录。开始全书任务时优先调用。',
    parametersSchema: noArgs,
    aliases: ['overview', '项目概览', '全书概览'],
    resultBudgetChars: 24_000,
  },
  {
    name: 'get_project_brief',
    description:
      '本书设定纲要：项目名、简介、作者的 key/value 事实与结构计数。',
    parametersSchema: noArgs,
    aliases: ['project brief', '项目设定'],
  },
  {
    name: 'list_nodes',
    description:
      '按名字列出项目故事线、章节与 drift。章节包含状态、字数和主故事线。',
    parametersSchema: noArgs,
    aliases: ['nodes', 'chapters', '章节列表', '漂流列表'],
    resultBudgetChars: 20_000,
    certificationNote:
      'P3 read audit: projectId-filtered Zustand projection only; it calls no write usecase and exposes no cross-project rows.',
  },
  {
    name: 'list_elements',
    description:
      '按名字列出项目的元素类目与元素（角色/设定/物件）：name · category · summary。',
    parametersSchema: noArgs,
    aliases: ['elements', '角色列表', '元素列表'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'read_element',
    description:
      '读一个元素（角色/设定/物件）：名称、简介、别名、分组、类目、KV 事实与正文。',
    parametersSchema: Type.Object(
      { element: str('元素名称') },
      { additionalProperties: false },
    ),
    aliases: ['element detail', '读取角色', '读取元素'],
  },
  {
    name: 'get_element_patches',
    description:
      '读取一个元素跨章被接受的状态变更，每条带来源章节与正文。',
    parametersSchema: Type.Object(
      { element: str('元素名称') },
      { additionalProperties: false },
    ),
    aliases: ['element evolution', '角色演变', '元素补丁'],
  },
  {
    name: 'read_node',
    description:
      '把正文读成按段编号的紧凑列表。传 prose:false 只读表头；kind 可指定 element/storyline/category。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名；配合 kind 时也可传其他正文实体名'),
        kind: Type.Optional(
          str('element / storyline / category；省略表示章节或 drift'),
        ),
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
        kind: Type.Optional(
          str('element / storyline / category；省略表示章节或 drift'),
        ),
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
    description:
      '按 1-based 段号和/或文本片段查找正文块的稳定 blockId；不会修改或补写 blockId。',
    parametersSchema: Type.Object(
      {
        node: str('章节/drift 名；配合 kind 时也可传其他正文实体名'),
        kind: Type.Optional(
          str('element / storyline / category；省略表示章节或 drift'),
        ),
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
    description:
      '读取一条故事线的梗概、KV 事实，以及按阅读顺序排列的成员章节。',
    parametersSchema: Type.Object(
      { storyline: str('故事线名') },
      { additionalProperties: false },
    ),
    aliases: ['storyline detail', '故事线'],
  },
  {
    name: 'get_entity_relations',
    description:
      '列出触及某实体的策展关系边（出向与入向），用于走作者定义的故事图谱。',
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
      '找一个结构实体在哪些章节/drift 正文里被提及，按来源分组返回计数与片段。',
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
      '在章节/drift 正文与元素正文里做大小写不敏感全文检索。',
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
    description:
      '跨章节/drift 标题、元素名/简介/别名与故事线名做快速元数据检索，不搜索正文。',
    parametersSchema: Type.Object(
      { query: str('要检索的文本') },
      { additionalProperties: false },
    ),
    aliases: ['project search', '项目搜索'],
  },
  {
    name: 'list_comments',
    description:
      '列出项目批注、TODO 与作者标记，可按实体、状态或 onlyTodos 过滤。',
    parametersSchema: Type.Object(
      {
        kind: Type.Optional(
          str('可选实体类型：node/element/storyline/category'),
        ),
        entity: Type.Optional(str('可选实体名称；与 kind 配合')),
        status: Type.Optional(str('可选状态：open/resolved/converted')),
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
      '列出本项目仍有效或待确认的 Agent 记忆，包括偏好、否决和长期指令。',
    parametersSchema: noArgs,
    aliases: ['memories', '记忆', '长期指令'],
  },
  {
    name: 'list_materials',
    description:
      '按标题列出项目素材库：title · kind · source；text 素材附 chars。',
    parametersSchema: noArgs,
    aliases: ['materials', '素材库'],
    resultBudgetChars: 20_000,
  },
  {
    name: 'read_material',
    description:
      '按标题读取一个素材。text 返回全文，image/pdf/url 返回元数据。',
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
    description:
      '更新元素名称、简介、别名、分组、类目或结构化事实；只修改提供的字段。',
    parametersSchema: Type.Object(
      {
        element: str('元素名称'),
        name: optionalStr('新名称'),
        summary: optionalStr('新简介'),
        aliases: Type.Optional(Type.Array(Type.String())),
        groupName: optionalStr('新分组名'),
        category: optionalStr('新类目名称'),
        facts: optionalFacts('替换元素结构化事实'),
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['update character', '更新元素'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: exact element freshness, atomic element/outbox receipt, crash reconciliation, soft review, and guarded exact inverse.',
  },
  {
    name: 'set_entity_body',
    description:
      '整体替换元素、故事线或类目的长正文；章节/drift 必须使用 block 工具。',
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
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: [
      'set_element_body',
      'set element body',
      '整体替换实体正文',
    ],
    handlerAliases: ['set_element_body'],
  },
  {
    name: 'create_element',
    description: '在指定类目下创建一个角色、地点、物件或其他元素。',
    parametersSchema: Type.Object(
      {
        category: str('类目名称'),
        name: optionalStr('元素名称'),
        summary: optionalStr('简介'),
        aliases: Type.Optional(Type.Array(Type.String())),
        facts: optionalFacts('新元素的结构化事实'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'compensating',
    aliases: ['create character', '创建元素'],
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
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['rename chapter', '重命名章节'],
    certification: 'write-certified',
    certificationNote:
      'P3 exact field-write certification: durable idempotency/effect receipt, renderer rename usecase, soft review, and guarded exact inverse.',
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
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['set chapter summary', '设置章节梗概'],
    certification: 'write-certified',
    certificationNote:
      'P3 exact field-write certification: durable idempotency/effect receipt, renderer update usecase, soft review, and guarded exact inverse.',
  },
  {
    name: 'edit_block',
    description:
      '原位替换一个正文块的文本，可按 read_node 段号或稳定 blockId 定位。',
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
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['replace paragraph', '改写段落'],
    certification: 'write-certified',
    certificationNote:
      'P5 Yjs prose certification: exact read freshness, deterministic command, atomic Yjs/projection/outbox receipt, soft review, and guarded semantic inverse.',
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
              text: str(
                '替换后的纯内容文本；不要复制 read_node 的「# 」或「> 」块类型前缀',
              ),
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
    approval: 'soft_review',
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
    approval: 'soft_review',
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
        blockNumbers: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1 })),
        ),
        blockIds: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'prose',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
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
    approval: 'soft_review',
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
    approval: 'soft_review',
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
    approval: 'soft_review',
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
    approval: 'soft_review',
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
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['primary storyline', '设置主故事线'],
  },
  {
    name: 'add_relation',
    description: '创建一条作者策展的跨实体关系边。',
    parametersSchema: Type.Object(
      {
        fromKind: str('源实体类型'),
        from: str('源实体名称'),
        toKind: str('目标实体类型'),
        to: str('目标实体名称'),
        kind: optionalStr('关系标签'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
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
    approval: 'soft_review',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['delete relation', '删除关系'],
  },
  {
    name: 'update_relation_kind',
    description: '按 relationId 修改或清空关系标签。',
    parametersSchema: Type.Object(
      {
        relationId: str('来自 get_entity_relations 的 relationId'),
        kind: optionalStr('新关系标签；空字符串表示清空'),
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'graph',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['relabel relation', '修改关系类型'],
  },
  {
    name: 'create_storyline',
    description: '创建一条新故事线。',
    parametersSchema: Type.Object(
      { name: optionalStr('故事线名'), summary: optionalStr('梗概') },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'compensating',
    aliases: ['new storyline', '创建故事线'],
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
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['edit storyline', '更新故事线'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: exact storyline freshness, atomic storyline/outbox receipt, crash reconciliation, soft review, and guarded exact inverse.',
  },
  {
    name: 'create_category',
    description: '创建一个元素类目。',
    parametersSchema: Type.Object(
      { name: optionalStr('类目名') },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
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
    approval: 'soft_review',
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
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'canon',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['update book facts', '更新项目事实'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: exact project freshness, atomic project/outbox receipt, crash reconciliation, soft review, and guarded exact inverse.',
  },
  {
    name: 'remember',
    description:
      '保存作者级长期偏好、否决或指令；故事事实应写入 canon 而不是记忆。',
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
    approval: 'soft_review',
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
    approval: 'soft_review',
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
    approval: 'soft_review',
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
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['record evolution', '创建元素补丁'],
    certification: 'write-certified',
    certificationNote:
      'P5 element-patch certification: exact patch-set freshness, deterministic id, atomic patch/outbox receipt, soft review, and guarded exact delete inverse.',
  },
  {
    name: 'update_element_patch',
    description: '按 patchId 更新元素补丁标题或正文。',
    parametersSchema: Type.Object(
      {
        patchId: str('来自 get_element_patches 的 patchId'),
        title: optionalStr('新标题'),
        body: optionalStr('新正文'),
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['edit evolution', '更新元素补丁'],
    certification: 'write-certified',
    certificationNote:
      'P5 element-patch certification: exact patch freshness, atomic patch/outbox receipt, crash reconciliation, soft review, and guarded exact field inverse.',
  },
  {
    name: 'delete_element_patch',
    description: '按 patchId 软删除元素补丁并交给作者审阅。',
    parametersSchema: Type.Object(
      { patchId: str('来自 get_element_patches 的 patchId') },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'canon',
    concurrency: 'exclusive_entity',
    approval: 'soft_review',
    retry: 'never',
    revertStrategy: 'exact_inverse',
    aliases: ['remove evolution', '删除元素补丁'],
  },
  {
    name: 'create_comment',
    description: '创建批注、TODO 或 Shadow exception，可锚定实体或正文块。',
    parametersSchema: Type.Object(
      {
        body: str('批注正文'),
        kind: optionalStr('note（默认）| todo | exception'),
        targetKind: optionalStr('node / element / storyline / ...'),
        target: optionalStr('目标实体名称'),
        targetBlockId: optionalStr('可选正文块 uuid'),
        expectedRevision,
      },
      { additionalProperties: false },
    ),
    risk: 'low',
    effect: 'annotation',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['add todo', '创建批注', '创建待办'],
    certification: 'write-certified',
    certificationNote:
      'P6 entity-write certification: project freshness, deterministic comment id, atomic comment/outbox receipt, crash reconciliation, and guarded exact delete inverse.',
  },
  {
    name: 'delete_comment',
    description: '按 commentId 删除批注或 TODO，并在执行前请求作者确认。',
    parametersSchema: Type.Object(
      { commentId: str('来自 list_comments 的 commentId') },
      { additionalProperties: false },
    ),
    risk: 'high',
    effect: 'destructive',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'irreversible',
    aliases: ['delete todo', '删除批注'],
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
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['resolve todo', '设置批注状态'],
  },
  {
    name: 'set_comment_kind',
    description: '把批注类型改为 todo、note 或 exception。',
    parametersSchema: Type.Object(
      {
        commentId: str('来自 list_comments 的 commentId'),
        kind: str('todo | note | exception'),
      },
      { additionalProperties: false },
    ),
    risk: 'medium',
    effect: 'annotation',
    concurrency: 'exclusive_project',
    approval: 'soft_review',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    aliases: ['convert todo', '设置批注类型'],
  },
  {
    name: 'delete_element',
    description: '删除一个元素；执行前必须由作者明确确认。',
    parametersSchema: Type.Object(
      { element: str('元素名') },
      { additionalProperties: false },
    ),
    risk: 'critical',
    effect: 'destructive',
    concurrency: 'exclusive_project',
    approval: 'confirm_before',
    retry: 'never',
    revertStrategy: 'irreversible',
    aliases: ['delete character', '删除元素'],
  },
];

// ---------------------------------------------------------------------------
// Renderer-only Shadow contracts
// ---------------------------------------------------------------------------

const shadowFinding = Type.Object(
  {
    message: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    blockId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    blockIds: Type.Optional(Type.Array(Type.String())),
    ruleId: Type.Optional(Type.String()),
    itemId: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const SHADOW_INTERNAL_TOOL_SPECS: InternalToolSpec[] = [
  {
    name: 'shadow_read_chapter_snapshot',
    description: 'Shadow pipeline internal: read the locked chapter and canon snapshot.',
    parametersSchema: Type.Object(
      { chapterId: str('Canonical chapter id') },
      { additionalProperties: false },
    ),
    scope: 'shadow-internal',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    certificationNote:
      'Existing renderer-owned Shadow gather contract; internal-only and never eligible for the General Agent provider menu.',
  },
  {
    name: 'shadow_read_rules',
    description: 'Shadow pipeline internal: read enabled project review rules.',
    parametersSchema: Type.Object(
      {
        projectId: Type.Optional(Type.String()),
        chapterId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    scope: 'shadow-internal',
    access: 'read',
    risk: 'none',
    effect: 'none',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'safe',
    revertStrategy: 'not_applicable',
    certificationNote:
      'Existing renderer-owned Shadow resolve contract; internal-only and project-scoped by the active context.',
  },
  {
    name: 'shadow_eval_semantic_batch',
    description: 'Shadow pipeline internal: run one semantic assertion batch.',
    parametersSchema: Type.Object(
      {
        assertions: Type.Array(Type.String()),
        chapterId: str('Canonical chapter id'),
        projectId: Type.Optional(Type.String()),
        facts: Type.Optional(Type.Record(Type.String(), Type.String())),
        summary: Type.Optional(Type.String()),
        ruleKind: Type.Optional(Type.String()),
        judgingGuide: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    scope: 'shadow-internal',
    access: 'read',
    risk: 'medium',
    effect: 'external',
    concurrency: 'parallel',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'not_applicable',
    certificationNote:
      'Existing renderer-owned Shadow check contract; may call the configured judge provider but cannot mutate authored state.',
    resultBudgetChars: 24_000,
  },
  {
    name: 'shadow_commit_review',
    description: 'Shadow pipeline internal: atomically commit findings and review status.',
    parametersSchema: Type.Object(
      {
        chapterId: str('Canonical chapter id'),
        findings: Type.Array(shadowFinding),
        status: Type.Union([Type.Literal('finished'), Type.Literal('draft')]),
      },
      { additionalProperties: false },
    ),
    scope: 'shadow-internal',
    access: 'write',
    risk: 'medium',
    effect: 'review',
    concurrency: 'exclusive_entity',
    approval: 'automatic',
    retry: 'inspect_before_retry',
    revertStrategy: 'exact_inverse',
    certificationNote:
      'Existing renderer-owned Shadow commit boundary; internal-only and excluded from every General Agent provider policy.',
  },
];

// ---------------------------------------------------------------------------
// Runtime-only virtual contracts
// ---------------------------------------------------------------------------

const RUNTIME_VIRTUAL_TOOL_SPECS: InternalToolSpec[] = [
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
    description:
      'Continue reading a truncated tool result by resultRef until truncated=false.',
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
  ...GENERAL_WRITE_TOOL_SPECS.map(registerWriteTool).map(
    freezeCatalogEntry,
  ),
  ...SHADOW_INTERNAL_TOOL_SPECS.map(registerInternalTool).map(
    freezeCatalogEntry,
  ),
  ...RUNTIME_VIRTUAL_TOOL_SPECS.map(registerInternalTool).map(
    freezeCatalogEntry,
  ),
]);

const CERTIFIED_STATUSES = new Set([
  'read-certified',
  'write-certified',
  'internal-certified',
]);

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
export function resolveRegisteredDispatchTool(
  name: string,
): RegisteredTool | undefined {
  return AGENT_TOOL_CATALOG.find(
    (tool) => tool.name === name || tool.handlerAliases.includes(name),
  );
}

/** Stable lookup used by the write runtime; deprecated handler aliases resolve
 * to the one canonical entry instead of creating a second policy record. */
export function getRegisteredTool(
  name: string,
): RegisteredTool | undefined {
  return resolveRegisteredDispatchTool(name);
}

export function registeredDispatchNames(
  tool: RegisteredTool,
): readonly string[] {
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
export function listProviderTools(
  options: ListProviderToolsOptions = {},
): RegisteredTool[] {
  const allowWrite = options.allowWrite === true;
  return selectProviderTools({
    scopes: options.scopes ?? ['general'],
    accesses: allowWrite ? ['read', 'write'] : ['read'],
    certifications: allowWrite
      ? ['read-certified', 'write-certified']
      : ['read-certified'],
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
