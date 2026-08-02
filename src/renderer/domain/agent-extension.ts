import type { AgentPermissionScope } from '../lib/agent/protocol';

export type AgentMcpTransportKind = 'stdio' | 'streamable_http';
export type AgentMcpHealthStatus =
  | 'disabled'
  | 'connecting'
  | 'healthy'
  | 'degraded'
  | 'failed';

export interface AgentMcpToolPolicy {
  access: 'read' | 'write';
  approval: 'automatic' | 'ask' | 'deny';
}

export interface AgentMcpServerConfig {
  id: string;
  projectId: string;
  name: string;
  transport: AgentMcpTransportKind;
  enabled: boolean;
  command: string | null;
  args: string[];
  cwd: string | null;
  publicEnv: Record<string, string>;
  /** Environment variable -> native keychain id. */
  secretEnv: Record<string, string>;
  url: string | null;
  publicHeaders: Record<string, string>;
  /** Header name -> native keychain id. */
  secretHeaders: Record<string, string>;
  toolPolicy: Record<string, AgentMcpToolPolicy>;
  configRevision: string;
  healthStatus: AgentMcpHealthStatus;
  healthMessage: string;
  serverInfo: Record<string, unknown>;
  discoveredTools: Array<{
    name: string;
    description: string;
    inputSchema: object;
    annotations?: Record<string, unknown>;
  }>;
  lastCheckedAt: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentMcpServerDraft = Omit<
  AgentMcpServerConfig,
  | 'configRevision'
  | 'healthStatus'
  | 'healthMessage'
  | 'serverInfo'
  | 'discoveredTools'
  | 'lastCheckedAt'
  | 'lastConnectedAt'
  | 'createdAt'
  | 'updatedAt'
>;

export type AgentPermissionGrantScope = Exclude<AgentPermissionScope, 'once'>;
export type AgentPermissionGrantStatus = 'active' | 'revoked';

export interface AgentPermissionGrant {
  id: string;
  projectId: string;
  sessionId: string | null;
  scope: AgentPermissionGrantScope;
  sourceKind: 'mcp' | 'plugin';
  sourceId: string;
  providerToolName: string;
  remoteToolName: string;
  access: 'read' | 'write';
  argumentsHash: string;
  toolDefinitionRevision: string;
  sourceConfigRevision: string;
  status: AgentPermissionGrantStatus;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface AgentPermissionGrantMatch {
  projectId: string;
  sessionId: string;
  sourceKind: 'mcp' | 'plugin';
  sourceId: string;
  providerToolName: string;
  remoteToolName: string;
  access: 'read' | 'write';
  argumentsHash: string;
  toolDefinitionRevision: string;
  sourceConfigRevision: string;
}

export function normalizeAgentMcpServerDraft(
  value: AgentMcpServerDraft,
): AgentMcpServerDraft {
  const id = bounded(value.id, 'server id', 200);
  const projectId = bounded(value.projectId, 'project id', 200);
  const name = bounded(value.name, 'server name', 120);
  if (value.transport !== 'stdio' && value.transport !== 'streamable_http') {
    throw new Error('Unsupported MCP transport');
  }
  const args = stringArray(value.args, 'MCP args', 64, 2_000);
  const publicEnv = stringMap(value.publicEnv, 'MCP public env', 64, 200, 8_000);
  const secretEnv = stringMap(value.secretEnv, 'MCP secret env refs', 64, 200, 300);
  const publicHeaders = stringMap(
    value.publicHeaders,
    'MCP public headers',
    64,
    200,
    8_000,
  );
  const secretHeaders = stringMap(
    value.secretHeaders,
    'MCP secret header refs',
    64,
    200,
    300,
  );
  const toolPolicy = normalizeToolPolicy(value.toolPolicy);
  if (value.transport === 'stdio') {
    const command = bounded(value.command, 'MCP command', 2_000);
    if (!isAbsoluteNativePath(command)) {
      throw new Error('MCP stdio command must be an absolute executable path');
    }
    const cwd = value.cwd ? bounded(value.cwd, 'MCP cwd', 2_000) : null;
    if (cwd && !isAbsoluteNativePath(cwd)) {
      throw new Error('MCP stdio cwd must be an absolute path');
    }
    return {
      id,
      projectId,
      name,
      transport: 'stdio',
      enabled: value.enabled === true,
      command,
      args,
      cwd,
      publicEnv,
      secretEnv,
      url: null,
      publicHeaders: {},
      secretHeaders: {},
      toolPolicy,
    };
  }
  const url = normalizeMcpHttpUrl(value.url);
  return {
    id,
    projectId,
    name,
    transport: 'streamable_http',
    enabled: value.enabled === true,
    command: null,
    args: [],
    cwd: null,
    publicEnv: {},
    secretEnv: {},
    url,
    publicHeaders,
    secretHeaders,
    toolPolicy,
  };
}

export async function hashAgentMcpServerConfig(
  draft: AgentMcpServerDraft,
): Promise<string> {
  const normalized = normalizeAgentMcpServerDraft(draft);
  const canonical = canonicalJson(normalized);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable for MCP configuration');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function defaultAgentMcpToolPolicy(): AgentMcpToolPolicy {
  // Unknown external tools are treated as writes and always pause. MCP
  // annotations may inform the UI but never lower this local classification.
  return { access: 'write', approval: 'ask' };
}

function normalizeMcpHttpUrl(value: string | null): string {
  const raw = bounded(value, 'MCP URL', 2_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MCP URL is invalid');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('MCP URL cannot contain credentials or a fragment');
  }
  const local =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('MCP HTTP requires HTTPS, except for loopback development servers');
  }
  return url.toString();
}

function normalizeToolPolicy(
  value: Record<string, AgentMcpToolPolicy>,
): Record<string, AgentMcpToolPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP tool policy must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error('MCP tool policy exceeds 256 entries');
  return Object.fromEntries(
    entries.map(([name, policy]) => {
      const normalizedName = bounded(name, 'MCP tool policy name', 300);
      if (
        !policy ||
        (policy.access !== 'read' && policy.access !== 'write') ||
        !['automatic', 'ask', 'deny'].includes(policy.approval) ||
        (policy.access === 'write' && policy.approval === 'automatic')
      ) {
        throw new Error(`MCP tool policy "${normalizedName}" is invalid`);
      }
      return [normalizedName, { access: policy.access, approval: policy.approval }];
    }),
  );
}

function stringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`);
  return value.map((item) => bounded(item, label, maxLength));
}

function stringMap(
  value: unknown,
  label: string,
  maxItems: number,
  maxKey: number,
  maxValue: number,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxItems) throw new Error(`${label} exceeds ${maxItems} entries`);
  return Object.fromEntries(
    entries.map(([key, item]) => [bounded(key, label, maxKey), bounded(item, label, maxValue)]),
  );
}

function bounded(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  if (value.includes('\u0000') || value.includes('\r') || value.includes('\n')) {
    throw new Error(`${label} contains a control character`);
  }
  return value.trim();
}

function isAbsoluteNativePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MCP config contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('MCP config is not portable JSON');
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
