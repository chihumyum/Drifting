import {
  AGENT_TOOL_CATALOG,
  type AgentProviderToolPolicy,
  type RegisteredTool,
} from '../tool-registry';
import { DRIFTING_TOOL_SEARCH_METADATA } from './tool-search-metadata';
import { createToolSelector, type ToolSearchMetadataByName } from './tool-selector';
import type { AgentToolSelectionStrategy } from './types';

const RESULT_PAGE_TOOL = 'read_tool_result';

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

function requestsResultPage(query: string): boolean {
  const normalized = query.normalize('NFKC').toLocaleLowerCase('en-US');
  return (
    normalized.includes(RESULT_PAGE_TOOL) ||
    normalized.includes('resultref') ||
    /truncated\s*["']?\s*[:=]\s*true/u.test(normalized) ||
    /tool result.{0,24}truncat/u.test(normalized) ||
    /工具结果.{0,12}(截断|继续读取)/u.test(normalized) ||
    /结果被截断/u.test(normalized)
  );
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
      const selected: string[] = [];
      if (
        request.limit > 0 &&
        executableNames.has(RESULT_PAGE_TOOL) &&
        requestsResultPage(request.query)
      ) {
        selected.push(RESULT_PAGE_TOOL);
      }
      for (const tool of selector.select(request.query, request.limit)) {
        if (selected.length >= request.limit) break;
        if (!executableNames.has(tool.name) || selected.includes(tool.name)) {
          continue;
        }
        selected.push(tool.name);
      }
      return selected;
    },
  };
  return Object.freeze(strategy);
}
