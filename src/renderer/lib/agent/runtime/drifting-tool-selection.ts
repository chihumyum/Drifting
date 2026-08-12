import {
  AGENT_TOOL_CATALOG,
  type AgentProviderToolPolicy,
  type RegisteredTool,
} from '../tool-registry';
import { DRIFTING_TOOL_SEARCH_METADATA } from './tool-search-metadata';
import { createToolSelector, type ToolSearchMetadataByName } from './tool-selector';
import type { AgentToolSelectionStrategy } from './types';
import { isBroadAutonomousProjectCampaign } from './long-task-intent';

const RESULT_PAGE_TOOL = 'read_tool_result';
const ASK_USER_TOOL = 'ask_user';
const OVERVIEW_TOOL = 'get_overview';
const LONG_TASK_TOOLS = Object.freeze([
  'read_task_plan',
  'update_task_plan',
  'update_task_step',
] as const);
const LONG_TASK_CONSTRAINT_TOOL = 'update_task_constraint';
const LONG_TASK_PROSE_TOOLS = Object.freeze(['read_node', 'edit_blocks'] as const);
const MAX_DYNAMIC_TOOLS = 2;
const MIN_BUILT_IN_TOOL_SLOTS = 2;
const WRITE_PREREQUISITE_READS: Readonly<Record<string, readonly string[] | undefined>> =
  Object.freeze({
    rename_node: Object.freeze(['read_node']),
    set_node_summary: Object.freeze(['read_node']),
    edit_block: Object.freeze(['read_node']),
    edit_blocks: Object.freeze(['read_node']),
    append_paragraph: Object.freeze(['read_node']),
    insert_blocks: Object.freeze(['read_node']),
    remove_blocks: Object.freeze(['read_node']),
    replace_block_range: Object.freeze(['read_node']),
    create_element_patch: Object.freeze(['get_element_patches']),
    update_element_patch: Object.freeze(['get_element_patches']),
    update_element: Object.freeze(['read_element']),
    update_storyline: Object.freeze(['get_storyline']),
    update_project_facts: Object.freeze(['get_project_brief']),
    create_comment: Object.freeze(['get_project_brief']),
  });

const REDUNDANT_DIRECTORY_READS_AFTER_SUCCESS: Readonly<
  Record<string, readonly string[] | undefined>
> = Object.freeze({
  get_overview: Object.freeze([OVERVIEW_TOOL, 'get_project_brief', 'list_nodes', 'list_elements']),
  // get_overview is a strict superset of get_project_brief. A successful
  // brief therefore suppresses only another brief; a compound request may
  // still need the overview's node and element directories.
  get_project_brief: Object.freeze(['get_project_brief']),
  list_nodes: Object.freeze(['list_nodes', OVERVIEW_TOOL]),
  list_elements: Object.freeze(['list_elements', OVERVIEW_TOOL]),
});

export const DRIFTING_RUNTIME_TOOL_SEARCH_POLICY: AgentProviderToolPolicy =
  Object.freeze<AgentProviderToolPolicy>({
    scopes: ['general'],
    accesses: ['read', 'write'],
    certifications: ['read-certified', 'write-certified'],
  });

export interface CreateDriftingToolSelectionOptions {
  catalog?: readonly RegisteredTool[];
  policy?: AgentProviderToolPolicy;
  searchMetadata?: ToolSearchMetadataByName;
}

function originalRequest(query: string): string {
  const marker = 'original request:\n';
  const start = query.indexOf(marker);
  if (start < 0) return query;
  const value = query.slice(start + marker.length);
  const recentWork = value.indexOf('\nrecent work:\n');
  return recentWork < 0 ? value : value.slice(0, recentWork);
}

function isToolNameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9_]/iu.test(value);
}

function isNegatedToolReference(request: string, index: number): boolean {
  const clauseStart = Math.max(
    request.lastIndexOf('\n', index - 1),
    request.lastIndexOf('。', index - 1),
    request.lastIndexOf('！', index - 1),
    request.lastIndexOf('？', index - 1),
    request.lastIndexOf(';', index - 1),
    request.lastIndexOf('；', index - 1),
    request.lastIndexOf(',', index - 1),
    request.lastIndexOf('，', index - 1),
  );
  const prefix = request
    .slice(Math.max(clauseStart + 1, index - 48), index)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
  return (
    /(?:不要|请勿|禁止|别|无需|不必|不能|不可|不准|避免)\s*(?:再\s*)?(?:(?:实际|继续)\s*)?(?:(?:调用|使用|执行|选择|暴露)\s*)?$/iu.test(
      prefix,
    ) ||
    /\b(?:do not|don't|never|must not|should not)\s+(?:(?:call|use|execute|select|expose)\s+)?$/iu.test(
      prefix,
    ) ||
    /\bwithout\s+(?:calling|using|executing|selecting|exposing)\s+$/iu.test(prefix)
  );
}

/**
 * An author may name the exact runtime tools they expect to be used. Those
 * canonical names are stronger evidence than fuzzy retrieval and must not be
 * displaced by description/schema overlap. Names are still intersected with
 * the already policy-filtered executable set, and explicit negations are
 * ignored so "do not call get_overview" cannot accidentally expose it.
 */
function explicitlyNamedExecutableTools(
  query: string,
  executableNames: ReadonlySet<string>,
): readonly string[] {
  const request = originalRequest(query).normalize('NFKC');
  const normalized = request.toLocaleLowerCase('en-US');
  const matches: Array<{ index: number; name: string }> = [];

  for (const name of executableNames) {
    if (name.startsWith('mcp__') || name.startsWith('plugin__')) continue;
    const needle = name.normalize('NFKC').toLocaleLowerCase('en-US');
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(needle, from);
      if (index < 0) break;
      from = index + needle.length;
      if (
        isToolNameCharacter(normalized[index - 1]) ||
        isToolNameCharacter(normalized[index + needle.length]) ||
        isNegatedToolReference(request, index)
      ) {
        continue;
      }
      matches.push({ index, name });
      break;
    }
  }

  matches.sort(
    (left, right) => left.index - right.index || left.name.localeCompare(right.name, 'en'),
  );
  return matches.map((match) => match.name);
}

function explicitlyNegatedExecutableTools(
  query: string,
  executableNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const request = originalRequest(query).normalize('NFKC');
  const normalized = request.toLocaleLowerCase('en-US');
  const negated = new Set<string>();
  for (const name of executableNames) {
    const needle = name.normalize('NFKC').toLocaleLowerCase('en-US');
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(needle, from);
      if (index < 0) break;
      from = index + needle.length;
      if (
        !isToolNameCharacter(normalized[index - 1]) &&
        !isToolNameCharacter(normalized[index + needle.length]) &&
        isNegatedToolReference(request, index)
      ) {
        negated.add(name);
        break;
      }
    }
  }
  return negated;
}

function withoutNegatedForeignProjectClauses(request: string): string {
  return request
    .replace(
      /(?:不要|请勿|禁止|不能|不可|不必|无需|别|不).{0,8}(?:读取|访问|查看|检索|搜索|介绍|总结|展示|打开|切换到).{0,20}(?:另一个|其他|别的|非当前)(?:项目|小说|书)(?:\s+(?:fixture-)?project-[a-z0-9][a-z0-9_-]*)?/giu,
      ' ',
    )
    .replace(
      /(?:不要|请勿|禁止|不能|不可|不必|无需|别|不).{0,8}(?:另一个|其他|别的|非当前)(?:项目|小说|书).{0,20}(?:读取|访问|查看|检索|搜索|介绍|总结|展示|打开|切换到)/giu,
      ' ',
    )
    .replace(
      /(?:不要|请勿|禁止|不能|不可|不必|无需|别|不).{0,8}(?:读取|访问|查看|检索|搜索|介绍|总结|展示|打开|切换到).{0,12}(?:项目|小说|书)\s+(?:fixture-)?project-[a-z0-9][a-z0-9_-]*/giu,
      ' ',
    )
    .replace(
      /(?:不要|请勿|禁止|不能|不可|不必|无需|别|不).{0,8}(?:忽略|绕过|离开|切换离开|切换出).{0,12}(?:当前|本)(?:项目|小说|书)/giu,
      ' ',
    )
    .replace(
      /\b(?:do not|don['’]t|never|must not)\b.{0,24}\b(?:read|access|inspect|search|show|summari[sz]e|describe|open|switch (?:to|into))\b.{0,30}\b(?:another|other|different|foreign) (?:project|book)\b(?:\s+(?:fixture-)?project-[a-z0-9][a-z0-9_-]*)?/giu,
      ' ',
    )
    .replace(
      /\b(?:do not|don['’]t|never|must not)\b.{0,24}\b(?:another|other|different|foreign) (?:project|book)\b.{0,30}\b(?:read|access|inspect|search|show|summari[sz]e|describe|open|switch (?:to|into))\b/giu,
      ' ',
    )
    .replace(
      /\b(?:do not|don['’]t|never|must not)\b.{0,24}\b(?:read|access|inspect|search|show|summari[sz]e|describe|open)\b.{0,20}\b(?:project|book)\s+(?:fixture-)?project-[a-z0-9][a-z0-9_-]*/giu,
      ' ',
    )
    .replace(
      /\b(?:do not|don['’]t|never|must not)\b.{0,24}\b(?:ignore|bypass|leave|switch (?:away )?from)\b.{0,24}\b(?:the )?current (?:project|book)\b/giu,
      ' ',
    );
}

function explicitlyReferencesDifferentProject(
  request: string,
  currentProjectId: string | undefined,
): boolean {
  if (!currentProjectId) return false;
  const currentId = currentProjectId.normalize('NFKC').toLocaleLowerCase('en-US');
  const references = [
    ...request.matchAll(
      /(?:项目|project|book)\s*(?:id\s*[:=]\s*)?["'“”]?((?:fixture-)?project-[a-z0-9][a-z0-9_-]*|[0-9a-f]{8}-[0-9a-f-]{27,})/giu,
    ),
    ...request.matchAll(
      /\b((?:fixture-)?project-[a-z0-9][a-z0-9_-]*|[0-9a-f]{8}-[0-9a-f-]{27,})\b.{0,16}(?:的)?(?:项目|概览|简介|project|book|overview)/giu,
    ),
  ];
  return references.some(
    (match) => match[1]?.normalize('NFKC').toLocaleLowerCase('en-US') !== currentId,
  );
}

/**
 * A Drifting turn is permanently bound to one route project. If the author
 * explicitly asks to ignore that boundary and inspect another project, expose
 * no data tools so the model can only refuse. Tool handlers are independently
 * project-scoped; this guard prevents a misleading current-project read from
 * being presented as if it answered the foreign-project request.
 */
function explicitlyRequestsForeignProject(
  query: string,
  currentProjectId: string | undefined,
): boolean {
  const request = withoutNegatedForeignProjectClauses(originalRequest(query).normalize('NFKC'));
  if (explicitlyReferencesDifferentProject(request, currentProjectId)) {
    return true;
  }
  return (
    /(?:读取|访问|查看|检索|搜索|介绍|总结|展示|打开|切换到).{0,20}(?:另一个|其他|别的|非当前)(?:项目|小说|书)/iu.test(
      request,
    ) ||
    /(?:另一个|其他|别的|非当前)(?:项目|小说|书).{0,20}(?:读取|访问|查看|检索|搜索|介绍|总结|展示|打开|切换到)/iu.test(
      request,
    ) ||
    /(?:离开|切换离开|切换出).{0,8}(?:当前|本)(?:项目|小说|书)/iu.test(request) ||
    /(?:忽略|绕过).{0,8}(?:当前|本)(?:项目|小说|书).{0,8}(?:边界|限制|作用域|范围|权限)/iu.test(
      request,
    ) ||
    /\b(?:read|access|inspect|search|show|summari[sz]e|describe|open)\b.{0,30}\b(?:another|other|different|foreign) (?:project|book)\b/iu.test(
      request,
    ) ||
    /\bswitch (?:to|into)\b.{0,24}\b(?:another|other|different|foreign) (?:project|book)\b/iu.test(
      request,
    ) ||
    /\b(?:another|other|different|foreign) (?:project|book)\b.{0,30}\b(?:read|access|inspect|search|show|summari[sz]e|describe|open)\b/iu.test(
      request,
    ) ||
    /\b(?:leave|switch (?:away )?from)\b.{0,24}\b(?:the )?current (?:project|book)\b/iu.test(
      request,
    ) ||
    /\b(?:ignore|bypass)\b.{0,24}\b(?:the )?current (?:project|book)\b.{0,16}\b(?:boundary|scope|limits?|permissions?)\b/iu.test(
      request,
    )
  );
}

function explicitCatalogReads(query: string): readonly string[] {
  const request = originalRequest(query).normalize('NFKC');
  const overview =
    /(?:全书|项目|小说|本书).{0,8}(?:概览|简介|介绍)|介绍.{0,8}(?:这个|这本)?(?:小说|书|项目)|whole[- ]book overview|project overview|introduce.{0,24}(?:novel|book|project)/iu.test(
      request,
    );
  if (overview) return [OVERVIEW_TOOL];

  const reads: string[] = [];
  if (
    /(?:列出|罗列|显示|查看|有哪些|全部).{0,24}(?:章节|漂流节点|drifts?|nodes?)|(?:章节|漂流节点).{0,12}(?:列表|目录|清单|有哪些)|\b(?:list|show|browse)\b.{0,40}\b(?:chapters?|drifts?|nodes?)\b|chapter (?:list|directory)/iu.test(
      request,
    )
  ) {
    reads.push('list_nodes');
  }
  if (
    /(?:列出|罗列|显示|查看|有哪些|全部).{0,24}(?:角色|人物|元素|设定|物件)|(?:角色|人物|元素|物件).{0,12}(?:列表|目录|清单|有哪些)|\b(?:list|show|browse)\b.{0,40}\b(?:characters?|elements?|settings?|objects?)\b/iu.test(
      request,
    )
  ) {
    reads.push('list_elements');
  }
  if (/(?:项目|本书|作品).{0,8}(?:设定纲要|基础设定)|project brief|book premise/iu.test(request)) {
    reads.push('get_project_brief');
  }
  return reads;
}

function explicitNarrowReads(query: string): readonly string[] {
  const request = originalRequest(query).normalize('NFKC');
  if (
    /(?:已经|已).{0,6}(?:接受|采纳|生效).{0,12}(?:角色|人物|元素)?(?:演变|变化|补丁)/iu.test(
      request,
    ) ||
    /\b(?:accepted|applied|in-effect)\b.{0,20}\b(?:character|element)? ?(?:evolution|changes?|patches?)\b/iu.test(
      request,
    )
  ) {
    return ['get_element_patches'];
  }
  if (
    /(?:读取|查看|打开)素材\s*["“'「『]/iu.test(request) ||
    /\bread (?:the )?material\s+(?!(?:list|library)\b)\S+/iu.test(request)
  ) {
    return ['read_material'];
  }
  return [];
}

function needsMoreThanNarrowRead(query: string): boolean {
  const request = originalRequest(query).normalize('NFKC');
  return (
    /正文|段落|章节|场景|改写|修改|编辑|写入|写进|插入|追加|替换|移动|删除|创建|新建|重命名|改名|更新|设置|关联|解除|链接|引用|应用|加入|放入|合并|同步|复制|续写|生成|创作|对比|比较|结合/iu.test(
      request,
    ) ||
    /\b(?:chapter|prose|paragraph|block|scene|draft|compose|edit|write|rewrite|insert|append|replace|move|delete|create|rename|update|set|link|unlink|relate|apply|add|merge|sync|copy|continue|generate|compare|contrast|combine)\b/iu.test(
      request,
    )
  );
}

function needsMoreThanCatalogReads(query: string): boolean {
  const request = originalRequest(query).normalize('NFKC');
  return (
    /正文|段落|详情|逐章|逐段|总结|摘要|搜索|查找|检索|出场|在哪里出现|何处出现|出现在哪|提及|关系|评论|批注|素材|改写|修改|编辑|创建|新建|删除|重命名|改名|设置|关联|解除|更新|追加|插入|替换|移动|写入|续写/iu.test(
      request,
    ) ||
    /\b(?:summari[sz]e|search|find|detail|edit|write|create|delete|rename|update|append|insert|replace|link|unlink|comment|material|relation|prose|block|appearance)\b/iu.test(
      request,
    ) ||
    /\b(?:read|inspect)\b.{0,30}\b(?:chapter|prose|block|element|material|comment)\b/iu.test(
      request,
    )
  );
}

function redundantDirectoryReads(successfulReadNames: readonly string[]): ReadonlySet<string> {
  const redundant = new Set<string>();
  for (const successfulRead of successfulReadNames) {
    for (const name of REDUNDANT_DIRECTORY_READS_AFTER_SUCCESS[successfulRead] ?? []) {
      redundant.add(name);
    }
  }
  return redundant;
}

const LOOKUP_FAILURE_RECOVERY_READS: Readonly<Record<string, readonly string[] | undefined>> =
  Object.freeze({
    read_node: Object.freeze(['search_project', 'list_nodes', 'list_elements']),
    read_element: Object.freeze(['search_project', 'list_elements']),
    get_element_patches: Object.freeze(['search_project', 'list_elements']),
    get_storyline: Object.freeze(['list_nodes']),
    read_material: Object.freeze(['list_materials']),
    read_block: Object.freeze(['read_node']),
    lookup_block: Object.freeze(['read_node']),
  });

function failedLookupRecovery(
  query: string,
  previousBatchHadSuccessfulRead: boolean,
): { failedTools: ReadonlySet<string>; reads: readonly string[] } {
  if (previousBatchHadSuccessfulRead) {
    return { failedTools: new Set(), reads: [] };
  }
  const recentSections = query.split('\nrecent work:\n');
  const recent = recentSections[recentSections.length - 1] ?? '';
  const failedTools = new Set<string>();
  const reads: string[] = [];
  for (const match of recent.matchAll(/tool failure ([a-z0-9_]+): ([^\n]*)/giu)) {
    const name = match[1] ?? '';
    const message = match[2] ?? '';
    if (
      !LOOKUP_FAILURE_RECOVERY_READS[name] ||
      !/(?:\bNo\b.{0,80}\bnamed\b|\bnot found\b|\bdoes not exist\b|不存在|找不到)/iu.test(message)
    ) {
      continue;
    }
    failedTools.add(name);
    appendUnique(reads, LOOKUP_FAILURE_RECOVERY_READS[name] ?? []);
  }
  return { failedTools, reads };
}

function needsLongTaskLedger(query: string): boolean {
  const request = originalRequest(query).normalize('NFKC');
  return (
    /^\s*(?:继续|接着|往下)(?:做|完成|处理|润色|修改|写|执行)?/iu.test(request) ||
    /^\s*(?:continue|resume|go on)\b/iu.test(request) ||
    /整本|整部(?:小说|作品)|全书|逐章|全部章节|所有章节|全部正文|批量.{0,12}(?:章节|正文)|长任务|任务计划|继续.{0,8}任务|恢复.{0,8}任务|未完成.{0,8}任务/iu.test(
      request,
    ) ||
    /\b(?:whole[- ]book|entire (?:book|novel|manuscript)|full manuscript|all chapters?|every chapter|long[- ]running|long task|task plan|resume (?:the )?task|continue (?:the )?task)\b/iu.test(
      request,
    ) ||
    isBroadAutonomousProjectCampaign(request)
  );
}

function needsLongTaskProseMutation(query: string): boolean {
  if (!needsLongTaskLedger(query)) return false;
  const request = originalRequest(query).normalize('NFKC');
  return (
    /润色|改写|重写|修订|编辑|修改|校对|优化.{0,8}(?:正文|文风|文字|表达)|续写|扩写|精简/iu.test(
      request,
    ) ||
    /\b(?:polish|rewrite|revise|edit|proofread|copyedit|refine|improve|continue|expand|condense)\b/iu.test(
      request,
    )
  );
}

function needsLongTaskConstraintTool(query: string): boolean {
  const request = originalRequest(query).normalize('NFKC');
  return (
    /约束|要求|偏好|始终|绝不|不要|必须|保持.{0,8}(?:一致|不变)/iu.test(request) ||
    /\b(?:constraint|requirement|preference|must|never|always|keep .{0,20} consistent)\b/iu.test(
      request,
    )
  );
}

function lexicalTerms(value: string): readonly string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)) {
    const term = match[0];
    terms.add(term);
    if (/^[\p{Script=Han}]+$/u.test(term) && term.length > 2) {
      for (let index = 0; index < term.length - 1; index += 1) {
        terms.add(term.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function dynamicToolScore(
  query: string,
  definition: {
    name: string;
    description: string;
    inputSchema: object;
  },
): number {
  const request = originalRequest(query).normalize('NFKC').toLocaleLowerCase('en-US');
  const searchable = [
    definition.name,
    definition.description,
    JSON.stringify(definition.inputSchema),
  ]
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
  let score = request.includes(definition.name.toLocaleLowerCase('en-US')) ? 1_000 : 0;
  for (const term of lexicalTerms(request)) {
    if (searchable.includes(term)) {
      score += term.length >= 4 ? 4 : 1;
    }
  }
  return score;
}

function dynamicToolSourceKey(name: string): string {
  if (!name.startsWith('mcp__') && !name.startsWith('plugin__')) {
    return name;
  }
  const firstSeparator = name.indexOf('__');
  const secondSeparator = name.indexOf('__', firstSeparator + 2);
  return secondSeparator < 0 ? name : name.slice(0, secondSeparator);
}

function appendUnique(target: string[], names: readonly string[]): void {
  for (const name of names) {
    if (!target.includes(name)) target.push(name);
  }
}

function includeWritePrerequisites(
  selected: readonly string[],
  executableNames: ReadonlySet<string>,
  limit: number,
): readonly string[] {
  const result: string[] = [];
  for (const name of selected) {
    const required = WRITE_PREREQUISITE_READS[name] ?? [];
    if (required.some((candidate) => !executableNames.has(candidate))) {
      continue;
    }
    const prerequisites = required.filter((candidate) => !result.includes(candidate));
    if (result.length + prerequisites.length + 1 > limit) {
      // Never expose a freshness-guarded write without the read that can mint
      // its expectedRevision. A later iteration can retrieve the pair.
      continue;
    }
    result.push(...prerequisites);
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

/**
 * Bind Drifting's canonical catalog and product vocabulary to the
 * provider-neutral runtime selection seam.
 *
 * Runtime-only result paging is intentionally absent from the lexical index.
 * It is admitted only when recent work proves that a paged result is relevant,
 * and still consumes one slot from the same hard limit.
 */
export function createDriftingToolSelectionStrategy(
  options: CreateDriftingToolSelectionOptions = {},
): AgentToolSelectionStrategy {
  const catalog = options.catalog ?? AGENT_TOOL_CATALOG;
  const catalogNames = new Set(catalog.map((tool) => tool.name));
  const selector = createToolSelector({
    catalog,
    policy: options.policy ?? DRIFTING_RUNTIME_TOOL_SEARCH_POLICY,
    searchMetadata: options.searchMetadata ?? DRIFTING_TOOL_SEARCH_METADATA,
    defaultLimit: 8,
  });
  const explicitlyPinnableNames = new Set([
    ...selector.eligibleTools.map((tool) => tool.name),
    ASK_USER_TOOL,
    RESULT_PAGE_TOOL,
    ...LONG_TASK_TOOLS,
    LONG_TASK_CONSTRAINT_TOOL,
  ]);

  const strategy: AgentToolSelectionStrategy = {
    select(request): readonly string[] {
      const executableNames = new Set(request.definitions.map((definition) => definition.name));
      const accessByName = new Map(
        request.definitions.map((definition) => [definition.name, definition.access]),
      );
      const durableLongTask = request.hints.longTask;
      const activeLongTask = durableLongTask?.status === 'active';
      const activeWholeBookTask =
        activeLongTask && durableLongTask.scopeKind === 'whole_book_chapters';
      const rankingQuery = activeLongTask
        ? [
            request.query,
            `durable task objective:\n${durableLongTask.objective}`,
            durableLongTask.nextStep
              ? `next durable step:\n${durableLongTask.nextStep.title}\nwork kind: ${durableLongTask.nextStep.workKind ?? durableLongTask.workKind ?? 'edit'}\ntarget: ${durableLongTask.nextStep.target?.kind ?? 'none'} ${durableLongTask.nextStep.target?.name ?? ''}`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : request.query;
      if (explicitlyRequestsForeignProject(request.query, request.context.route.projectId)) {
        return [];
      }
      if (executableNames.has(RESULT_PAGE_TOOL) && request.pendingResultPage) {
        return request.limit > 0 ? [RESULT_PAGE_TOOL] : [];
      }
      const previousBatchRedundantReads = redundantDirectoryReads(
        request.successfulReadNamesInPreviousBatch,
      );
      const previousBatchSuccessfulReads = new Set(request.successfulReadNamesInPreviousBatch);
      const lookupRecovery = failedLookupRecovery(
        request.query,
        previousBatchSuccessfulReads.size > 0,
      );
      const pinnableExecutableNames = new Set(
        [...executableNames].filter((name) => explicitlyPinnableNames.has(name)),
      );
      const explicitlyNamedTools = explicitlyNamedExecutableTools(
        request.query,
        pinnableExecutableNames,
      ).filter(
        (name) =>
          !lookupRecovery.failedTools.has(name) &&
          (accessByName.get(name) === 'write' || !previousBatchSuccessfulReads.has(name)),
      );
      const explicitlyNegatedTools = explicitlyNegatedExecutableTools(
        request.query,
        pinnableExecutableNames,
      );
      const requestedNarrowReads = explicitNarrowReads(request.query);
      const narrowOnly = requestedNarrowReads.length > 0 && !needsMoreThanNarrowRead(request.query);
      const narrowReads = requestedNarrowReads.filter(
        (name) => executableNames.has(name) && !previousBatchSuccessfulReads.has(name),
      );
      const accumulatedCatalogReads = redundantDirectoryReads(
        request.successfulReadNamesSinceLastWrite,
      );
      const catalogReads = explicitCatalogReads(request.query);
      const catalogOnly = catalogReads.length > 0 && !needsMoreThanCatalogReads(request.query);
      const catalogCoverage = catalogOnly ? accumulatedCatalogReads : previousBatchRedundantReads;
      const pinnedCatalogReads = catalogReads.filter(
        (name) => executableNames.has(name) && !catalogCoverage.has(name),
      );
      const requestedLongTaskTools =
        activeLongTask || needsLongTaskLedger(request.query)
          ? needsLongTaskConstraintTool(rankingQuery)
            ? [...LONG_TASK_TOOLS, LONG_TASK_CONSTRAINT_TOOL]
            : [...LONG_TASK_TOOLS]
          : [];
      const longTaskTools = requestedLongTaskTools.filter((name) => executableNames.has(name));
      const longTaskProseTools =
        activeWholeBookTask || needsLongTaskProseMutation(rankingQuery)
          ? LONG_TASK_PROSE_TOOLS.filter((name) => executableNames.has(name))
          : [];
      const dynamicDefinitions = request.definitions
        .filter(
          (definition) =>
            (definition.name.startsWith('mcp__') || definition.name.startsWith('plugin__')) &&
            !catalogNames.has(definition.name) &&
            !LONG_TASK_TOOLS.includes(definition.name as (typeof LONG_TASK_TOOLS)[number]) &&
            definition.name !== LONG_TASK_CONSTRAINT_TOOL,
        )
        .map((definition) => ({
          definition,
          score: dynamicToolScore(
            activeLongTask
              ? `${originalRequest(request.query)}\n${durableLongTask.objective}\n${durableLongTask.nextStep?.title ?? ''}`
              : request.query,
            definition,
          ),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.definition.name.localeCompare(right.definition.name, 'en'),
        );

      // Preserve the intentionally tiny surface for a genuinely self-contained
      // directory read. Long-task and runtime-discovered intent make the same
      // request compound, so those candidates are merged rather than hidden by
      // this optimization.
      if (
        narrowOnly &&
        lookupRecovery.reads.length === 0 &&
        explicitlyNamedTools.length === 0 &&
        longTaskTools.length === 0 &&
        dynamicDefinitions.length === 0
      ) {
        return narrowReads.slice(0, request.limit);
      }
      if (
        catalogOnly &&
        lookupRecovery.reads.length === 0 &&
        explicitlyNamedTools.length === 0 &&
        longTaskTools.length === 0 &&
        dynamicDefinitions.length === 0
      ) {
        return pinnedCatalogReads.slice(0, request.limit);
      }

      const builtInCandidates: string[] = [];
      appendUnique(builtInCandidates, explicitlyNamedTools);
      if (request.limit > 0 && executableNames.has(ASK_USER_TOOL)) {
        builtInCandidates.push(ASK_USER_TOOL);
      }
      appendUnique(builtInCandidates, narrowReads);
      appendUnique(builtInCandidates, pinnedCatalogReads);
      appendUnique(
        builtInCandidates,
        lookupRecovery.reads.filter((name) => executableNames.has(name)),
      );
      appendUnique(builtInCandidates, longTaskTools);
      appendUnique(builtInCandidates, longTaskProseTools);
      for (const tool of selector.select(rankingQuery, request.limit)) {
        if (
          !executableNames.has(tool.name) ||
          lookupRecovery.failedTools.has(tool.name) ||
          explicitlyNegatedTools.has(tool.name) ||
          builtInCandidates.includes(tool.name) ||
          previousBatchRedundantReads.has(tool.name) ||
          (catalogOnly && accumulatedCatalogReads.has(tool.name))
        ) {
          continue;
        }
        builtInCandidates.push(tool.name);
      }

      const reservedBuiltInSlots = Math.min(
        MIN_BUILT_IN_TOOL_SLOTS,
        builtInCandidates.length,
        request.limit,
      );
      const dynamicBudget = Math.min(
        MAX_DYNAMIC_TOOLS,
        Math.max(0, request.limit - reservedBuiltInSlots),
      );
      const selectedDynamicTools: string[] = [];
      const selectedDynamicSources = new Set<string>();
      for (const { definition } of dynamicDefinitions) {
        if (selectedDynamicTools.length >= dynamicBudget) break;
        const sourceKey = dynamicToolSourceKey(definition.name);
        if (selectedDynamicSources.has(sourceKey)) continue;
        selectedDynamicSources.add(sourceKey);
        selectedDynamicTools.push(definition.name);
      }

      const recoverySafeBuiltInCandidates = builtInCandidates.filter(
        (name) =>
          !lookupRecovery.failedTools.has(name) &&
          !(WRITE_PREREQUISITE_READS[name] ?? []).some((prerequisite) =>
            lookupRecovery.failedTools.has(prerequisite),
          ),
      );
      const selectedBuiltIns = includeWritePrerequisites(
        recoverySafeBuiltInCandidates,
        executableNames,
        Math.max(0, request.limit - selectedDynamicTools.length),
      );
      return [...selectedBuiltIns, ...selectedDynamicTools];
    },
  };
  return Object.freeze(strategy);
}
