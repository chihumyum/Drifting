import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';

export type McpAccessPermission = 'read' | 'write' | 'full';

export const mcpClientNames: Record<McpClient, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  antigravity: 'Antigravity',
};

export function mcpAccessPermission(connection: McpServerConnection): McpAccessPermission {
  return connection.grant.allowDangerous ? 'full' : connection.grant.access;
}

export function mcpAccessGrant(permission: McpAccessPermission) {
  return {
    access: permission === 'read' ? 'read' as const : 'write' as const,
    allowDangerous: permission === 'full',
  };
}

/** One row per client for its connection to every book. Manual connections,
 *  unexpected duplicates and connections an earlier version made for a single
 *  book stay listed below, so they can still be configured or revoked. */
export function mcpAccessRows(connections: McpServerConnection[]) {
  const remaining = new Map(connections.map(connection => [connection.grant.id, connection]));
  const clients = (['codex', 'claude_code', 'antigravity'] as const).map((client: McpClient) => {
    const connection = [...remaining.values()].find(row =>
      row.grant.installation?.client === client && row.grant.projectId === undefined);
    if (connection) remaining.delete(connection.grant.id);
    return { client, name: mcpClientNames[client], connection };
  });
  // Keep all other grants manageable, including unexpected duplicate installs.
  return { clients, manual: [...remaining.values()] };
}
