import {
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
} from './long-task-tool-runtime';
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
const MAX_VISIBLE_TOOLS = 6;

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
      const needsPlan = activeTask || looksLikeLongTask(query);
      const createIntent = mentionsCreate(query);
      const wholeFileWriteIntent = mentionsWholeFileWrite(query);
      const deleteIntent = mentionsDelete(query);
      const result: string[] = [];

      if (activeTask) {
        append(result, available, AGENT_LONG_TASK_READ_TOOL, limit);
        append(result, available, AGENT_LONG_TASK_STEP_TOOL, limit);
        append(result, available, 'list_files', limit);
        append(result, available, 'read_file', limit);
        if (deleteIntent) append(result, available, WORKSPACE_DELETE, limit);
        if (createIntent || wholeFileWriteIntent) {
          append(result, available, WORKSPACE_WRITE, limit);
        }
        append(result, available, WORKSPACE_EDIT, limit);
        return result;
      }

      if (needsPlan) {
        append(result, available, AGENT_LONG_TASK_PLAN_TOOL, limit);
        if (mentionsExplicitConstraint(query)) {
          append(result, available, AGENT_LONG_TASK_CONSTRAINT_TOOL, limit);
        }
        append(result, available, 'list_files', limit);
        append(result, available, 'read_file', limit);
        append(result, available, 'grep', limit);
        return result;
      }

      append(result, available, 'list_files', limit);
      append(result, available, 'read_file', limit);
      const patchIntent = mentionsElementPatch(query);
      const commentIntent = mentionsComment(query);
      const ordinaryWorkspaceMutation =
        !explicitlyReadOnly(query) && !patchIntent && !commentIntent;
      // Keep both file mutation verbs stable for an ordinary edit. After
      // reading a document, providers commonly choose a whole-file write even
      // when the author only said “改一下内容”; hiding write_file in that later
      // iteration turns a valid model action into UNKNOWN_TOOL.
      if (
        createIntent ||
        wholeFileWriteIntent ||
        commentIntent ||
        ordinaryWorkspaceMutation
      ) {
        append(result, available, WORKSPACE_WRITE, limit);
      }
      if (deleteIntent) append(result, available, WORKSPACE_DELETE, limit);
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
              : /更新|修改|edit|update/i.test(query)
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

function intentQuery(request: AgentToolSelectionRequest): string {
  const task = request.hints.longTask;
  return [
    originalRequestFromSearchQuery(request.query),
    task?.objective ?? '',
    task?.nextStep?.title ?? '',
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
  return /整本|全书|所有章节|每(?:一|个)章节|逐章|从头到尾|长任务|整部|whole\s+book|all\s+chapters|every\s+chapter|chapter\s+by\s+chapter/i.test(
    query,
  );
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
    query,
  );
}

function mentionsWholeFileWrite(query: string): boolean {
  return /\bwrite_file\b|完整内容|整(?:个)?文件|全文替换|whole[-\s]?file|replace\s+(?:the\s+)?(?:whole|entire)\s+(?:file|contents?)/i.test(
    query,
  );
}

function mentionsDelete(query: string): boolean {
  return /删除|移除|清除|删掉|delete|remove/i.test(query);
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
