import {
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
} from './long-task-tool-runtime';
import { isBroadAutonomousProjectCampaign } from './long-task-intent';
import type {
  AgentToolDefinition,
  AgentToolSelectionRequest,
  AgentToolSelectionStrategy,
} from './types';

const WORKSPACE_CORE = ['list_files', 'read_file', 'grep'] as const;
const WORKSPACE_EDIT = 'edit_file';
const WORKSPACE_WRITE = 'write_file';
const WORKSPACE_DELETE = 'delete_file';
const ASK_USER = 'ask_user';
const RESULT_PAGE = 'read_tool_result';
const MAX_VISIBLE_TOOLS = 8;

/**
 * Product selector for the filesystem-like workspace facade.
 *
 * The broad domain catalog remains installed for certification, reviews, and
 * rare explicit operations, but ordinary writing turns see four familiar
 * workspace verbs instead of a database-shaped menu of entities and receipts.
 */
export function createDriftingWorkspaceToolSelectionStrategy(): AgentToolSelectionStrategy {
  return {
    select(request): readonly string[] {
      const available = new Map(
        request.definitions.map((definition) => [definition.name, definition]),
      );
      const limit = Math.min(request.limit, MAX_VISIBLE_TOOLS);
      if (limit <= 0) return [];
      if (request.pendingResultPage && available.has(RESULT_PAGE)) {
        return [RESULT_PAGE];
      }

      const query = intentQuery(request);
      const activeTask = request.hints.longTask?.status === 'active';
      const offerPlan = looksLikeLongTask(query);
      const createIntent = mentionsCreate(query);
      const wholeFileWriteIntent = mentionsWholeFileWrite(query);
      const deleteIntent = mentionsDelete(query);
      const directTarget = hasDirectAuthoredTarget(query, request);
      const needsDiscovery = !directTarget || createIntent || directTargetResolutionFailed(request.query);
      const directAuthoredEdit =
        directTarget &&
        !createIntent &&
        !activeTask &&
        !directTargetResolutionFailed(request.query);
      const result: string[] = [];

      if (activeTask) {
        append(result, available, AGENT_LONG_TASK_READ_TOOL, limit);
        // The active-task surface must retain the task-level mutation tool as
        // well as the step tool. Without it the model can advance individual
        // steps but cannot extend/reconcile/complete the durable plan, so a
        // successful long task is forced to end in an internally-active state.
        append(result, available, AGENT_LONG_TASK_PLAN_TOOL, limit);
        append(result, available, AGENT_LONG_TASK_STEP_TOOL, limit);
        if (needsDiscovery) append(result, available, 'list_files', limit);
        append(result, available, 'read_file', limit);
        if (deleteIntent) append(result, available, WORKSPACE_DELETE, limit);
        // Keep the ordinary workspace verbs stable throughout an active task.
        // A later step may discover that it needs a new summary/resource or a
        // focused correction even when those verbs were absent from the
        // original wording.
        append(result, available, WORKSPACE_WRITE, limit);
        if (!deleteIntent) append(result, available, 'grep', limit);
        append(result, available, WORKSPACE_EDIT, limit);
        if (deleteIntent) append(result, available, 'grep', limit);
        return result;
      }

      // A durable plan is valuable continuity state, but it must not become a
      // prerequisite that hides ordinary workspace writes. Providers may
      // ignore or mishandle a plan tool; the Agent can still make progress and
      // the runtime can continue a planless turn across context boundaries.
      if (offerPlan) {
        append(result, available, AGENT_LONG_TASK_PLAN_TOOL, limit);
        if (mentionsExplicitConstraint(query)) {
          append(result, available, AGENT_LONG_TASK_CONSTRAINT_TOOL, limit);
        }
      }

      // A named chapter/entity edit is the dominant writing path. Keep its
      // surface deliberately small so a model cannot fall back into project
      // archaeology, global search, or resource deletion while polishing one
      // authored object. This is relevance routing, not a mutation scope: a
      // later request can expose any project operation it actually needs.
      if (directAuthoredEdit && !mentionsElementPatch(query)) {
        append(result, available, 'read_file', limit);
        if (!explicitlyReadOnly(query)) {
          append(result, available, WORKSPACE_WRITE, limit);
          if (mentionsResourceDelete(query)) {
            append(result, available, WORKSPACE_DELETE, limit);
          }
          append(result, available, WORKSPACE_EDIT, limit);
        }
        if (mentionsSearch(query)) append(result, available, 'grep', limit);
        append(result, available, ASK_USER, limit);
        return result;
      }

      if (needsDiscovery) append(result, available, 'list_files', limit);
      append(result, available, 'read_file', limit);
      const patchIntent = mentionsElementPatch(query);
      const commentIntent = mentionsComment(query);
      const readOnly = explicitlyReadOnly(query);
      const ordinaryWorkspaceMutation = !readOnly && !patchIntent;
      // Keep both file mutation verbs stable for an ordinary edit. After
      // reading a document, providers commonly choose a whole-file write even
      // when the author only said “改一下内容”; hiding write_file in that later
      // iteration turns a valid model action into UNKNOWN_TOOL.
      if (
        !readOnly &&
        (createIntent || wholeFileWriteIntent || commentIntent || ordinaryWorkspaceMutation)
      ) {
        append(result, available, WORKSPACE_WRITE, limit);
      }
      // Keep the complete filesystem mutation surface available throughout an
      // ordinary executable turn. A vague continuation can discover obsolete
      // resources only after reading; hiding delete_file based solely on the
      // original wording makes that newly discovered work impossible.
      if (ordinaryWorkspaceMutation) {
        append(result, available, WORKSPACE_DELETE, limit);
      }
      append(result, available, 'grep', limit);
      // Keep the ordinary workspace capability stable, like Claude Code's
      // always-available Edit tool. Inferring whether prose is writable from
      // natural-language verbs is brittle: “insert this, but change nothing
      // else” used to be misclassified as a read-only request.
      if (ordinaryWorkspaceMutation) {
        append(result, available, WORKSPACE_EDIT, limit);
      }

      // Rare domain concepts are recalled only when the author explicitly asks
      // for them. Their certified prerequisite read travels with the write.
      if (patchIntent) {
        append(result, available, 'get_element_patches', limit);
        append(
          result,
          available,
          deleteIntent
            ? 'delete_element_patch'
            : createIntent
              ? 'create_element_patch'
              : mentionsUpdate(query)
                ? 'update_element_patch'
                : 'create_element_patch',
          limit,
        );
      }

      for (const definition of relevantDynamicTools(query, request.definitions)) {
        append(result, available, definition.name, limit);
      }
      append(result, available, ASK_USER, limit);
      return result;
    },
  };
}

function hasDirectAuthoredTarget(query: string, request: AgentToolSelectionRequest): boolean {
  if (request.hints.longTask?.nextStep?.target?.name) return true;
  return /(?:第\s*)?[零〇一二两三四五六七八九十百千0-9]+\s*章|\/chapters\/[^\s/]+|(?:章节|灵感|漂移|人物|角色|地点|组织|要素|故事线)[「“"'][^」”"']+[」”"']/iu.test(
    query,
  );
}

function directTargetResolutionFailed(searchQuery: string): boolean {
  const recentWork = searchQuery.indexOf('\nrecent work:\n');
  if (recentWork < 0) return false;
  const recent = searchQuery.slice(recentWork);
  if (/STALE_EDIT_TARGET|text to replace was not found/iu.test(recent)) return false;
  return /not found|No virtual directory exists|ambiguous|moved or was deleted|不存在|未找到|无法解析|有多个同名/iu.test(
    recent,
  );
}

function intentQuery(request: AgentToolSelectionRequest): string {
  const task = request.hints.longTask;
  return [
    originalRequestFromSearchQuery(request.query),
    task?.objective ?? '',
    task?.nextStep?.title ?? '',
    task?.nextStep?.workKind ?? task?.workKind ?? '',
    task?.nextStep?.target?.name ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

function originalRequestFromSearchQuery(query: string): string {
  const withoutLabel = query.startsWith('original request:\n')
    ? query.slice('original request:\n'.length)
    : query;
  const recentWork = withoutLabel.indexOf('\nrecent work:\n');
  return recentWork >= 0 ? withoutLabel.slice(0, recentWork) : withoutLabel;
}

function looksLikeLongTask(query: string): boolean {
  if (
    /整本|全书|所有章节|每(?:一|个)章节|逐章|从头到尾|长任务|整部|whole\s+book|all\s+chapters|every\s+chapter|chapter\s+by\s+chapter/i.test(
      query,
    )
  ) {
    return true;
  }

  const chapterRangeSize = explicitChapterRangeSize(query);
  if (chapterRangeSize !== null && chapterRangeSize >= 6) {
    return true;
  }

  if (isBroadAutonomousProjectCampaign(query)) {
    return true;
  }

  // Real authors often describe a campaign as a sequence of outcomes instead
  // of naming its size: “整理完，该删的删、该补的补，再续写并自检”. That is
  // exactly the work that needs durable continuation state across compaction.
  // Exposing the plan is only an affordance; it never limits what the model may
  // read or write through the ordinary workspace tools.
  const campaignActions =
    query.match(
      /彻底整理|整理(?:完|好|顺)|删掉|删除|清理|补齐|补全|完善|新建|创建|关联|调整关系|修改|改写|续写|往后写|写到|自检|检查|核对|验证|clean\s*up|delete|remove|fill\s+in|complete|create|relate|edit|rewrite|continue\s+writing|self[-\s]?check|verify/gi,
    ) ?? [];
  if (
    campaignActions.length >= 3 &&
    /该.{0,20}该.{0,24}(?:再|然后)|(?:再|然后).{0,30}(?:自己|自我)?(?:检查|核对|验证)|没做完.{0,12}(?:继续|别停)|直到.{0,16}(?:完成|做完)|彻底.{0,40}(?:删|补|写|改)|(?:then|afterwards).{0,40}(?:check|verify)|(?:keep\s+going|continue).{0,24}(?:until|unfinished|done)/i.test(
      query,
    )
  ) {
    return true;
  }

  // Authors rarely describe a long edit as “a long task”. Requests such as
  // “收拾开头几章，做完再从头检查” are multi-resource campaigns even though
  // they neither name every target nor say “全书”. Detect the broad chapter
  // range itself; the durable plan then records the concrete targets after the
  // model has listed the workspace.
  return /(?:开头|前面|前部|前期|后面|后部|后期|中间|中部|最近|现有)?\s*(?:几|多|若干|数|好几)(?:个)?\s*章|(?:开头|前面|前部|后面|后部|中间).{0,8}(?:章节|正文)|(?:multiple|several|a\s+few|opening|early|later)\s+chapters?/i.test(
    query,
  );
}

function explicitChapterRangeSize(query: string): number | null {
  const match = /(?:第\s*)?([零〇一二两三四五六七八九十百千0-9]+)\s*章\s*(?:到|至|—|–|-|~|～)\s*(?:第\s*)?([零〇一二两三四五六七八九十百千0-9]+)\s*章/iu.exec(
    query,
  );
  if (!match) return null;
  const start = chapterOrdinal(match[1] ?? '');
  const end = chapterOrdinal(match[2] ?? '');
  return start === null || end === null ? null : Math.abs(end - start) + 1;
}

function chapterOrdinal(value: string): number | null {
  if (/^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const digit = new Map<string, number>([
    ['零', 0],
    ['〇', 0],
    ['一', 1],
    ['二', 2],
    ['两', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['七', 7],
    ['八', 8],
    ['九', 9],
  ]);
  if (![...value].some((character) => character === '十' || character === '百' || character === '千')) {
    const digits = [...value].map((character) => digit.get(character));
    if (digits.some((number) => number === undefined)) return null;
    const parsed = Number(digits.join(''));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  let total = 0;
  let current = 0;
  for (const character of value) {
    const number = digit.get(character);
    if (number !== undefined) {
      current = number;
      continue;
    }
    const unit = units[character];
    if (!unit) return null;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}

function explicitlyReadOnly(query: string): boolean {
  return /只读|仅(?:阅读|分析|查看)|(?:不要|别|无需|不需要|禁止|请勿)(?:修改|编辑|改写|写入|变更|删除)(?:任何|全部|所有)?(?:内容|文件|正文|章节|东西)|(?:do\s+not|don't|without)\s+(?:edit|modify|change|write|delete)\s+(?:anything|any\s+(?:content|file|text))|read[-\s]?only/i.test(
    query,
  );
}

function mentionsExplicitConstraint(query: string): boolean {
  return /必须|不要|不得|保持|要求|约束|文风|人称|字数|禁忌|must|never|constraint|style|voice|pov/i.test(
    query,
  );
}

function mentionsElementPatch(query: string): boolean {
  return /元素补丁|角色演变|设定演变|canon\s+patch|element\s+patch/i.test(query);
}

function mentionsComment(query: string): boolean {
  return /批注|评论|待办|todo|comment/i.test(query);
}

function mentionsCreate(query: string): boolean {
  return /新建|创建|新增|添加|建立|写一(?:个|条|篇)|new\s+(?:chapter|drift|node|element|entity|storyline|category|comment|todo|relation)|create|add\s+(?:a\s+)?(?:comment|todo|relation)/i.test(
    withoutNegatedMutationClause(query, '新建|创建|新增|添加|建立|create|add|new'),
  );
}

function mentionsWholeFileWrite(query: string): boolean {
  return /\bwrite_file\b|完整内容|整(?:个)?文件|全文替换|whole[-\s]?file|replace\s+(?:the\s+)?(?:whole|entire)\s+(?:file|contents?)/i.test(
    query,
  );
}

function mentionsDelete(query: string): boolean {
  return /删除|移除|清除|清理|清掉|删掉|delete|remove|clean\s*up/i.test(
    withoutNegatedMutationClause(
      query,
      '删除|移除|清除|清理|清掉|删掉|delete|remove|clean\\s*up',
    ),
  );
}

function mentionsResourceDelete(query: string): boolean {
  const positive = withoutNegatedMutationClause(
    query,
    '删除|移除|清除|清理|清掉|删掉|delete|remove',
  );
  return /(?:删除|移除|删掉)(?:整个|整条|整项|这个|这条|该)?\s*(?:章节|灵感|漂移|要素|实体|故事线|分类|批注|待办|关系|作者规则)(?:[「“"']|$)|把\s*(?:章节|灵感|漂移|要素|实体|故事线|分类|批注|待办|关系|作者规则)[^，。；;\n]{0,30}(?:整个)?(?:删掉|删除|移除)|delete\s+(?:the\s+)?(?:chapter|drift|element|entity|storyline|category|comment|todo|relation|rule)\b|remove\s+(?:the\s+)?(?:chapter|drift|element|entity|storyline|category|comment|todo|relation|rule)\b/iu.test(
    positive,
  );
}

function mentionsSearch(query: string): boolean {
  return /搜索|查找|检索|全文搜|出现在哪|哪些地方|grep|search|find\s+(?:all|every|where|occurrences?)/iu.test(
    query,
  );
}

function mentionsUpdate(query: string): boolean {
  return /更新|修改|改成|改为|改动|变更|调整|追加|替换|重命名|补充|续写|edit|update|change|append|replace|rename/i.test(
    withoutNegatedMutationClause(
      query,
      '更新|修改|改成|改为|改动|变更|调整|追加|替换|重命名|补充|续写|edit|update|change|append|replace|rename',
    ),
  );
}

function withoutNegatedMutationClause(query: string, verbs: string): string {
  return query
    .replace(
      new RegExp(
        `(?:不要|别|不得|禁止|请勿|无需|不需要)\\s*(?:再)?(?:${verbs})[^\uff0c\u3002\uff1b;\\n]*`,
        'gi',
      ),
      '',
    )
    .replace(new RegExp(`(?:do\\s+not|don't|without)\\s+(?:${verbs})[^,.?;\\n]*`, 'gi'), '');
}

function append(
  result: string[],
  available: ReadonlyMap<string, AgentToolDefinition>,
  name: string,
  limit: number,
): void {
  if (result.length >= limit || result.includes(name) || !available.has(name)) return;
  result.push(name);
}

function relevantDynamicTools(
  query: string,
  definitions: readonly AgentToolDefinition[],
): AgentToolDefinition[] {
  const normalized = query.toLocaleLowerCase();
  return definitions
    .filter(
      (definition) => definition.name.startsWith('mcp__') || definition.name.startsWith('plugin__'),
    )
    .filter((definition) => {
      if (normalized.includes(definition.name.toLocaleLowerCase())) return true;
      const tokens = definition.name
        .replace(/^(mcp__|plugin__)/, '')
        .split(/[_\W]+/)
        .filter((token) => token.length >= 3);
      return tokens.some((token) => normalized.includes(token.toLocaleLowerCase()));
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

export const DRIFTING_WORKSPACE_CORE_TOOL_NAMES = WORKSPACE_CORE;
