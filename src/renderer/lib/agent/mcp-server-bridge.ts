import { platform } from '../../platform';
import type { McpServerEvent } from '../../platform/mcp-server-contract';
import { getDb } from '../db';
import { AgentConversationTable } from '../../schema/drizzle';
import { getDriftingAgentProductComposition } from './useDriftingAgentRuntime';
import { ExternalToolSession } from './runtime/external-tool-session';

/** Installed only while the authorized project runtime is fully mounted. */
export async function installMcpServerBridge(projectId: string): Promise<() => void> {
  const sessions = new Map<string, ExternalToolSession>();
  const requests = new Map<string, { controller: AbortController; sessionId: string }>();
  let disposed = false;
  const closeSession = (id: string) => {
    for (const request of requests.values())
      if (request.sessionId === id) request.controller.abort();
    const session = sessions.get(id);
    sessions.delete(id);
    void session?.close().catch(() => undefined);
  };
  const handle = async (event: McpServerEvent) => {
    if (event.type === 'grantChanged') {
      for (const session of sessions.values()) {
        if (session.connectionId === event.grant.id) session.updateGrant(event.grant);
      }
      return;
    }
    if (event.type === 'cancel') {
      requests.get(event.requestId)?.controller.abort();
      return;
    }
    if (event.type === 'closed') {
      closeSession(event.sessionId);
      return;
    }
    const response = { jsonrpc: '2.0', id: event.request.id };
    const controller = new AbortController();
    requests.set(event.requestId, { controller, sessionId: event.sessionId });
    try {
      if (disposed || event.grant.projectId !== projectId)
        throw new Error('Authorized project is not open');
      let session = sessions.get(event.sessionId);
      if (!session) {
        // A native session outlives a remount of this bridge (project switch,
        // renderer reload), and the previous mount already closed its durable
        // session. Scope durable ids to this attachment so they never collide;
        // the native attach told clients to read again before writing.
        const sessionId = `${event.sessionId}:${event.epoch.slice(0, 16)}`;
        session = new ExternalToolSession({
          sessionId,
          grant: event.grant,
          composition: getDriftingAgentProductComposition(),
          ensureConversation: async (id, grant) => {
            const at = new Date().toISOString();
            await getDb()
              .insert(AgentConversationTable)
              .values({
                id,
                projectId,
                title: `MCP · ${grant.name}`,
                source: 'external_mcp',
                sdkSessionId: null,
                runtimeSessionId: sessionId,
                mode: 'byok',
                messagesJson: '[]',
                deletedAt: null,
                createdAt: at,
                updatedAt: at,
              })
              // Idempotent so an initialization retried after a later step
              // failed does not collide with its own row.
              .onConflictDoNothing();
          },
        });
        sessions.set(event.sessionId, session);
      }
      session.updateGrant(event.grant);
      const result = await session.handle(event.request, controller.signal);
      await platform.mcpServer.complete(event.epoch, event.requestId, { ...response, result });
    } catch (error) {
      await platform.mcpServer.complete(event.epoch, event.requestId, {
        ...response,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'MCP request failed',
        },
      });
    } finally {
      requests.delete(event.requestId);
    }
  };
  const epoch = await platform.mcpServer.attach(projectId, (event) => {
    void handle(event).catch((error) => console.warn('[mcp] request delivery failed', error));
  });
  return () => {
    disposed = true;
    for (const id of sessions.keys()) closeSession(id);
    void platform.mcpServer.detach(epoch).catch(() => undefined);
  };
}
