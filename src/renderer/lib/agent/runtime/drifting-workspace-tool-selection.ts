import {
  DRIFTING_DOMAIN_PROVIDER_TOOLS,
} from './drifting-workspace-tool-contract';
import type {
  AgentToolDefinition,
  AgentToolSelectionStrategy,
} from './types';

const RESULT_PAGE = 'read_tool_result';

/**
 * Drifting deliberately keeps the complete domain tool surface available.
 * Tool count is not compressed into generic object verbs: every built-in
 * operation keeps one stable author-domain name and schema.
 */
export function createDriftingWorkspaceToolSelectionStrategy(): AgentToolSelectionStrategy {
  return {
    select(request): readonly string[] {
      const available = new Map(
        request.definitions.map((definition) => [definition.name, definition]),
      );
      if (request.pendingResultPage && available.has(RESULT_PAGE)) {
        return [RESULT_PAGE];
      }

      const selected: string[] = [];
      // Working Memory is an always-on turn lifecycle boundary. Keep its
      // checkpoint and conflict-refresh read available even when tool search
      // narrows the much larger authored-domain catalog.
      append(selected, available, 'checkpoint_working_memory', request.limit);
      append(selected, available, 'read_working_memory', request.limit);
      for (const name of DRIFTING_DOMAIN_PROVIDER_TOOLS) {
        append(selected, available, name, request.limit);
      }
      for (const definition of request.definitions) {
        if (
          definition.name === 'ask_user' ||
          definition.name === 'read_tool_result' ||
          definition.name.startsWith('read_task_') ||
          definition.name.startsWith('update_task_') ||
          definition.name.startsWith('mcp__') ||
          definition.name.startsWith('plugin__')
        ) {
          append(selected, available, definition.name, request.limit);
        }
      }
      return selected;
    },
    forceTool(): null {
      return null;
    },
  };
}

function append(
  selected: string[],
  available: ReadonlyMap<string, AgentToolDefinition>,
  name: string,
  limit: number,
): void {
  if (selected.length >= limit || selected.includes(name) || !available.has(name)) return;
  selected.push(name);
}

export const DRIFTING_WORKSPACE_CORE_TOOL_NAMES = DRIFTING_DOMAIN_PROVIDER_TOOLS;
