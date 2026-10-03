import { describe, expect, it } from 'vitest';
import { createDriftingProductToolSelectionStrategy } from './drifting-product-tool-selection';
import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import { DRIFTING_DOMAIN_PROVIDER_TOOLS } from './drifting-workspace-tool-contract';
import type { AgentToolSelectionRequest } from './types';

describe('General Agent full-schema fallback', () => {
  it('preserves every domain tool regardless of vague continuation or pending pages', () => {
    const strategy = createDriftingProductToolSelectionStrategy();
    const request: AgentToolSelectionRequest = {
      definitions: [...DRIFTING_DOMAIN_PROVIDER_TOOLS, 'read_tool_result'].map((name) => ({
        name, description: name, inputSchema: {}, access: 'read',
        validateInput: (value) => ({ ok: true, value }),
      })),
      context: { route: { kind: 'test' } }, iteration: 1, hints: {}, query: '继续改',
      successfulReadNamesInPreviousBatch: [], successfulReadNamesSinceLastWrite: [],
      pendingResultPage: true, repairToolNames: [], limit: 128,
    };
    expect(strategy.select(request)).toEqual(createDriftingWorkspaceToolSelectionStrategy().select(request));
    expect(strategy.select(request)).toEqual(expect.arrayContaining(['read_element', 'update_element', 'revise_element', 'read_tool_result']));
    expect(strategy.select({ ...request, query: '我觉得应该有工具。' })).toEqual(strategy.select(request));
    expect(strategy.forceTool?.(request, strategy.select(request))).toBeNull();
  });
});
