import { describe, expect, it } from 'vitest';

import {
  DRIFTING_DOMAIN_PROVIDER_TOOLS,
  DRIFTING_DOMAIN_READ_TOOLS,
} from './drifting-workspace-tool-contract';
import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import type { AgentToolDefinition, AgentToolSelectionRequest } from './types';

const readNames = new Set<string>(DRIFTING_DOMAIN_READ_TOOLS);
const definition = (name: string): AgentToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  access: readNames.has(name) || name === 'ask_user' || name.startsWith('read_')
    ? 'read'
    : 'write',
  validateInput: (value) => ({ ok: true, value }),
});

const definitions = [
  ...DRIFTING_DOMAIN_PROVIDER_TOOLS.map(definition),
  definition('ask_user'),
  definition('read_tool_result'),
  definition('read_task_plan'),
  definition('update_task_plan'),
  definition('update_task_step'),
  definition('update_task_constraint'),
  definition('mcp__notes__lookup'),
  definition('plugin__example__run'),
  definition('read_object'),
  definition('write_object'),
];

describe('Drifting domain tool selection', () => {
  it('keeps the complete domain surface available regardless of tool count', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(request());

    expect(selected.slice(0, DRIFTING_DOMAIN_PROVIDER_TOOLS.length)).toEqual(
      DRIFTING_DOMAIN_PROVIDER_TOOLS,
    );
    expect(selected).toHaveLength(DRIFTING_DOMAIN_PROVIDER_TOOLS.length + 8);
    expect(selected).toEqual(expect.arrayContaining([
      'ask_user',
      'read_task_plan',
      'update_task_plan',
      'update_task_step',
      'update_task_constraint',
      'mcp__notes__lookup',
      'plugin__example__run',
      'read_tool_result',
    ]));
  });

  it('pins the Working Memory checkpoint and conflict refresh when installed', () => {
    const input = request();
    input.definitions = [
      definition('read_working_memory'),
      definition('checkpoint_working_memory'),
      ...input.definitions,
    ];

    expect(createDriftingWorkspaceToolSelectionStrategy().select(input).slice(0, 2)).toEqual([
      'checkpoint_working_memory',
      'read_working_memory',
    ]);
  });

  it('never selects retired generic object tools even if a stale caller supplies them', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(request());
    expect(selected).not.toContain('read_object');
    expect(selected).not.toContain('write_object');
  });

  it('selects only the result pager while a paged result is pending', () => {
    const input = request();
    input.pendingResultPage = true;
    expect(createDriftingWorkspaceToolSelectionStrategy().select(input)).toEqual([
      'read_tool_result',
    ]);
  });

  it('honors an explicit runtime cap without changing domain order', () => {
    const input = request();
    input.limit = 12;
    expect(createDriftingWorkspaceToolSelectionStrategy().select(input)).toEqual(
      DRIFTING_DOMAIN_PROVIDER_TOOLS.slice(0, 12),
    );
  });

  it('does not force a generic or inferred tool', () => {
    const strategy = createDriftingWorkspaceToolSelectionStrategy();
    const input = request();
    expect(strategy.forceTool?.(input, strategy.select(input))).toBeNull();
  });
});

function request(): AgentToolSelectionRequest {
  return {
    definitions,
    context: { route: { kind: 'chat', projectId: 'project' } },
    iteration: 0,
    hints: {},
    query: '整理章节、要素与关系',
    successfulReadNamesInPreviousBatch: [],
    successfulReadNamesSinceLastWrite: [],
    pendingResultPage: false,
    repairToolNames: [],
    limit: 128,
  };
}
