/** Reserved identity used by MCP before conversations had an explicit source.
 * Also identifies old chat-sync branches received without local runtime rows.
 * Titles and credential modes are deliberately not used as origin evidence. */
export function isExternalMcpConversationIdentity(id: string): boolean {
  return id.startsWith('mcp:') && id.endsWith(':conversation');
}
