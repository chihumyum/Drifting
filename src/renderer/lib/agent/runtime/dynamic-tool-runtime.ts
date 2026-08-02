import { clonePortableData } from './portable-data';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolPermissionPolicy,
  AgentToolPermissionPolicyDecision,
  AgentToolPermissionPolicyRequest,
  AgentToolRuntime,
  AgentToolSelectionHintRequest,
  AgentToolSelectionHints,
} from './types';

export type DynamicAgentToolSourceKind = 'mcp' | 'plugin';
export type DynamicAgentToolApproval = 'automatic' | 'ask' | 'deny';

export interface DynamicAgentToolHandlerInput {
  sourceId: string;
  sourceKind: DynamicAgentToolSourceKind;
  remoteName: string;
  arguments: Record<string, unknown>;
  context: AgentRuntimeContext;
  signal: AbortSignal;
}

export interface DynamicAgentToolSpec {
  /** Name understood by the external source. It is never sent to the model. */
  remoteName: string;
  description: string;
  inputSchema: object;
  /**
   * Host-owned classification. MCP annotations are hints and must not set this
   * value without an explicit local policy.
   */
  access: 'read' | 'write';
  /**
   * External writes must use `ask`; the registry rejects automatic writes.
   * `deny` keeps a discovered tool unavailable without losing its descriptor.
   */
  approval: DynamicAgentToolApproval;
  execute(input: DynamicAgentToolHandlerInput): Promise<unknown>;
}

export interface DynamicAgentToolSource {
  sourceId: string;
  sourceKind: DynamicAgentToolSourceKind;
  /** Dynamic tools are project-bound; global authority is not implemented. */
  projectId: string;
  /** Stable local configuration fingerprint; changing it invalidates grants. */
  sourceRevision?: string;
  tools: readonly DynamicAgentToolSpec[];
}

export interface RegisteredDynamicAgentTool {
  sourceId: string;
  sourceKind: DynamicAgentToolSourceKind;
  projectId: string;
  remoteName: string;
  providerName: string;
  access: 'read' | 'write';
  approval: DynamicAgentToolApproval;
  sourceRevision: string;
  /** Stable schema/policy identity used by durable permission grants. */
  authorityRevision: string;
  definitionRevision: string;
}

export interface DynamicAgentToolSourceHandle {
  sourceId: string;
  sourceKind: DynamicAgentToolSourceKind;
  projectId: string;
  generation: number;
  providerNames: readonly string[];
  unregister(): void;
}

interface DynamicAgentToolRecord extends RegisteredDynamicAgentTool {
  definition: AgentToolDefinition;
  execute: DynamicAgentToolSpec['execute'];
}

interface DynamicAgentToolSourceRecord {
  sourceId: string;
  sourceKind: DynamicAgentToolSourceKind;
  projectId: string;
  generation: number;
  tools: Map<string, DynamicAgentToolRecord>;
}

export interface DynamicAgentToolRegistryOptions {
  /** Built-in provider names that external sources may never shadow. */
  reservedNames?: readonly string[];
  maxSources?: number;
  maxToolsPerSource?: number;
  maxVisibleToolsPerProject?: number;
}

export interface DynamicAgentPermissionGrantAuthority {
  findGrant(
    request: AgentToolPermissionPolicyRequest,
    descriptor: RegisteredDynamicAgentTool,
  ): Promise<{ grantId: string; scope: 'session' | 'project' } | null>;
  recordGrant(
    request: AgentToolPermissionPolicyRequest,
    resolution: import('../protocol').AgentPermissionResolutionInput,
    descriptor: RegisteredDynamicAgentTool,
  ): Promise<{ authorityId: string }>;
}

const DEFAULT_MAX_DYNAMIC_SOURCES = 128;
const DEFAULT_MAX_TOOLS_PER_SOURCE = 64;
const DEFAULT_MAX_VISIBLE_TOOLS_PER_PROJECT = 128;
const MAX_EXTERNAL_SCHEMA_BYTES = 64 * 1024;
const MAX_EXTERNAL_SCHEMA_NODES = 2_048;
const MAX_EXTERNAL_SCHEMA_DEPTH = 24;

/**
 * Renderer-owned, source-scoped registry for tools discovered at runtime.
 *
 * Source replacement is atomic: every descriptor/schema is validated before
 * the previous generation is replaced. Provider-visible names are stable,
 * namespaced and collision-checked; execution rechecks route visibility and
 * access after the central runtime permission gate.
 */
export class DynamicAgentToolRegistry implements AgentToolRuntime {
  private readonly sources = new Map<string, DynamicAgentToolSourceRecord>();
  private readonly reservedNames: ReadonlySet<string>;
  private readonly maxSources: number;
  private readonly maxToolsPerSource: number;
  private readonly maxVisibleToolsPerProject: number;
  private nextGeneration = 1;

  constructor(options: DynamicAgentToolRegistryOptions = {}) {
    this.reservedNames = new Set(options.reservedNames ?? []);
    this.maxSources = positiveSafeInteger(
      options.maxSources ?? DEFAULT_MAX_DYNAMIC_SOURCES,
      'maxSources',
    );
    this.maxToolsPerSource = positiveSafeInteger(
      options.maxToolsPerSource ?? DEFAULT_MAX_TOOLS_PER_SOURCE,
      'maxToolsPerSource',
    );
    this.maxVisibleToolsPerProject = positiveSafeInteger(
      options.maxVisibleToolsPerProject ??
        DEFAULT_MAX_VISIBLE_TOOLS_PER_PROJECT,
      'maxVisibleToolsPerProject',
    );
  }

  registerSource(source: DynamicAgentToolSource): DynamicAgentToolSourceHandle {
    const sourceId = requireNonBlank(source.sourceId, 'sourceId', 200);
    const projectId = requireNonBlank(source.projectId, 'projectId', 200);
    const sourceRevision = requireNonBlank(
      source.sourceRevision ?? 'ephemeral-v1',
      'sourceRevision',
      200,
    );
    if (source.sourceKind !== 'mcp' && source.sourceKind !== 'plugin') {
      throw new Error(`Unsupported dynamic Agent tool source "${String(source.sourceKind)}"`);
    }
    if (!Array.isArray(source.tools)) {
      throw new Error('Dynamic Agent tool source tools must be an array');
    }
    if (source.tools.length > this.maxToolsPerSource) {
      throw new Error(
        `Dynamic Agent source "${sourceId}" exceeds ${this.maxToolsPerSource} tools`,
      );
    }

    const generation = this.nextGeneration++;
    const key = dynamicAgentToolSourceKey(
      source.sourceKind,
      projectId,
      sourceId,
    );
    const nextTools = new Map<string, DynamicAgentToolRecord>();
    for (const spec of source.tools) {
      const remoteName = requireNonBlank(spec.remoteName, 'remoteName', 300);
      const providerName = dynamicAgentToolProviderName(
        source.sourceKind,
        sourceId,
        remoteName,
      );
      if (this.reservedNames.has(providerName)) {
        throw new Error(
          `Dynamic Agent tool "${providerName}" collides with a reserved built-in tool`,
        );
      }
      if (nextTools.has(providerName)) {
        throw new Error(
          `Dynamic Agent source "${sourceId}" contains duplicate provider name "${providerName}"`,
        );
      }
      const description = requireNonBlank(
        spec.description,
        `${remoteName}.description`,
        4_000,
      );
      const inputSchema = validateExternalToolSchema(
        spec.inputSchema,
        remoteName,
      );
      if (spec.access !== 'read' && spec.access !== 'write') {
        throw new Error(`Dynamic Agent tool "${remoteName}" has invalid access`);
      }
      if (
        spec.approval !== 'automatic' &&
        spec.approval !== 'ask' &&
        spec.approval !== 'deny'
      ) {
        throw new Error(`Dynamic Agent tool "${remoteName}" has invalid approval`);
      }
      if (spec.access === 'write' && spec.approval === 'automatic') {
        throw new Error(
          `Dynamic Agent write "${remoteName}" cannot bypass per-call approval`,
        );
      }
      if (typeof spec.execute !== 'function') {
        throw new Error(`Dynamic Agent tool "${remoteName}" has no executor`);
      }

      const definitionRevision = dynamicAgentToolExecutionRevision({
        sourceKind: source.sourceKind,
        projectId,
        sourceId,
        remoteName,
        generation,
      });
      const authorityRevision = dynamicAgentToolAuthorityRevision({
        sourceKind: source.sourceKind,
        projectId,
        sourceId,
        sourceRevision,
        remoteName,
        description,
        inputSchema,
        access: spec.access,
        approval: spec.approval,
      });
      const definition: AgentToolDefinition = {
        name: providerName,
        description,
        inputSchema,
        access: spec.access,
        executionRevision: definitionRevision,
        validateInput: (input) =>
          validateExternalToolInput(inputSchema, input),
      };
      nextTools.set(providerName, {
        sourceId,
        sourceKind: source.sourceKind,
        projectId,
        remoteName,
        providerName,
        access: spec.access,
        approval: spec.approval,
        sourceRevision,
        authorityRevision,
        definitionRevision,
        definition,
        execute: spec.execute,
      });
    }

    for (const [candidateKey, sourceRecord] of this.sources) {
      if (
        candidateKey === key ||
        sourceRecord.projectId !== projectId
      ) {
        continue;
      }
      for (const providerName of nextTools.keys()) {
        if (sourceRecord.tools.has(providerName)) {
          throw new Error(
            `Dynamic Agent tool provider name collision "${providerName}"`,
          );
        }
      }
    }
    const currentProjectToolCount = [...this.sources.entries()].reduce(
      (total, [candidateKey, sourceRecord]) =>
        candidateKey !== key && sourceRecord.projectId === projectId
          ? total + sourceRecord.tools.size
          : total,
      0,
    );
    if (
      currentProjectToolCount + nextTools.size >
      this.maxVisibleToolsPerProject
    ) {
      throw new Error(
        `Dynamic Agent project "${projectId}" exceeds ${this.maxVisibleToolsPerProject} visible tools`,
      );
    }
    if (!this.sources.has(key) && this.sources.size >= this.maxSources) {
      throw new Error(
        `Dynamic Agent registry exceeds ${this.maxSources} sources`,
      );
    }
    this.sources.set(key, {
      sourceId,
      sourceKind: source.sourceKind,
      projectId,
      generation,
      tools: nextTools,
    });
    return Object.freeze({
      sourceId,
      sourceKind: source.sourceKind,
      projectId,
      generation,
      providerNames: Object.freeze([...nextTools.keys()].sort()),
      unregister: () => {
        const current = this.sources.get(key);
        if (current?.generation === generation) this.sources.delete(key);
      },
    });
  }

  unregisterSource(input: {
    sourceId: string;
    sourceKind: DynamicAgentToolSourceKind;
    projectId: string;
  }): boolean {
    return this.sources.delete(
      dynamicAgentToolSourceKey(
        input.sourceKind,
        requireNonBlank(input.projectId, 'projectId', 200),
        requireNonBlank(input.sourceId, 'sourceId', 200),
      ),
    );
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    return this.visibleRecords(context)
      .filter((record) => record.approval !== 'deny')
      .map((record) => record.definition);
  }

  describe(
    name: string,
    context: AgentRuntimeContext,
  ): RegisteredDynamicAgentTool | null {
    const record = this.findVisibleRecord(name, context);
    if (!record) return null;
    return {
      sourceId: record.sourceId,
      sourceKind: record.sourceKind,
      projectId: record.projectId,
      remoteName: record.remoteName,
      providerName: record.providerName,
      access: record.access,
      approval: record.approval,
      sourceRevision: record.sourceRevision,
      authorityRevision: record.authorityRevision,
      definitionRevision: record.definitionRevision,
    };
  }

  /**
   * Resolve a registered provider name without crossing a project boundary.
   *
   * Recovery already validates the session route separately. This lookup is
   * deliberately limited to the immutable access classification so persisted
   * tool calls can be reconstructed after the source has re-registered.
   */
  resolveAccess(
    name: string,
    projectId: string,
  ): 'read' | 'write' | undefined {
    for (const source of this.sources.values()) {
      if (source.projectId !== projectId) continue;
      const record = source.tools.get(name);
      if (record?.approval !== 'deny') return record?.access;
    }
    return undefined;
  }

  async execute(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionResult> {
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const record = this.findVisibleRecord(request.name, request.context);
    if (!record || record.approval === 'deny') {
      return {
        ok: false,
        error: `Dynamic Agent tool "${request.name}" is unavailable in this project`,
      };
    }
    if (record.access !== request.access) {
      return {
        ok: false,
        error: `Dynamic Agent tool "${request.name}" access classification changed`,
      };
    }
    if (
      !request.definitionRevision ||
      request.definitionRevision !== record.definitionRevision
    ) {
      return {
        ok: false,
        error: `Dynamic Agent tool "${request.name}" definition changed before execution`,
      };
    }
    const validated = record.definition.validateInput(request.arguments);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    try {
      const result = await record.execute({
        sourceId: record.sourceId,
        sourceKind: record.sourceKind,
        remoteName: record.remoteName,
        arguments: clonePortableData(validated.value),
        context: request.context,
        signal: request.signal,
      });
      if (request.signal.aborted) {
        throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      return { ok: true, data: clonePortableData(result) };
    } catch (error) {
      if (request.signal.aborted) throw error;
      return {
        ok: false,
        error:
          error instanceof Error && error.message.trim()
            ? error.message
            : 'Dynamic Agent tool execution failed',
      };
    }
  }

  private visibleRecords(
    context: AgentRuntimeContext,
  ): DynamicAgentToolRecord[] {
    const projectId = context.route.projectId;
    const records: DynamicAgentToolRecord[] = [];
    for (const source of this.sources.values()) {
      for (const record of source.tools.values()) {
        if (record.projectId !== projectId) {
          continue;
        }
        records.push(record);
      }
    }
    return records.sort((left, right) =>
      left.providerName.localeCompare(right.providerName, 'en'),
    );
  }

  private findVisibleRecord(
    name: string,
    context: AgentRuntimeContext,
  ): DynamicAgentToolRecord | null {
    return (
      this.visibleRecords(context).find(
        (record) => record.providerName === name,
      ) ?? null
    );
  }
}

/** Merge built-in and runtime-discovered tools without allowing shadowing. */
export class CompositeAgentToolRuntime implements AgentToolRuntime {
  private readonly builtIns: readonly AgentToolRuntime[];

  constructor(
    builtIn: AgentToolRuntime | readonly AgentToolRuntime[],
    private readonly dynamic: DynamicAgentToolRegistry,
  ) {
    this.builtIns = Array.isArray(builtIn) ? [...builtIn] : [builtIn];
    if (this.builtIns.length === 0) {
      throw new Error(
        'Composite Agent tool runtime requires at least one built-in runtime',
      );
    }
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    const builtIn: AgentToolDefinition[] = [];
    const names = new Set<string>();
    for (const [ownerIndex, runtime] of this.builtIns.entries()) {
      for (const definition of runtime.listDefinitions(context)) {
        if (names.has(definition.name)) {
          throw new Error(
            `Built-in Agent tool "${definition.name}" is registered more than once`,
          );
        }
        names.add(definition.name);
        builtIn.push(bindBuiltInDefinition(ownerIndex, definition));
      }
    }
    const dynamic = this.dynamic.listDefinitions(context);
    for (const definition of dynamic) {
      if (names.has(definition.name)) {
        throw new Error(
          `Dynamic Agent tool "${definition.name}" shadows a built-in tool`,
        );
      }
      names.add(definition.name);
    }
    return [...builtIn, ...dynamic];
  }

  resolveCanonicalName(
    name: string,
    context: AgentRuntimeContext,
  ): string | undefined {
    if (this.dynamic.describe(name, context)) return name;
    const exactOwners = this.builtIns.filter((runtime) =>
      runtime.listDefinitions(context).some((definition) => definition.name === name),
    );
    if (exactOwners.length === 1) return name;
    if (exactOwners.length > 1) return undefined;

    const resolved = new Set<string>();
    for (const runtime of this.builtIns) {
      const canonical = runtime.resolveCanonicalName?.(name, context);
      if (!canonical) continue;
      if (
        runtime
          .listDefinitions(context)
          .some((definition) => definition.name === canonical)
      ) {
        resolved.add(canonical);
      }
    }
    return resolved.size === 1 ? [...resolved][0] : undefined;
  }

  async loadSelectionHints(
    request: AgentToolSelectionHintRequest,
  ): Promise<AgentToolSelectionHints> {
    let longTask: AgentToolSelectionHints['longTask'];
    for (const runtime of this.builtIns) {
      if (!runtime.loadSelectionHints) continue;
      const hints = clonePortableData(
        await runtime.loadSelectionHints(request),
      );
      if (!hints.longTask) continue;
      if (longTask) {
        throw new Error(
          'Composite Agent tool runtimes returned more than one long-task selection hint',
        );
      }
      longTask = hints.longTask;
    }
    return longTask ? { longTask } : {};
  }

  execute(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionResult> {
    if (this.dynamic.describe(request.name, request.context)) {
      return this.dynamic.execute(request);
    }
    for (const [ownerIndex, runtime] of this.builtIns.entries()) {
      const definition = runtime
        .listDefinitions(request.context)
        .find((candidate) => candidate.name === request.name);
      if (!definition) continue;
      const currentRevision = bindBuiltInDefinition(
        ownerIndex,
        definition,
      ).executionRevision;
      if (
        request.definitionRevision &&
        request.definitionRevision !== currentRevision
      ) {
        return Promise.resolve({
          ok: false,
          error: `Tool "${request.name}" definition changed before execution`,
        });
      }
      if (request.access !== definition.access) {
        return Promise.resolve({
          ok: false,
          error: `Tool "${request.name}" access changed before execution`,
        });
      }
      return runtime.execute(request);
    }
    return Promise.resolve({
          ok: false,
          error: `Tool "${request.name}" is unavailable in this runtime`,
        });
  }
}

function bindBuiltInDefinition(
  ownerIndex: number,
  definition: AgentToolDefinition,
): AgentToolDefinition {
  const identity = JSON.stringify({
    ownerIndex,
    name: definition.name,
    access: definition.access,
    description: definition.description,
    inputSchema: definition.inputSchema,
    innerRevision: definition.executionRevision ?? null,
  });
  return {
    ...definition,
    executionRevision: `builtin:${ownerIndex}:${fnv1a32(identity)}`,
  };
}

/** Add fail-closed external-tool approval to the existing product policy. */
export function createDynamicAwareAgentPermissionPolicy(
  builtIn: AgentToolPermissionPolicy,
  dynamic: DynamicAgentToolRegistry,
  authority?: DynamicAgentPermissionGrantAuthority,
): AgentToolPermissionPolicy {
  return {
    async decide(
      request: AgentToolPermissionPolicyRequest,
    ): Promise<AgentToolPermissionPolicyDecision> {
      const descriptor = dynamic.describe(request.toolName, request.context);
      if (!descriptor) return builtIn.decide(request);
      if (descriptor.access !== request.access) {
        return {
          decision: 'deny',
          reason: 'Dynamic tool access classification changed.',
        };
      }
      if (
        descriptor.definitionRevision !==
        request.toolDefinitionRevision
      ) {
        return {
          decision: 'deny',
          reason: 'Dynamic tool definition changed before approval.',
        };
      }
      if (descriptor.approval === 'deny') {
        return {
          decision: 'deny',
          reason: 'This external tool is disabled by local policy.',
        };
      }
      if (descriptor.approval === 'ask') {
        const grant = authority
          ? await authority.findGrant(request, descriptor)
          : null;
        if (grant) {
          return {
            decision: 'allow',
            scope: grant.scope,
            grantId: grant.grantId,
          };
        }
        return {
          decision: 'ask',
          reason: `${descriptor.sourceKind.toUpperCase()} source "${descriptor.sourceId}" requests ${descriptor.access} access.`,
          allowedScopes: authority
            ? ['once', 'session', 'project']
            : ['once'],
        };
      }
      return { decision: 'allow', scope: 'once' };
    },
    async recordResolution(request, resolution) {
      const descriptor = dynamic.describe(request.toolName, request.context);
      if (!descriptor) {
        return builtIn.recordResolution?.(request, resolution);
      }
      if (resolution.scope === 'once') return;
      if (!authority) {
        throw new Error('Durable dynamic permission authority is unavailable');
      }
      if (
        descriptor.definitionRevision !== request.toolDefinitionRevision ||
        descriptor.access !== request.access
      ) {
        throw new Error('Dynamic tool changed while durable permission was pending');
      }
      return authority.recordGrant(request, resolution, descriptor);
    },
  };
}

/** Stable provider-safe namespace; original source/tool names stay local. */
export function dynamicAgentToolProviderName(
  sourceKind: DynamicAgentToolSourceKind,
  sourceId: string,
  remoteName: string,
): string {
  const kind = sourceKind === 'mcp' ? 'mcp' : 'plugin';
  const sourceSlug = slug(sourceId, 14);
  const toolSlug = slug(remoteName, 24);
  const sourceHash = fnv1a32(sourceId);
  const toolHash = fnv1a32(remoteName);
  return `${kind}__${sourceSlug}_${sourceHash}__${toolSlug}_${toolHash}`;
}

function dynamicAgentToolSourceKey(
  sourceKind: DynamicAgentToolSourceKind,
  projectId: string,
  sourceId: string,
): string {
  return `${sourceKind}\u0000${projectId}\u0000${sourceId}`;
}

function dynamicAgentToolExecutionRevision(input: {
  sourceKind: DynamicAgentToolSourceKind;
  projectId: string;
  sourceId: string;
  remoteName: string;
  generation: number;
}): string {
  const identity = [
    input.sourceKind,
    input.projectId,
    input.sourceId,
    input.remoteName,
    String(input.generation),
  ].join('\u0000');
  return `dynamic:${input.generation}:${fnv1a32(identity)}`;
}

function dynamicAgentToolAuthorityRevision(input: {
  sourceKind: DynamicAgentToolSourceKind;
  projectId: string;
  sourceId: string;
  sourceRevision: string;
  remoteName: string;
  description: string;
  inputSchema: object;
  access: 'read' | 'write';
  approval: DynamicAgentToolApproval;
}): string {
  const identity = JSON.stringify({
    sourceKind: input.sourceKind,
    projectId: input.projectId,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    remoteName: input.remoteName,
    description: input.description,
    inputSchema: input.inputSchema,
    access: input.access,
    approval: input.approval,
  });
  return `authority:${fnv1a32(identity)}`;
}

function slug(value: string, limit: number): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLocaleLowerCase('en-US');
  return (normalized || 'tool').slice(0, limit);
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function requireNonBlank(
  value: string,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateExternalToolSchema(
  value: object,
  toolName: string,
): object {
  assertExternalSchemaComplexity(value, toolName);
  const schema = clonePortableData(value);
  const encodedSchema = JSON.stringify(schema);
  if (
    !encodedSchema ||
    new TextEncoder().encode(encodedSchema).byteLength >
      MAX_EXTERNAL_SCHEMA_BYTES
  ) {
    throw new Error(
      `Dynamic Agent tool "${toolName}" inputSchema exceeds ${MAX_EXTERNAL_SCHEMA_BYTES} bytes`,
    );
  }
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (schema as { type?: unknown }).type !== 'object'
  ) {
    throw new Error(
      `Dynamic Agent tool "${toolName}" inputSchema must be a root object schema`,
    );
  }
  if (containsSchemaReference(schema)) {
    throw new Error(
      `Dynamic Agent tool "${toolName}" inputSchema cannot contain unresolved $ref values`,
    );
  }
  try {
    assertSupportedJsonSchema(schema, '$');
  } catch {
    throw new Error(
      `Dynamic Agent tool "${toolName}" inputSchema is unsupported`,
    );
  }
  return schema;
}

function assertExternalSchemaComplexity(
  value: unknown,
  toolName: string,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_EXTERNAL_SCHEMA_NODES) {
      throw new Error(
        `Dynamic Agent tool "${toolName}" inputSchema is too complex`,
      );
    }
    if (current.depth > MAX_EXTERNAL_SCHEMA_DEPTH) {
      throw new Error(
        `Dynamic Agent tool "${toolName}" inputSchema is too deep`,
      );
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) {
      throw new Error(
        `Dynamic Agent tool "${toolName}" inputSchema is cyclic`,
      );
    }
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function containsSchemaReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(containsSchemaReference);
  }
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (key === '$ref') return true;
    if (containsSchemaReference(child)) return true;
  }
  return false;
}

function validateExternalToolInput(
  schema: object,
  input: Record<string, unknown>,
): ReturnType<AgentToolDefinition['validateInput']> {
  try {
    const error = validateJsonSchemaValue(schema, input, '');
    if (!error) {
      return { ok: true, value: clonePortableData(input) };
    }
    return {
      ok: false,
      error: `Invalid dynamic tool arguments at ${error.path || '/'}: ${error.message}`,
    };
  } catch {
    return {
      ok: false,
      error: 'Dynamic tool schema validation failed closed',
    };
  }
}

const JSON_SCHEMA_ANNOTATION_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const JSON_SCHEMA_ASSERTION_KEYS = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
]);
const JSON_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function assertSupportedJsonSchema(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a schema object`);
  }
  const schema = value as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (
      !JSON_SCHEMA_ANNOTATION_KEYS.has(key) &&
      !JSON_SCHEMA_ASSERTION_KEYS.has(key)
    ) {
      throw new Error(`${path}.${key} is unsupported`);
    }
  }
  if (
    schema.type !== undefined &&
    typeof schema.type !== 'string' &&
    !Array.isArray(schema.type)
  ) {
    throw new Error(`${path}.type is unsupported`);
  }
  const types =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type
        : [];
  if (
    (Array.isArray(schema.type) && types.length === 0) ||
    new Set(types).size !== types.length ||
    types.some(
      (type) =>
        typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type),
    )
  ) {
    throw new Error(`${path}.type is unsupported`);
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((key) => typeof key !== 'string') ||
      new Set(schema.required).size !== schema.required.length)
  ) {
    throw new Error(`${path}.required must be a string array`);
  }
  if (schema.properties !== undefined) {
    assertSchemaMap(schema.properties, `${path}.properties`);
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    assertSupportedJsonSchema(
      schema.additionalProperties,
      `${path}.additionalProperties`,
    );
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new Error(`${path}.items tuple schemas are unsupported`);
    }
    assertSupportedJsonSchema(schema.items, `${path}.items`);
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const children = schema[combinator];
    if (children === undefined) continue;
    if (!Array.isArray(children) || children.length === 0) {
      throw new Error(`${path}.${combinator} must be a non-empty array`);
    }
    children.forEach((child, index) =>
      assertSupportedJsonSchema(
        child,
        `${path}.${combinator}[${index}]`,
      ),
    );
  }
  if (schema.not !== undefined) {
    assertSupportedJsonSchema(schema.not, `${path}.not`);
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0)
  ) {
    throw new Error(`${path}.enum must be a non-empty array`);
  }
  if (
    schema.uniqueItems !== undefined &&
    typeof schema.uniqueItems !== 'boolean'
  ) {
    throw new Error(`${path}.uniqueItems must be a boolean`);
  }
  for (const key of [
    'minProperties',
    'maxProperties',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
  ]) {
    const candidate = schema[key];
    if (
      candidate !== undefined &&
      (!Number.isSafeInteger(candidate) || Number(candidate) < 0)
    ) {
      throw new Error(`${path}.${key} must be a non-negative integer`);
    }
  }
  for (const key of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ]) {
    const candidate = schema[key];
    if (
      candidate !== undefined &&
      (typeof candidate !== 'number' || !Number.isFinite(candidate))
    ) {
      throw new Error(`${path}.${key} must be a finite number`);
    }
  }
  if (
    typeof schema.multipleOf === 'number' &&
    schema.multipleOf <= 0
  ) {
    throw new Error(`${path}.multipleOf must be positive`);
  }
}

function assertSchemaMap(value: unknown, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    assertSupportedJsonSchema(child, `${path}.${key}`);
  }
}

interface JsonSchemaValidationError {
  path: string;
  message: string;
}

function validateJsonSchemaValue(
  schemaValue: object,
  value: unknown,
  path: string,
): JsonSchemaValidationError | null {
  const schema = schemaValue as Record<string, unknown>;
  const allOf = schema.allOf as object[] | undefined;
  if (allOf) {
    for (const child of allOf) {
      const error = validateJsonSchemaValue(child, value, path);
      if (error) return error;
    }
  }
  const anyOf = schema.anyOf as object[] | undefined;
  if (
    anyOf &&
    !anyOf.some(
      (child) => validateJsonSchemaValue(child, value, path) === null,
    )
  ) {
    return { path, message: 'must match at least one allowed schema' };
  }
  const oneOf = schema.oneOf as object[] | undefined;
  if (
    oneOf &&
    oneOf.filter(
      (child) => validateJsonSchemaValue(child, value, path) === null,
    ).length !== 1
  ) {
    return { path, message: 'must match exactly one allowed schema' };
  }
  if (
    schema.not &&
    validateJsonSchemaValue(schema.not as object, value, path) === null
  ) {
    return { path, message: 'matches a forbidden schema' };
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonValueEqual(candidate, value))
  ) {
    return { path, message: 'must be one of the declared enum values' };
  }
  if (
    Object.prototype.hasOwnProperty.call(schema, 'const') &&
    !jsonValueEqual(schema.const, value)
  ) {
    return { path, message: 'must equal the declared const value' };
  }

  const declaredTypes =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? (schema.type as string[])
        : [];
  if (
    declaredTypes.length > 0 &&
    !declaredTypes.some((type) => jsonTypeMatches(type, value))
  ) {
    return {
      path,
      message: `must be ${declaredTypes.join(' or ')}`,
    };
  }

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (declaredTypes.length === 0 || declaredTypes.includes('object'))
  ) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const min = schema.minProperties as number | undefined;
    const max = schema.maxProperties as number | undefined;
    if (min !== undefined && keys.length < min) {
      return { path, message: `must have at least ${min} properties` };
    }
    if (max !== undefined && keys.length > max) {
      return { path, message: `must have at most ${max} properties` };
    }
    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        return {
          path: `${path}/${escapeJsonPointer(required)}`,
          message: 'is required',
        };
      }
    }
    const properties =
      (schema.properties as Record<string, object> | undefined) ?? {};
    for (const key of keys) {
      const childPath = `${path}/${escapeJsonPointer(key)}`;
      const direct = Object.prototype.hasOwnProperty.call(
        properties,
        key,
      )
        ? properties[key]
        : undefined;
      let matched = false;
      if (direct) {
        matched = true;
        const error = validateJsonSchemaValue(
          direct,
          record[key],
          childPath,
        );
        if (error) return error;
      }
      if (matched) continue;
      if (schema.additionalProperties === false) {
        return { path: childPath, message: 'is not allowed' };
      }
      if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        const error = validateJsonSchemaValue(
          schema.additionalProperties as object,
          record[key],
          childPath,
        );
        if (error) return error;
      }
    }
  }

  if (
    Array.isArray(value) &&
    (declaredTypes.length === 0 || declaredTypes.includes('array'))
  ) {
    const min = schema.minItems as number | undefined;
    const max = schema.maxItems as number | undefined;
    if (min !== undefined && value.length < min) {
      return { path, message: `must contain at least ${min} items` };
    }
    if (max !== undefined && value.length > max) {
      return { path, message: `must contain at most ${max} items` };
    }
    if (schema.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (jsonValueEqual(value[left], value[right])) {
            return { path: `${path}/${right}`, message: 'must be unique' };
          }
        }
      }
    }
    if (schema.items && typeof schema.items === 'object') {
      for (const [index, item] of value.entries()) {
        const error = validateJsonSchemaValue(
          schema.items as object,
          item,
          `${path}/${index}`,
        );
        if (error) return error;
      }
    }
  }

  if (
    typeof value === 'string' &&
    (declaredTypes.length === 0 || declaredTypes.includes('string'))
  ) {
    const length = [...value].length;
    const min = schema.minLength as number | undefined;
    const max = schema.maxLength as number | undefined;
    if (min !== undefined && length < min) {
      return { path, message: `must contain at least ${min} characters` };
    }
    if (max !== undefined && length > max) {
      return { path, message: `must contain at most ${max} characters` };
    }
  }

  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (declaredTypes.length === 0 ||
      declaredTypes.includes('number') ||
      declaredTypes.includes('integer'))
  ) {
    if (
      typeof schema.minimum === 'number' &&
      value < schema.minimum
    ) {
      return { path, message: `must be at least ${schema.minimum}` };
    }
    if (
      typeof schema.maximum === 'number' &&
      value > schema.maximum
    ) {
      return { path, message: `must be at most ${schema.maximum}` };
    }
    if (
      typeof schema.exclusiveMinimum === 'number' &&
      value <= schema.exclusiveMinimum
    ) {
      return {
        path,
        message: `must be greater than ${schema.exclusiveMinimum}`,
      };
    }
    if (
      typeof schema.exclusiveMaximum === 'number' &&
      value >= schema.exclusiveMaximum
    ) {
      return {
        path,
        message: `must be less than ${schema.exclusiveMaximum}`,
      };
    }
    if (
      typeof schema.multipleOf === 'number' &&
      Math.abs(value / schema.multipleOf -
        Math.round(value / schema.multipleOf)) >
        Number.EPSILON * 16
    ) {
      return { path, message: `must be a multiple of ${schema.multipleOf}` };
    }
  }
  return null;
}

function jsonTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        jsonValueEqual(value, right[index]),
      )
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValueEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
