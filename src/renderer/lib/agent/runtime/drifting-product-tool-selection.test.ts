import { describe, expect, it } from 'vitest';

import { getRegisteredTool } from '../tool-registry';
import {
  createDriftingProductToolSelectionStrategy,
  DRIFTING_PRODUCT_DYNAMIC_TOOL_SELECTION_LIMIT,
} from './drifting-product-tool-selection';
import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import {
  DRIFTING_DOMAIN_PROVIDER_TOOLS,
  DRIFTING_DOMAIN_READ_TOOLS,
} from './drifting-workspace-tool-contract';
import {
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
} from './long-task-tool-runtime';
import {
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';
import type {
  AgentRuntimeToolSearchMode,
  AgentToolDefinition,
  AgentToolSelectionRequest,
} from './types';

const domainReadNames = new Set<string>(DRIFTING_DOMAIN_READ_TOOLS);

function definition(name: string): AgentToolDefinition {
  const registered = getRegisteredTool(name);
  return {
    name,
    description: registered?.description ?? name,
    inputSchema: (registered?.parametersSchema as object) ?? { type: 'object' },
    access:
      registered?.access ??
      (domainReadNames.has(name) || name.startsWith('read_') || name.startsWith('list_')
        ? 'read'
        : 'write'),
    validateInput: (value) => ({ ok: true, value }),
  };
}

/** The exact provider-facing built-in surface of the shipped composition. */
const PRODUCT_SURFACE = [
  ...DRIFTING_DOMAIN_PROVIDER_TOOLS,
  'ask_user',
  'read_tool_result',
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
];

type SelectionState = Partial<
  Pick<
    AgentToolSelectionRequest,
    | 'successfulReadNamesInPreviousBatch'
    | 'successfulReadNamesSinceLastWrite'
    | 'pendingResultPage'
    | 'hints'
    | 'limit'
  >
>;

function request(
  query: string,
  names: readonly string[] = PRODUCT_SURFACE,
  state: SelectionState = {},
): AgentToolSelectionRequest {
  return {
    definitions: names.map(definition),
    context: { route: { kind: 'chat', projectId: 'project-1' } },
    iteration: 1,
    hints: state.hints ?? {},
    query,
    successfulReadNamesInPreviousBatch: state.successfulReadNamesInPreviousBatch ?? [],
    successfulReadNamesSinceLastWrite: state.successfulReadNamesSinceLastWrite ?? [],
    pendingResultPage: state.pendingResultPage ?? false,
    repairToolNames: [],
    limit: state.limit ?? 128,
  };
}

function strategy(mode: AgentRuntimeToolSearchMode | (() => AgentRuntimeToolSearchMode)) {
  return createDriftingProductToolSelectionStrategy({
    mode: typeof mode === 'function' ? mode : () => mode,
  });
}

describe('Drifting product tool selection', () => {
  it('exposes the complete conservative surface when the author turns search off', () => {
    const input = request('把第三章的开头改写得更有悬念');
    expect(strategy('off').select(input)).toEqual(
      createDriftingWorkspaceToolSelectionStrategy().select(input),
    );
  });

  it('bounds the surface and pins Working Memory lifecycle tools in auto mode', () => {
    const selected = strategy('auto').select(request('把第三章的开头改写得更有悬念'));

    expect(selected.length).toBeLessThanOrEqual(
      DRIFTING_PRODUCT_DYNAMIC_TOOL_SELECTION_LIMIT + 2,
    );
    expect(selected.slice(0, 2)).toEqual([
      AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
      AGENT_WORKING_MEMORY_READ_TOOL,
    ]);
    expect(selected).toContain('revise_chapter');
    expect(selected).toContain('read_chapter');
  });

  it('keeps every id-dependent write paired with the read that mints its arguments', () => {
    const selected = strategy('on').select(
      request('调用 revise_chapter 修改第一章，再用 update_element_patch 更新补丁'),
    );

    expect(selected).toContain('revise_chapter');
    expect(selected.indexOf('read_chapter')).toBeGreaterThanOrEqual(0);
    expect(selected.indexOf('read_chapter')).toBeLessThan(selected.indexOf('revise_chapter'));
    expect(selected.indexOf('get_element_patches')).toBeGreaterThanOrEqual(0);
    expect(selected.indexOf('get_element_patches')).toBeLessThan(
      selected.indexOf('update_element_patch'),
    );
  });

  it('retrieves author-domain tools for plain bilingual requests', () => {
    const bounded = strategy('on');

    expect(bounded.select(request('列出全部章节'))).toContain('list_chapters');
    expect(bounded.select(request('介绍这本小说的整体设定'))).toContain('get_project_overview');
    expect(bounded.select(request('polish the opening paragraph of chapter one'))).toContain(
      'revise_chapter',
    );
    expect(
      bounded.select(request('角色「林澈」在哪些章节出场？')),
    ).toContain('find_element_appearances');
  });

  it('selects only the result pager while a paged result is pending', () => {
    const selected = strategy('on').select(
      request('继续', PRODUCT_SURFACE, { pendingResultPage: true }),
    );
    expect(selected).toEqual(['read_tool_result']);
  });

  it('keeps the foreign-project refusal surface empty without lifecycle pins', () => {
    const selected = strategy('on').select(
      request('读取另一个项目 project-other 的概览并总结'),
    );
    expect(selected).toEqual([]);
  });

  it('falls back to the complete surface in auto mode at or below the runtime threshold', () => {
    const smallSurface = ['read_chapter', 'revise_chapter', 'ask_user', 'read_tool_result'];
    const input = request('随便聊聊', smallSurface);
    expect(strategy('auto').select(input)).toEqual(
      createDriftingWorkspaceToolSelectionStrategy().select(input),
    );
    expect(strategy('on').select(input).length).toBeLessThanOrEqual(
      DRIFTING_PRODUCT_DYNAMIC_TOOL_SELECTION_LIMIT + 2,
    );
  });

  it('fails safe to bounded auto selection when the live preference is invalid', () => {
    const selected = strategy(() => 'legacy' as AgentRuntimeToolSearchMode).select(
      request('把第三章的开头改写得更有悬念'),
    );
    expect(selected.length).toBeLessThanOrEqual(
      DRIFTING_PRODUCT_DYNAMIC_TOOL_SELECTION_LIMIT + 2,
    );
    expect(selected.length).toBeGreaterThan(0);
  });

  it('honors a small runtime limit without duplicates in every mode', () => {
    for (const mode of ['off', 'auto', 'on'] as const) {
      const selected = strategy(mode).select(
        request('把第三章的开头改写得更有悬念', PRODUCT_SURFACE, { limit: 3 }),
      );
      expect(selected.length).toBeLessThanOrEqual(3);
      expect(new Set(selected).size).toBe(selected.length);
    }
  });

  it('pins the durable ledger and the domain prose pair for an active whole-book task', () => {
    const selected = strategy('on').select(
      request('继续', PRODUCT_SURFACE, {
        hints: {
          longTask: {
            status: 'active',
            scopeKind: 'whole_book_chapters',
            workKind: 'edit',
            objective: '润色整本书的正文',
            nextStep: {
              title: '润色第二章',
              workKind: 'edit',
              status: 'in_progress',
              target: { kind: 'chapter', name: '第二章' },
            },
          },
        },
      }),
    );

    expect(selected).toEqual(
      expect.arrayContaining([
        AGENT_LONG_TASK_READ_TOOL,
        AGENT_LONG_TASK_PLAN_TOOL,
        AGENT_LONG_TASK_STEP_TOOL,
        'read_chapter',
        'revise_chapter',
      ]),
    );
  });

  it('never forces a tool', () => {
    const bounded = strategy('on');
    const input = request('把第三章的开头改写得更有悬念');
    expect(bounded.forceTool?.(input, bounded.select(input))).toBeNull();
  });
});
