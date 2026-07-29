import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_CATALOG,
  getRegisteredTool,
  type AgentProviderToolPolicy,
} from '../tool-registry';
import {
  createDriftingToolSelectionStrategy,
  DRIFTING_RUNTIME_TOOL_SEARCH_POLICY,
} from './drifting-tool-selection';
import type { AgentToolDefinition, AgentToolSelectionRequest } from './types';

function definitions(...names: string[]): AgentToolDefinition[] {
  return names.map((name) => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    access: getRegisteredTool(name)?.access === 'write' ? 'write' : 'read',
    validateInput: (value) => ({ ok: true, value }),
  }));
}

function request(query: string, names: string[]): AgentToolSelectionRequest {
  return {
    definitions: definitions(...names),
    context: { route: { kind: 'test', projectId: 'project-1' } },
    iteration: 1,
    query,
    limit: 8,
  };
}

const EXECUTABLE_NAMES = [
  ...AGENT_TOOL_CATALOG.filter(
    (tool) =>
      tool.scope === 'general' &&
      DRIFTING_RUNTIME_TOOL_SEARCH_POLICY.accesses.includes(tool.access) &&
      DRIFTING_RUNTIME_TOOL_SEARCH_POLICY.certifications.includes(tool.certification),
  ).map((tool) => tool.name),
  'read_tool_result',
];

describe('Drifting runtime tool selection', () => {
  it('retrieves product tools for Chinese and English requests', () => {
    const strategy = createDriftingToolSelectionStrategy();

    expect(strategy.select(request('读取这个章节的正文', EXECUTABLE_NAMES))).toContain('read_node');
    expect(strategy.select(request('rename a chapter title', EXECUTABLE_NAMES))).toContain(
      'rename_node',
    );
  });

  it('intersects retrieval with executable definitions', () => {
    const strategy = createDriftingToolSelectionStrategy();

    const selected = strategy.select(request('rename a chapter title', ['read_node']));

    expect(selected).not.toContain('rename_node');
    expect(selected.every((name) => name === 'read_node')).toBe(true);
  });

  it('never indexes internal, unavailable, or explicitly denied tools', () => {
    const policy: AgentProviderToolPolicy = {
      scopes: ['general', 'shadow-internal', 'runtime-virtual'],
      accesses: ['read', 'write'],
      certifications: ['unavailable', 'read-certified', 'write-certified', 'internal-certified'],
      denyNames: ['read_node'],
    };
    const strategy = createDriftingToolSelectionStrategy({ policy });
    const selected = strategy.select(
      request('shadow_commit_review delete_element read_node', [
        'shadow_commit_review',
        'delete_element',
        'read_node',
        'get_project_brief',
      ]),
    );

    expect(selected).not.toContain('shadow_commit_review');
    expect(selected).not.toContain('delete_element');
    expect(selected).not.toContain('read_node');
  });

  it('admits result paging only as a controlled pinned candidate within the same limit', () => {
    const strategy = createDriftingToolSelectionStrategy();

    const ordinary = strategy.select(request('read one chapter prose', EXECUTABLE_NAMES));
    const paged = strategy.select(
      request('recent result: {"truncated":true,"resultRef":"agent-result:1"}', EXECUTABLE_NAMES),
    );

    expect(ordinary).not.toContain('read_tool_result');
    expect(paged[0]).toBe('read_tool_result');
    expect(paged.length).toBeLessThanOrEqual(8);
    expect(new Set(paged).size).toBe(paged.length);
  });
});
