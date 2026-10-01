import { describe, expect, it } from 'vitest';
import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';
import { mcpAccessGrant, mcpAccessPermission, mcpAccessRows } from './AgentMcpAccessState';

function connection(id: string, projectId: string, client?: McpClient): McpServerConnection {
  return {
    grant: {
      id, projectId, name: id, access: 'write', allowDangerous: true,
      ...(client ? { installation: { client, configPath: 'synthetic-config', serverName: id } } : {}),
    },
    config: { command: 'synthetic-app', args: ['--mcp', '--connection', id] },
  };
}

describe('MCP client access rows', () => {
  it('offers each known client once when the project has no connections', () => {
    const rows = mcpAccessRows([], 'project-a');
    expect(rows.clients.map(row => [row.client, row.name, row.connection])).toEqual([
      ['codex', 'Codex', undefined], ['claude_code', 'Claude Code', undefined],
      ['antigravity', 'Antigravity', undefined],
    ]);
    expect(rows.manual).toEqual([]);
  });

  it('keeps the actual grants in the same client rows without including another project', () => {
    const codex = connection('codex-a', 'project-a', 'codex');
    const claude = connection('claude-a', 'project-a', 'claude_code');
    claude.grant.access = 'read';
    claude.grant.allowDangerous = false;
    const antigravity = connection('antigravity-a', 'project-a', 'antigravity');
    antigravity.grant.allowDangerous = false;
    const rows = mcpAccessRows([
      connection('foreign', 'project-b', 'codex'),
      connection('foreign-antigravity', 'project-b', 'antigravity'),
      codex, claude, antigravity,
    ], 'project-a');
    expect(rows.clients.map(row => row.connection)).toEqual([codex, claude, antigravity]);
    expect(rows.clients.map(row => mcpAccessPermission(row.connection!))).toEqual(['full', 'read', 'write']);
    expect(rows.manual).toEqual([]);
  });

  it('keeps manual and unexpected duplicate grants available for configuration or revocation', () => {
    const first = connection('first', 'project-a', 'codex');
    const duplicate = connection('duplicate', 'project-a', 'codex');
    const manual = connection('manual', 'project-a');
    const rows = mcpAccessRows([first, duplicate, manual], 'project-a');
    expect(rows.clients[0].connection).toBe(first);
    expect(rows.manual).toEqual([duplicate, manual]);
  });

  it.each([
    ['read', 'read', false], ['write', 'write', false], ['full', 'write', true],
  ] as const)('round-trips %s permission without elevating other grants', (permission, access, allowDangerous) => {
    expect(mcpAccessGrant(permission)).toEqual({ access, allowDangerous });
    const row = connection('selected', 'project-a');
    Object.assign(row.grant, mcpAccessGrant(permission));
    expect(mcpAccessPermission(row)).toBe(permission);
  });
});
