import {
  AGENT_TOOL_CATALOG,
  type AgentProviderToolPolicy,
  type RegisteredTool,
} from '../tool-registry';
import { DRIFTING_TOOL_SEARCH_METADATA } from './tool-search-metadata';
import { createToolSelector, type ToolSearchMetadataByName } from './tool-selector';
import type { AgentToolSelectionStrategy } from './types';

const RESULT_PAGE_TOOL = 'read_tool_result';
const ASK_USER_TOOL = 'ask_user';
const OVERVIEW_TOOL = 'get_overview';

const REDUNDANT_DIRECTORY_READS_AFTER_SUCCESS: Readonly<
  Record<string, readonly string[] | undefined>
> = Object.freeze({
  get_overview: Object.freeze([
    OVERVIEW_TOOL,
    'get_project_brief',
    'list_nodes',
    'list_elements',
  ]),
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
    (match) =>
      match[1]?.normalize('NFKC').toLocaleLowerCase('en-US') !== currentId,
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
  const request = withoutNegatedForeignProjectClauses(
    originalRequest(query).normalize('NFKC'),
  );
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
    /(?:离开|切换离开|切换出).{0,8}(?:当前|本)(?:项目|小说|书)/iu.test(
      request,
    ) ||
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
  if (
    /(?:项目|本书|作品).{0,8}(?:设定纲要|基础设定)|project brief|book premise/iu.test(
      request,
    )
  ) {
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
    /\bread (?:the )?material\s+(?!(?:list|library)\b)\S+/iu.test(
      request,
    )
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

function redundantDirectoryReads(
  successfulReadNames: readonly string[],
): ReadonlySet<string> {
  const redundant = new Set<string>();
  for (const successfulRead of successfulReadNames) {
    for (const name of REDUNDANT_DIRECTORY_READS_AFTER_SUCCESS[successfulRead] ?? []) {
      redundant.add(name);
    }
  }
  return redundant;
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
  const selector = createToolSelector({
    catalog: options.catalog ?? AGENT_TOOL_CATALOG,
    policy: options.policy ?? DRIFTING_RUNTIME_TOOL_SEARCH_POLICY,
    searchMetadata: options.searchMetadata ?? DRIFTING_TOOL_SEARCH_METADATA,
    defaultLimit: 8,
  });

  const strategy: AgentToolSelectionStrategy = {
    select(request): readonly string[] {
      const executableNames = new Set(request.definitions.map((definition) => definition.name));
      if (
        explicitlyRequestsForeignProject(
          request.query,
          request.context.route.projectId,
        )
      ) {
        return [];
      }
      if (
        executableNames.has(RESULT_PAGE_TOOL) &&
        request.pendingResultPage
      ) {
        return request.limit > 0 ? [RESULT_PAGE_TOOL] : [];
      }
      const previousBatchRedundantReads = redundantDirectoryReads(
        request.successfulReadNamesInPreviousBatch,
      );
      const previousBatchSuccessfulReads = new Set(
        request.successfulReadNamesInPreviousBatch,
      );
      const requestedNarrowReads = needsMoreThanNarrowRead(request.query)
        ? []
        : explicitNarrowReads(request.query);
      const narrowReads = requestedNarrowReads.filter(
        (name) =>
          executableNames.has(name) &&
          !previousBatchSuccessfulReads.has(name),
      );
      if (requestedNarrowReads.length > 0) {
        return narrowReads.slice(0, request.limit);
      }
      const accumulatedCatalogReads = redundantDirectoryReads(
        request.successfulReadNamesSinceLastWrite,
      );
      const catalogReads = explicitCatalogReads(request.query);
      if (catalogReads.length > 0 && !needsMoreThanCatalogReads(request.query)) {
        return catalogReads
          .filter(
            (name) =>
              executableNames.has(name) && !accumulatedCatalogReads.has(name),
          )
          .slice(0, request.limit);
      }
      const selected: string[] = [];
      if (request.limit > 0 && executableNames.has(ASK_USER_TOOL)) {
        selected.push(ASK_USER_TOOL);
      }
      for (const tool of selector.select(request.query, request.limit)) {
        if (selected.length >= request.limit) break;
        if (
          !executableNames.has(tool.name) ||
          selected.includes(tool.name) ||
          previousBatchRedundantReads.has(tool.name)
        ) {
          continue;
        }
        selected.push(tool.name);
      }
      return selected;
    },
  };
  return Object.freeze(strategy);
}
