import type {
  AgentMcpServerConfig,
  AgentMcpToolPolicy,
} from '../../../domain/agent-extension';
import { defaultAgentMcpToolPolicy } from '../../../domain/agent-extension';
import type { McpHttpPlatformApi, McpStdioPlatformApi } from '../../../platform';
import type { AgentExtensionRepository } from '../../../sqlite-repo/agent-extension-repo';
import { DynamicAgentToolRegistry, type DynamicAgentToolSourceHandle } from './dynamic-tool-runtime';
import { connectAgentMcpClient, type ConnectedAgentMcpClient } from './mcp-client';
import { registerAgentMcpToolSource, type AgentMcpToolDescriptor } from './mcp-tool-source';
import {
  createHttpAgentMcpTransport,
  createStdioAgentMcpTransport,
  type AgentMcpJsonRpcTransport,
  AgentMcpTransportError,
} from './mcp-transport';

export interface AgentExtensionManagerStatus {
  projectId: string;
  serverId: string;
  configRevision: string;
  status: 'connecting' | 'healthy' | 'degraded' | 'failed';
  attempt: number;
  message: string;
}

export interface AgentExtensionManagerOptions {
  repository: AgentExtensionRepository;
  registry: DynamicAgentToolRegistry;
  stdioPlatform: McpStdioPlatformApi;
  httpPlatform?: McpHttpPlatformApi;
  readSecret(keychainId: string): Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => Date;
  retryDelaysMs?: readonly number[];
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  createProcessId?: () => string;
}

interface ActiveServer {
  config: AgentMcpServerConfig;
  controller: AbortController;
  transport: AgentMcpJsonRpcTransport | null;
  client: ConnectedAgentMcpClient | null;
  source: DynamicAgentToolSourceHandle | null;
  task: Promise<void>;
}

/**
 * Project-scoped MCP lifecycle owner.
 *
 * A server/config generation owns exactly one transport, client and dynamic
 * source. Replacement aborts and unregisters the old generation before any
 * new schema can become model-visible. Handshake retries are safe; tool calls
 * are never replayed by this manager.
 */
export class AgentExtensionManager {
  private readonly active = new Map<string, ActiveServer>();
  private readonly listeners = new Set<() => void>();
  private readonly statuses = new Map<string, AgentExtensionManagerStatus>();
  private projectId = '';
  private generation = 0;
  private processCounter = 0;

  constructor(private readonly options: AgentExtensionManagerOptions) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): readonly AgentExtensionManagerStatus[] {
    return [...this.statuses.values()].sort((left, right) =>
      left.serverId.localeCompare(right.serverId, 'en'),
    );
  }

  async activateProject(projectId: string): Promise<void> {
    requireId(projectId, 'projectId');
    if (this.projectId !== projectId) await this.deactivateProject();
    this.projectId = projectId;
    const generation = ++this.generation;
    const servers = await this.options.repository.listServers(projectId);
    if (generation !== this.generation || this.projectId !== projectId) return;
    const configuredIds = new Set(servers.map((server) => server.id));
    for (const [serverId, active] of this.active) {
      if (
        !configuredIds.has(serverId) ||
        !active.config.enabled ||
        active.config.configRevision !==
          servers.find((server) => server.id === serverId)?.configRevision
      ) {
        await this.stopActive(active);
        this.active.delete(serverId);
      }
    }
    const pending: Promise<void>[] = [];
    for (const server of servers) {
      if (!server.enabled) {
        this.statuses.delete(statusKey(server.projectId, server.id));
        continue;
      }
      const current = this.active.get(server.id);
      if (current?.config.configRevision === server.configRevision) continue;
      pending.push(this.startServer(server));
    }
    await Promise.all(pending);
    this.emit();
  }

  async reconnect(projectId: string, serverId: string): Promise<void> {
    requireId(projectId, 'projectId');
    requireId(serverId, 'serverId');
    if (this.projectId !== projectId) this.projectId = projectId;
    const current = this.active.get(serverId);
    if (current) {
      await this.stopActive(current);
      this.active.delete(serverId);
    }
    const server = await this.options.repository.getServer(projectId, serverId);
    if (!server?.enabled) {
      this.statuses.delete(statusKey(projectId, serverId));
      this.emit();
      return;
    }
    await this.startServer(server);
  }

  async deactivateProject(projectId?: string): Promise<void> {
    if (projectId && this.projectId && projectId !== this.projectId) return;
    const generation = ++this.generation;
    const active = [...this.active.values()];
    this.active.clear();
    this.projectId = '';
    await Promise.all(active.map((entry) => this.stopActive(entry)));
    if (generation === this.generation && !this.projectId) {
      this.statuses.clear();
      this.emit();
    }
  }

  private async startServer(config: AgentMcpServerConfig): Promise<void> {
    const previous = this.active.get(config.id);
    if (previous) await this.stopActive(previous);
    const controller = new AbortController();
    const active: ActiveServer = {
      config,
      controller,
      transport: null,
      client: null,
      source: null,
      task: Promise.resolve(),
    };
    this.active.set(config.id, active);
    active.task = this.connectWithRetry(active);
    await active.task;
  }

  private async connectWithRetry(active: ActiveServer): Promise<void> {
    const delays = this.options.retryDelaysMs ?? [250, 1_000];
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (!this.isCurrent(active)) return;
      try {
        this.setStatus(
          active,
          attempt + 1,
          attempt === 0 ? 'connecting' : 'degraded',
          attempt === 0 ? 'Connecting' : 'Retrying handshake',
        );
        await this.persistHealth(
          active,
          attempt === 0 ? 'connecting' : 'degraded',
          attempt === 0 ? 'Connecting' : 'Retrying handshake',
        );
        await this.connectOnce(active);
        return;
      } catch (error) {
        await this.disposeConnection(active);
        if (!this.isCurrent(active) || active.controller.signal.aborted) return;
        if (attempt >= delays.length) {
          const message = extensionFailureMessage(error);
          this.setStatus(active, attempt + 1, 'failed', message);
          await this.persistHealth(active, 'failed', message).catch(() => undefined);
          return;
        }
        await (this.options.wait ?? waitFor)(delays[attempt]!, active.controller.signal);
      }
    }
  }

  private async connectOnce(active: ActiveServer): Promise<void> {
    const { config, controller } = active;
    const transport = await this.createTransport(config);
    active.transport = transport;
    const client = await connectAgentMcpClient({ transport, signal: controller.signal });
    active.client = client;
    const discovered = await client.listTools({ signal: controller.signal });
    if (!this.isCurrent(active)) {
      await this.disposeConnection(active);
      return;
    }
    const source = await registerAgentMcpToolSource({
      registry: this.options.registry,
      client,
      serverId: config.id,
      projectId: config.projectId,
      sourceRevision: config.configRevision,
      signal: controller.signal,
      discoveredTools: discovered,
      classify: (tool) => classifyTool(config, tool),
    });
    if (!this.isCurrent(active)) {
      source.unregister();
      await this.disposeConnection(active);
      return;
    }
    active.source = source;
    const now = this.nowIso();
    await this.options.repository.updateServerHealth({
      projectId: config.projectId,
      serverId: config.id,
      status: 'healthy',
      message: `${source.providerNames.length} tools available`,
      serverInfo: { ...client.serverInfo },
      discoveredTools: discovered.map(toPersistedTool),
      connected: true,
      checkedAt: now,
    });
    if (!this.isCurrent(active)) {
      source.unregister();
      await this.disposeConnection(active);
      return;
    }
    this.setStatus(active, 1, 'healthy', `${source.providerNames.length} tools available`);
  }

  private async createTransport(config: AgentMcpServerConfig): Promise<AgentMcpJsonRpcTransport> {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('MCP stdio command is missing');
      return createStdioAgentMcpTransport({
        platform: this.options.stdioPlatform,
        processId: this.options.createProcessId?.() ?? this.nextProcessId(),
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: await this.resolveSecrets(config.publicEnv, config.secretEnv),
        configRevision: config.configRevision,
      });
    }
    if (!config.url) throw new Error('MCP HTTP URL is missing');
    return createHttpAgentMcpTransport({
      url: config.url,
      headers: await this.resolveSecrets(config.publicHeaders, config.secretHeaders),
      ...(this.options.fetch
        ? { fetch: this.options.fetch }
        : this.options.httpPlatform
          ? { platform: this.options.httpPlatform }
          : {}),
    });
  }

  private async resolveSecrets(
    publicValues: Readonly<Record<string, string>>,
    secretRefs: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const result = { ...publicValues };
    for (const [name, keychainId] of Object.entries(secretRefs)) {
      const value = await this.options.readSecret(keychainId);
      if (!value) throw new Error(`MCP secret "${name}" is unavailable`);
      result[name] = value;
    }
    return result;
  }

  private async stopActive(active: ActiveServer): Promise<void> {
    if (!active.controller.signal.aborted) {
      active.controller.abort(new DOMException('MCP configuration generation stopped', 'AbortError'));
    }
    try {
      await active.task;
    } catch {
      // connectWithRetry owns health projection; shutdown is idempotent.
    } finally {
      await this.disposeConnection(active);
    }
  }

  private async disposeConnection(active: ActiveServer): Promise<void> {
    active.source?.unregister();
    active.source = null;
    const client = active.client;
    const transport = active.transport;
    active.client = null;
    active.transport = null;
    if (client) await client.close().catch(() => undefined);
    else if (transport) await transport.close().catch(() => undefined);
  }

  private isCurrent(active: ActiveServer): boolean {
    return (
      this.projectId === active.config.projectId &&
      this.active.get(active.config.id) === active &&
      !active.controller.signal.aborted
    );
  }

  private setStatus(
    active: ActiveServer,
    attempt: number,
    status: AgentExtensionManagerStatus['status'],
    message: string,
  ): void {
    this.statuses.set(statusKey(active.config.projectId, active.config.id), {
      projectId: active.config.projectId,
      serverId: active.config.id,
      configRevision: active.config.configRevision,
      status,
      attempt,
      message,
    });
    this.emit();
  }

  private persistHealth(
    active: ActiveServer,
    status: 'connecting' | 'degraded' | 'failed',
    message: string,
  ): Promise<void> {
    return this.options.repository.updateServerHealth({
      projectId: active.config.projectId,
      serverId: active.config.id,
      status,
      message,
      checkedAt: this.nowIso(),
    });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private nextProcessId(): string {
    this.processCounter += 1;
    return `mcp:${Date.now().toString(36)}:${this.processCounter.toString(36)}`;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function classifyTool(
  config: AgentMcpServerConfig,
  tool: AgentMcpToolDescriptor,
): AgentMcpToolPolicy | null {
  const policy = config.toolPolicy[tool.name] ?? defaultAgentMcpToolPolicy();
  return policy.approval === 'deny' ? null : policy;
}

function toPersistedTool(tool: AgentMcpToolDescriptor): AgentMcpServerConfig['discoveredTools'][number] {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
  };
}

function extensionFailureMessage(error: unknown): string {
  if (error instanceof AgentMcpTransportError) {
    return `Connection failed (${error.kind})`;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'Connection stopped';
  return 'Connection or discovery failed';
}

function statusKey(projectId: string, serverId: string): string {
  return `${projectId}\u0000${serverId}`;
}

function requireId(value: string, label: string): void {
  if (!value.trim() || value.length > 200) throw new Error(`${label} is invalid`);
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = globalThis.setTimeout(done, milliseconds);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
