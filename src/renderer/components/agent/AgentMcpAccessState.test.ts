import { describe, expect, it } from 'vitest';
import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';
import { mcpAccessRows } from './AgentMcpAccessState';

function connection(id: string, client?: McpClient, projectId?: string): McpServerConnection {
  return {
    grant: {
      id, name: id,
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
    const antigravity = connection('antigravity', 'antigravity');
    const rows = mcpAccessRows([bookCodex, bookAntigravity, codex, claude, antigravity]);
    expect(rows.clients.map(row => row.connection)).toEqual([codex, claude, antigravity]);
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
});
