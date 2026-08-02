import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type {
  AgentMcpHealthStatus,
  AgentMcpServerConfig,
  AgentMcpServerDraft,
  AgentPermissionGrant,
  AgentPermissionGrantMatch,
  AgentPermissionGrantScope,
} from '../domain/agent-extension';
import {
  hashAgentMcpServerConfig,
  normalizeAgentMcpServerDraft,
} from '../domain/agent-extension';
import { getDb, type DbClient, type DbExecutor } from '../lib/db';
import {
  AgentMcpServerTable,
  AgentPermissionGrantTable,
} from '../schema/drizzle';

export interface AgentExtensionRepository {
  listServers(projectId: string): Promise<AgentMcpServerConfig[]>;
  getServer(projectId: string, serverId: string): Promise<AgentMcpServerConfig | null>;
  saveServer(draft: AgentMcpServerDraft): Promise<AgentMcpServerConfig>;
  deleteServer(projectId: string, serverId: string): Promise<boolean>;
  updateServerHealth(input: {
    projectId: string;
    serverId: string;
    status: AgentMcpHealthStatus;
    message?: string;
    serverInfo?: Record<string, unknown>;
    discoveredTools?: AgentMcpServerConfig['discoveredTools'];
    connected?: boolean;
    checkedAt: string;
  }): Promise<void>;
  findGrant(match: AgentPermissionGrantMatch): Promise<AgentPermissionGrant | null>;
  createGrant(input: AgentPermissionGrantMatch & {
    scope: AgentPermissionGrantScope;
    createdAt: string;
  }): Promise<AgentPermissionGrant>;
  listGrants(projectId: string): Promise<AgentPermissionGrant[]>;
  revokeGrant(projectId: string, grantId: string, reason: string): Promise<boolean>;
  revokeSourceGrants(
    projectId: string,
    sourceKind: 'mcp' | 'plugin',
    sourceId: string,
    reason: string,
  ): Promise<number>;
}

export function createAgentExtensionRepository(
  database?: DbClient,
): AgentExtensionRepository {
  const db = () => database ?? getDb();
  return {
    async listServers(projectId) {
      requireText(projectId, 'projectId');
      const rows = await db()
        .select()
        .from(AgentMcpServerTable)
        .where(eq(AgentMcpServerTable.projectId, projectId))
        .orderBy(AgentMcpServerTable.name);
      return rows.map(mapServer);
    },

    async getServer(projectId, serverId) {
      const rows = await db()
        .select()
        .from(AgentMcpServerTable)
        .where(
          and(
            eq(AgentMcpServerTable.projectId, requireText(projectId, 'projectId')),
            eq(AgentMcpServerTable.id, requireText(serverId, 'serverId')),
          ),
        )
        .limit(1);
      return rows[0] ? mapServer(rows[0]) : null;
    },

    async saveServer(draft) {
      const normalized = normalizeAgentMcpServerDraft(draft);
      const configRevision = await hashAgentMcpServerConfig(normalized);
      const now = new Date().toISOString();
      await db().transaction(async (tx) => {
        const current = await tx
          .select({
            configRevision: AgentMcpServerTable.configRevision,
            enabled: AgentMcpServerTable.enabled,
          })
          .from(AgentMcpServerTable)
          .where(
            and(
              eq(AgentMcpServerTable.id, normalized.id),
              eq(AgentMcpServerTable.projectId, normalized.projectId),
            ),
          )
          .limit(1);
        const row = {
          id: normalized.id,
          projectId: normalized.projectId,
          name: normalized.name,
          transport: normalized.transport,
          enabled: normalized.enabled,
          command: normalized.command,
          argsJson: JSON.stringify(normalized.args),
          cwd: normalized.cwd,
          publicEnvJson: JSON.stringify(normalized.publicEnv),
          secretEnvJson: JSON.stringify(normalized.secretEnv),
          url: normalized.url,
          publicHeadersJson: JSON.stringify(normalized.publicHeaders),
          secretHeadersJson: JSON.stringify(normalized.secretHeaders),
          toolPolicyJson: JSON.stringify(normalized.toolPolicy),
          configRevision,
          healthStatus: normalized.enabled ? ('connecting' as const) : ('disabled' as const),
          healthMessage: '',
          serverInfoJson: '{}',
          discoveredToolsJson: '[]',
          lastCheckedAt: null,
          lastConnectedAt: null,
          updatedAt: now,
        };
        if (current[0]) {
          await tx
            .update(AgentMcpServerTable)
            .set(row)
            .where(
              and(
                eq(AgentMcpServerTable.id, normalized.id),
                eq(AgentMcpServerTable.projectId, normalized.projectId),
              ),
            );
          if (
            current[0].configRevision !== configRevision ||
            (current[0].enabled && !normalized.enabled)
          ) {
            await revokeSourceGrantsWith(
              tx,
              normalized.projectId,
              'mcp',
              normalized.id,
              'MCP server configuration changed or was disabled',
              now,
            );
          }
        } else {
          await tx.insert(AgentMcpServerTable).values({
            ...row,
            createdAt: now,
          });
        }
      });
      const saved = await this.getServer(normalized.projectId, normalized.id);
      if (!saved) throw new Error('MCP server did not persist');
      return saved;
    },

    async deleteServer(projectId, serverId) {
      const now = new Date().toISOString();
      let existed = false;
      await db().transaction(async (tx) => {
        const rows = await tx
          .select({ id: AgentMcpServerTable.id })
          .from(AgentMcpServerTable)
          .where(
            and(
              eq(AgentMcpServerTable.projectId, requireText(projectId, 'projectId')),
              eq(AgentMcpServerTable.id, requireText(serverId, 'serverId')),
            ),
          )
          .limit(1);
        existed = rows.length > 0;
        if (!existed) return;
        await revokeSourceGrantsWith(
          tx,
          projectId,
          'mcp',
          serverId,
          'MCP server was deleted',
          now,
        );
        await tx
          .delete(AgentMcpServerTable)
          .where(
            and(
              eq(AgentMcpServerTable.projectId, projectId),
              eq(AgentMcpServerTable.id, serverId),
            ),
          );
      });
      return existed;
    },

    async updateServerHealth(input) {
      if (!['disabled', 'connecting', 'healthy', 'degraded', 'failed'].includes(input.status)) {
        throw new Error('Invalid MCP health status');
      }
      await db()
        .update(AgentMcpServerTable)
        .set({
          healthStatus: input.status,
          healthMessage: (input.message ?? '').slice(0, 500),
          ...(input.serverInfo
            ? { serverInfoJson: portableJson(input.serverInfo, 'serverInfo') }
            : {}),
          ...(input.discoveredTools
            ? { discoveredToolsJson: portableJson(input.discoveredTools, 'discoveredTools') }
            : {}),
          lastCheckedAt: input.checkedAt,
          ...(input.connected ? { lastConnectedAt: input.checkedAt } : {}),
          updatedAt: input.checkedAt,
        })
        .where(
          and(
            eq(AgentMcpServerTable.projectId, requireText(input.projectId, 'projectId')),
            eq(AgentMcpServerTable.id, requireText(input.serverId, 'serverId')),
          ),
        );
    },

    async findGrant(match) {
      validateGrantMatch(match);
      const rows = await db()
        .select()
        .from(AgentPermissionGrantTable)
        .where(
          and(
            eq(AgentPermissionGrantTable.projectId, match.projectId),
            eq(AgentPermissionGrantTable.sourceKind, match.sourceKind),
            eq(AgentPermissionGrantTable.sourceId, match.sourceId),
            eq(AgentPermissionGrantTable.providerToolName, match.providerToolName),
            eq(AgentPermissionGrantTable.remoteToolName, match.remoteToolName),
            eq(AgentPermissionGrantTable.access, match.access),
            eq(AgentPermissionGrantTable.argumentsHash, match.argumentsHash),
            eq(
              AgentPermissionGrantTable.toolDefinitionRevision,
              match.toolDefinitionRevision,
            ),
            eq(AgentPermissionGrantTable.sourceConfigRevision, match.sourceConfigRevision),
            eq(AgentPermissionGrantTable.status, 'active'),
            or(
              and(
                eq(AgentPermissionGrantTable.scope, 'session'),
                eq(AgentPermissionGrantTable.sessionId, match.sessionId),
              ),
              and(
                eq(AgentPermissionGrantTable.scope, 'project'),
                isNull(AgentPermissionGrantTable.sessionId),
              ),
            ),
          ),
        )
        .orderBy(desc(AgentPermissionGrantTable.scope), desc(AgentPermissionGrantTable.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const usedAt = new Date().toISOString();
      await db()
        .update(AgentPermissionGrantTable)
        .set({ lastUsedAt: usedAt })
        .where(
          and(
            eq(AgentPermissionGrantTable.id, row.id),
            eq(AgentPermissionGrantTable.status, 'active'),
          ),
        );
      return mapGrant({ ...row, lastUsedAt: usedAt });
    },

    async createGrant(input) {
      validateGrantMatch(input);
      if (input.scope !== 'session' && input.scope !== 'project') {
        throw new Error('Invalid durable permission scope');
      }
      const sessionId = input.scope === 'session' ? input.sessionId : null;
      const existing = await findExactGrant(db(), input, input.scope, sessionId);
      if (existing) return existing;
      const id = uuidv7();
      await db()
        .insert(AgentPermissionGrantTable)
        .values({
          id,
          projectId: input.projectId,
          sessionId,
          scope: input.scope,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          providerToolName: input.providerToolName,
          remoteToolName: input.remoteToolName,
          access: input.access,
          argumentsHash: input.argumentsHash,
          toolDefinitionRevision: input.toolDefinitionRevision,
          sourceConfigRevision: input.sourceConfigRevision,
          status: 'active',
          createdAt: input.createdAt,
          lastUsedAt: input.createdAt,
          revokedAt: null,
          revokedReason: null,
        })
        // Two approval resolutions can race. The partial unique index is the
        // authority; the exact read below adopts only the matching winner.
        .onConflictDoNothing();
      const created = await findExactGrant(db(), input, input.scope, sessionId);
      if (!created) throw new Error('Durable permission grant did not persist');
      return created;
    },

    async listGrants(projectId) {
      const rows = await db()
        .select()
        .from(AgentPermissionGrantTable)
        .where(eq(AgentPermissionGrantTable.projectId, requireText(projectId, 'projectId')))
        .orderBy(desc(AgentPermissionGrantTable.createdAt));
      return rows.map(mapGrant);
    },

    async revokeGrant(projectId, grantId, reason) {
      const current = await db()
        .select({ id: AgentPermissionGrantTable.id })
        .from(AgentPermissionGrantTable)
        .where(
          and(
            eq(AgentPermissionGrantTable.projectId, requireText(projectId, 'projectId')),
            eq(AgentPermissionGrantTable.id, requireText(grantId, 'grantId')),
            eq(AgentPermissionGrantTable.status, 'active'),
          ),
        )
        .limit(1);
      if (!current[0]) return false;
      await db()
        .update(AgentPermissionGrantTable)
        .set({
          status: 'revoked',
          revokedAt: new Date().toISOString(),
          revokedReason: requireText(reason, 'reason').slice(0, 500),
        })
        .where(eq(AgentPermissionGrantTable.id, grantId));
      return true;
    },

    async revokeSourceGrants(projectId, sourceKind, sourceId, reason) {
      return revokeSourceGrantsWith(
        db(),
        requireText(projectId, 'projectId'),
        sourceKind,
        requireText(sourceId, 'sourceId'),
        requireText(reason, 'reason'),
        new Date().toISOString(),
      );
    },
  };
}

async function revokeSourceGrantsWith(
  executor: DbExecutor,
  projectId: string,
  sourceKind: 'mcp' | 'plugin',
  sourceId: string,
  reason: string,
  now: string,
): Promise<number> {
  const active = await executor
    .select({ id: AgentPermissionGrantTable.id })
    .from(AgentPermissionGrantTable)
    .where(
      and(
        eq(AgentPermissionGrantTable.projectId, projectId),
        eq(AgentPermissionGrantTable.sourceKind, sourceKind),
        eq(AgentPermissionGrantTable.sourceId, sourceId),
        eq(AgentPermissionGrantTable.status, 'active'),
      ),
    );
  if (!active.length) return 0;
  await executor
    .update(AgentPermissionGrantTable)
    .set({
      status: 'revoked',
      revokedAt: now,
      revokedReason: reason.slice(0, 500),
    })
    .where(
      and(
        eq(AgentPermissionGrantTable.projectId, projectId),
        eq(AgentPermissionGrantTable.sourceKind, sourceKind),
        eq(AgentPermissionGrantTable.sourceId, sourceId),
        eq(AgentPermissionGrantTable.status, 'active'),
      ),
    );
  return active.length;
}

async function findExactGrant(
  executor: DbExecutor,
  input: AgentPermissionGrantMatch,
  scope: AgentPermissionGrantScope,
  sessionId: string | null,
): Promise<AgentPermissionGrant | null> {
  const rows = await executor
    .select()
    .from(AgentPermissionGrantTable)
    .where(
      and(
        eq(AgentPermissionGrantTable.projectId, input.projectId),
        scope === 'session'
          ? eq(AgentPermissionGrantTable.sessionId, sessionId!)
          : isNull(AgentPermissionGrantTable.sessionId),
        eq(AgentPermissionGrantTable.scope, scope),
        eq(AgentPermissionGrantTable.sourceKind, input.sourceKind),
        eq(AgentPermissionGrantTable.sourceId, input.sourceId),
        eq(AgentPermissionGrantTable.providerToolName, input.providerToolName),
        eq(AgentPermissionGrantTable.remoteToolName, input.remoteToolName),
        eq(AgentPermissionGrantTable.access, input.access),
        eq(AgentPermissionGrantTable.argumentsHash, input.argumentsHash),
        eq(AgentPermissionGrantTable.toolDefinitionRevision, input.toolDefinitionRevision),
        eq(AgentPermissionGrantTable.sourceConfigRevision, input.sourceConfigRevision),
        eq(AgentPermissionGrantTable.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0] ? mapGrant(rows[0]) : null;
}

function mapServer(row: typeof AgentMcpServerTable.$inferSelect): AgentMcpServerConfig {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    transport: row.transport as AgentMcpServerConfig['transport'],
    enabled: row.enabled,
    command: row.command,
    args: parseJson(row.argsJson, 'args'),
    cwd: row.cwd,
    publicEnv: parseJson(row.publicEnvJson, 'publicEnv'),
    secretEnv: parseJson(row.secretEnvJson, 'secretEnv'),
    url: row.url,
    publicHeaders: parseJson(row.publicHeadersJson, 'publicHeaders'),
    secretHeaders: parseJson(row.secretHeadersJson, 'secretHeaders'),
    toolPolicy: parseJson(row.toolPolicyJson, 'toolPolicy'),
    configRevision: row.configRevision,
    healthStatus: row.healthStatus as AgentMcpHealthStatus,
    healthMessage: row.healthMessage,
    serverInfo: parseJson(row.serverInfoJson, 'serverInfo'),
    discoveredTools: parseJson(row.discoveredToolsJson, 'discoveredTools'),
    lastCheckedAt: row.lastCheckedAt,
    lastConnectedAt: row.lastConnectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapGrant(row: typeof AgentPermissionGrantTable.$inferSelect): AgentPermissionGrant {
  return {
    ...row,
    scope: row.scope as AgentPermissionGrantScope,
    sourceKind: row.sourceKind as AgentPermissionGrant['sourceKind'],
    access: row.access as AgentPermissionGrant['access'],
    status: row.status as AgentPermissionGrant['status'],
  };
}

function validateGrantMatch(value: AgentPermissionGrantMatch): void {
  for (const [label, field] of Object.entries(value)) {
    if (label === 'access' || label === 'sourceKind') continue;
    requireText(field, label);
  }
  if (value.access !== 'read' && value.access !== 'write') throw new Error('Invalid grant access');
  if (value.sourceKind !== 'mcp' && value.sourceKind !== 'plugin') {
    throw new Error('Invalid grant source kind');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.argumentsHash)) {
    throw new Error('Invalid grant arguments hash');
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Persisted MCP ${label} is invalid`);
  }
}

function portableJson(value: unknown, label: string): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error(`MCP ${label} is not portable JSON`);
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}
