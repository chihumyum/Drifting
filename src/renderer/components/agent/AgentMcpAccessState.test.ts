import { describe, expect, it } from 'vitest';
import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';
import { mcpAccessGrant, mcpAccessPermission, mcpAccessRows } from './AgentMcpAccessState';

function connection(id: string, client?: McpClient, projectId?: string): McpServerConnection {
  return {
    grant: {
      id, name: id, access: 'write', allowDangerous: true,
      ...(projectId ? { projectId } : {}),
      ...(client ? { installation: { client, configPath: 'synthetic-config', serverName: id } } : {}),
    },
    config: { command: 'synthetic-app', args: ['--mcp', '--connection', id] },
  };
}

describe('MCP client access rows', () => {
  it('offers each known client once when nothing is connected', () => {
    const rows = mcpAccessRows([]);
    expect(rows.clients.map(row => [row.client, row.name, row.connection])).toEqual([
      ['codex', 'Codex', undefined], ['claude_code', 'Claude Code', undefined],
      ['antigravity', 'Antigravity', undefined],
    ]);
    expect(rows.manual).toEqual([]);
  });

  it('fills each client row with its connection to every book, not one made for a single book', () => {
    const bookCodex = connection('book-codex', 'codex', 'project-a');
    const bookAntigravity = connection('book-antigravity', 'antigravity', 'project-b');
    const codex = connection('codex', 'codex');
    const claude = connection('claude', 'claude_code');
    claude.grant.access = 'read';
    claude.grant.allowDangerous = false;
    const antigravity = connection('antigravity', 'antigravity');
    antigravity.grant.allowDangerous = false;
    const rows = mcpAccessRows([bookCodex, bookAntigravity, codex, claude, antigravity]);
    expect(rows.clients.map(row => row.connection)).toEqual([codex, claude, antigravity]);
    expect(rows.clients.map(row => mcpAccessPermission(row.connection!))).toEqual(['full', 'read', 'write']);
    // Book connections an earlier version made stay revocable below.
    expect(rows.manual).toEqual([bookCodex, bookAntigravity]);
  });

  it('keeps manual and unexpected duplicate grants available for configuration or revocation', () => {
    const first = connection('first', 'codex');
    const duplicate = connection('duplicate', 'codex');
    const manual = connection('manual');
    const rows = mcpAccessRows([first, duplicate, manual]);
    expect(rows.clients[0].connection).toBe(first);
    expect(rows.manual).toEqual([duplicate, manual]);
  });

  it.each([
    ['read', 'read', false], ['write', 'write', false], ['full', 'write', true],
  ] as const)('round-trips %s permission without elevating other grants', (permission, access, allowDangerous) => {
    expect(mcpAccessGrant(permission)).toEqual({ access, allowDangerous });
    const row = connection('selected');
    Object.assign(row.grant, mcpAccessGrant(permission));
    expect(mcpAccessPermission(row)).toBe(permission);
  });
});
