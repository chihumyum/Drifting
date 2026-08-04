/**
 * Strict bridge between canonical AgentModelMessage history and the P4
 * context planner.
 *
 * The bridge intentionally keeps summaries and supplemental runtime facts as
 * first-class context messages. They are not disguised as user text or tool
 * results. A provider adapter must make an explicit decision about how those
 * two message kinds are serialized on its wire protocol.
 */
import {
  AGENT_CONTEXT_CHECKPOINT_FORMAT,
  AGENT_CONTEXT_CHECKPOINT_VERSION,
  estimateAgentContextTextTokens,
  hashAgentContextSourceRows,
  planAgentContext,
  type AgentContextCheckpointV2,
  type AgentContextDurableWriteEvidence,
  type AgentContextPlan,
  type AgentContextPlannerInput,
  type AgentContextPlannerResult,
  type AgentContextProjectionSegment,
  type AgentContextSourceKind,
  type AgentContextSourceRow,
  type AgentContextToolAccess,
  type AgentContextTokenEstimator,
} from './context-planner';
import {
  isCanonicalAgentRuntimeUnknownToolResult,
  type AgentAssistantContentBlock,
  type AgentAssistantToolCallBlock,
  type AgentModelMessage,
  type AgentModelToolDefinition,
  type AgentToolResultBlock,
} from './types';

export const AGENT_CONTEXT_PROVIDER_ENVELOPE_VERSION = 2 as const;
export const AGENT_CONTEXT_PROVIDER_ENVELOPE_FORMAT =
  'drifting.agent-context-provider-envelope' as const;

const CANONICAL_SOURCE_PREFIX = 'model';
const SUPPLEMENTAL_KINDS = new Set<AgentContextSupplementalKind>([
  'write_receipt',
  'write_review',
  'write_revert',
  'read_progress',
  'freshness',
  'task_plan',
  'task_constraints',
]);
const SOURCE_KINDS = new Set<AgentContextSourceKind>([
  'system_policy',
  'user',
  'assistant_narrative',
  'thinking',
  'tool_call',
  'tool_result',
  'write_receipt',
  'write_review',
  'write_revert',
  'read_progress',
  'freshness',
  'task_plan',
  'task_constraints',
]);

export type AgentContextSupplementalKind =
  | 'write_receipt'
  | 'write_review'
  | 'write_revert'
  | 'read_progress'
  | 'freshness'
  | 'task_plan'
  | 'task_constraints';

export interface AgentContextSupplementalPinnedRow {
  /** Caller-owned durable id. It must remain stable across recovery. */
  sourceId: string;
  turnOrdinal: number | null;
  kind: AgentContextSupplementalKind;
  /** Exact fact/review/revert payload. Never rewritten by this bridge. */
  content: string;
  /**
   * Product-owned durable provenance. The bridge strips this metadata from the
   * provider projection and the planner accepts only exact write-pair matches.
   */
  durableWriteCoverage?: readonly {
    turnOrdinal: number;
    callId: string;
    toolName: string;
  }[];
}

export type AgentContextToolAccessResolver = (
  toolName: string,
) => 'read' | 'write' | null | undefined;

export type AgentContextSourceBinding =
  | {
      sourceId: string;
      origin: 'system';
    }
  | {
      sourceId: string;
      origin: 'message';
      messageOrdinal: number;
      blockOrdinal: number;
      role: AgentModelMessage['role'];
      blockType: 'user' | AgentAssistantContentBlock['type'] | 'tool_result';
    }
  | {
      sourceId: string;
      origin: 'supplemental';
      noteKind: AgentContextSupplementalKind;
    };

export interface AgentContextCanonicalBridge {
  sourceRows: AgentContextSourceRow[];
  bindings: AgentContextSourceBinding[];
}

export interface AgentContextCanonicalProviderMessage {
  type: 'model_message';
  /** Exact planner sources represented by this canonical message. */
  sourceIds: string[];
  /** Canonical provider-neutral history, with no synthetic tool results. */
  message: AgentModelMessage;
}

export interface AgentContextSummaryProviderMessage {
  type: 'context_summary';
  summaryId: string;
  sourceIds: string[];
  sourceHash: string;
  /** Exact verified summary text returned to the planner. */
  content: string;
}

export interface AgentContextNoteProviderMessage {
  type: 'context_note';
  noteKind: AgentContextSupplementalKind;
  sourceId: string;
  turnOrdinal: number | null;
  /** Exact durable runtime note payload. */
  content: string;
}

export type AgentContextProviderMessage =
  | AgentContextCanonicalProviderMessage
  | AgentContextSummaryProviderMessage
  | AgentContextNoteProviderMessage;

type WorkingProviderMessage =
  | (AgentContextCanonicalProviderMessage & { messageOrdinal: number })
  | AgentContextSummaryProviderMessage
  | AgentContextNoteProviderMessage;

type WorkingAssistantProviderMessage = AgentContextCanonicalProviderMessage & {
  messageOrdinal: number;
  message: Extract<AgentModelMessage, { role: 'assistant' }>;
};

type WorkingToolProviderMessage = AgentContextCanonicalProviderMessage & {
  messageOrdinal: number;
  message: Extract<AgentModelMessage, { role: 'tool' }>;
};

export interface AgentContextProviderProjection {
  /** Exact system policy from the canonical source. */
  systemPrompt: string;
  messages: AgentContextProviderMessage[];
}

export interface AgentContextSourceManifestEntry {
  sourceId: string;
  ordinal: number;
  turnOrdinal: number | null;
  kind: AgentContextSourceKind;
  sourceHash: string;
}

export interface AgentContextProviderEnvelopeV2 {
  schemaVersion: typeof AGENT_CONTEXT_PROVIDER_ENVELOPE_VERSION;
  format: typeof AGENT_CONTEXT_PROVIDER_ENVELOPE_FORMAT;
  plannerCheckpoint: AgentContextCheckpointV2;
  sourceBindings: AgentContextSourceBinding[];
  sourceManifest: AgentContextSourceManifestEntry[];
  providerContext: AgentContextProviderProjection;
  integrity: {
    bindingHash: string;
    providerContextHash: string;
    envelopeHash: string;
  };
}

export type AgentContextMessageBridgeFailureCode =
  | 'INVALID_MODEL_CONTEXT'
  | 'INVALID_TOOL_TOPOLOGY'
  | 'UNKNOWN_TOOL_ACCESS'
  | 'INVALID_PROJECTION'
  | 'INVALID_ENVELOPE'
  | 'HASH_UNAVAILABLE';

export class AgentContextMessageBridgeError extends Error {
  constructor(
    readonly code: AgentContextMessageBridgeFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentContextMessageBridgeError';
  }
}

export interface AgentModelContextPlanningInput {
  systemPrompt: string;
  messages: readonly AgentModelMessage[];
  resolveToolAccess: AgentContextToolAccessResolver;
  supplementalRows?: readonly AgentContextSupplementalPinnedRow[];
  planner: Omit<AgentContextPlannerInput, 'sourceRows'>;
}

export type AgentModelContextPlanningResult =
  | {
      ok: true;
      bridge: AgentContextCanonicalBridge;
      plan: AgentContextPlan;
      envelope: AgentContextProviderEnvelopeV2;
    }
  | Extract<AgentContextPlannerResult, { ok: false }>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ToolCallTopology {
  callId: string;
  name: string;
  access: AgentContextToolAccess;
  policyAccess: 'read' | 'write' | null;
  sourceRow: AgentContextSourceRow;
  turnOrdinal: number;
  resolved: boolean;
}

function failure(code: AgentContextMessageBridgeFailureCode, message: string): never {
  throw new AgentContextMessageBridgeError(code, message);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    failure('INVALID_MODEL_CONTEXT', `${label} must be a non-empty string.`);
  }
  return value;
}

function canonicalJsonValue(
  value: unknown,
  path = 'value',
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      failure('INVALID_MODEL_CONTEXT', `${path} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    failure('INVALID_MODEL_CONTEXT', `${path} contains unsupported ${typeof value}.`);
  }
  if (ancestors.has(value)) {
    failure('INVALID_MODEL_CONTEXT', `${path} contains a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`, ancestors));
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        failure('INVALID_MODEL_CONTEXT', `${path}.${key} is undefined.`);
      }
      output[key] = canonicalJsonValue(child, `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Canonical(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    failure(
      'HASH_UNAVAILABLE',
      'Web Crypto SHA-256 is unavailable; provider context cannot be verified.',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${bytesToHex(digest)}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function serializeToolBlock(
  value: AgentAssistantToolCallBlock | AgentToolResultBlock,
  label: string,
): string {
  return canonicalJson(canonicalJsonValue(value, label));
}

function parseToolCall(content: string, label: string): AgentAssistantToolCallBlock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    failure('INVALID_PROJECTION', `${label} is not valid JSON.`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { type?: unknown }).type !== 'tool_call' ||
    typeof (parsed as { callId?: unknown }).callId !== 'string' ||
    typeof (parsed as { name?: unknown }).name !== 'string' ||
    typeof (parsed as { rawArguments?: unknown }).rawArguments !== 'string' ||
    !(parsed as { arguments?: unknown }).arguments ||
    typeof (parsed as { arguments?: unknown }).arguments !== 'object' ||
    Array.isArray((parsed as { arguments?: unknown }).arguments)
  ) {
    failure('INVALID_PROJECTION', `${label} is not a canonical tool call.`);
  }
  canonicalJsonValue(parsed, label);
  return parsed as AgentAssistantToolCallBlock;
}

function parseToolResult(content: string, label: string): AgentToolResultBlock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    failure('INVALID_PROJECTION', `${label} is not valid JSON.`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { callId?: unknown }).callId !== 'string' ||
    typeof (parsed as { name?: unknown }).name !== 'string' ||
    typeof (parsed as { ok?: unknown }).ok !== 'boolean' ||
    typeof (parsed as { content?: unknown }).content !== 'string' ||
    ((parsed as { source?: unknown }).source !== undefined &&
      (parsed as { source?: unknown }).source !== 'runtime') ||
    ((parsed as { errorCode?: unknown }).errorCode !== undefined &&
      (parsed as { errorCode?: unknown }).errorCode !== 'UNKNOWN_TOOL') ||
    Object.keys(parsed as Record<string, unknown>).some(
      (key) =>
        key !== 'callId' &&
        key !== 'name' &&
        key !== 'ok' &&
        key !== 'content' &&
        key !== 'source' &&
        key !== 'errorCode',
    )
  ) {
    failure('INVALID_PROJECTION', `${label} is not a canonical tool result.`);
  }
  canonicalJsonValue(parsed, label);
  const result = parsed as AgentToolResultBlock;
  if (
    (result.source !== undefined || result.errorCode !== undefined) &&
    !isCanonicalAgentRuntimeUnknownToolResult(result)
  ) {
    failure('INVALID_PROJECTION', `${label} has invalid runtime-denial provenance.`);
  }
  return result;
}

function sourceIdForMessage(
  messageOrdinal: number,
  role: AgentModelMessage['role'],
  blockOrdinal: number,
  blockType: string,
): string {
  return `${CANONICAL_SOURCE_PREFIX}/message/${messageOrdinal}/${role}/${blockOrdinal}/${blockType}`;
}

function unresolvedCalls(topology: ReadonlyMap<string, ToolCallTopology>): ToolCallTopology[] {
  return [...topology.values()].filter((call) => !call.resolved);
}

function validateResolvedBeforeNextMessage(
  topology: ReadonlyMap<string, ToolCallTopology>,
  role: AgentModelMessage['role'],
  messageOrdinal: number,
): void {
  const pending = unresolvedCalls(topology);
  if (pending.length > 0 && role !== 'tool') {
    failure(
      'INVALID_TOOL_TOPOLOGY',
      `Message ${messageOrdinal} (${role}) appears before ${pending.length} tool result(s).`,
    );
  }
}

function resolveAccess(
  resolver: AgentContextToolAccessResolver,
  toolName: string,
): 'read' | 'write' | null {
  let access: ReturnType<AgentContextToolAccessResolver>;
  try {
    access = resolver(toolName);
  } catch {
    failure('UNKNOWN_TOOL_ACCESS', `Tool access resolver failed for "${toolName}".`);
  }
  return access === 'read' || access === 'write' ? access : null;
}

/**
 * Deterministically split provider-neutral model history into planner rows.
 * `callId` is scoped to `turnOrdinal`, so providers may reuse it in later
 * turns, but never twice in one turn.
 */
export function agentModelMessagesToContextSources(input: {
  systemPrompt: string;
  messages: readonly AgentModelMessage[];
  resolveToolAccess: AgentContextToolAccessResolver;
  supplementalRows?: readonly AgentContextSupplementalPinnedRow[];
}): AgentContextCanonicalBridge {
  if (typeof input.systemPrompt !== 'string' || input.systemPrompt.length === 0) {
    failure('INVALID_MODEL_CONTEXT', 'A non-empty canonical system prompt is required.');
  }
  if (!Array.isArray(input.messages)) {
    failure('INVALID_MODEL_CONTEXT', 'Canonical messages must be an array.');
  }

  const sourceRows: AgentContextSourceRow[] = [];
  const bindings: AgentContextSourceBinding[] = [];
  const sourceIds = new Set<string>();
  const topology = new Map<string, ToolCallTopology>();
  let ordinal = 0;
  let turnOrdinal = -1;

  const add = (
    row: Omit<AgentContextSourceRow, 'ordinal'>,
    binding: AgentContextSourceBinding,
  ): AgentContextSourceRow => {
    if (!row.sourceId || sourceIds.has(row.sourceId)) {
      failure('INVALID_MODEL_CONTEXT', `Duplicate or empty source id "${row.sourceId}".`);
    }
    sourceIds.add(row.sourceId);
    const added = { ...row, ordinal };
    sourceRows.push(added);
    bindings.push(binding);
    ordinal += 1;
    return added;
  };

  const systemSourceId = `${CANONICAL_SOURCE_PREFIX}/system`;
  add(
    {
      sourceId: systemSourceId,
      turnOrdinal: null,
      kind: 'system_policy',
      content: input.systemPrompt,
    },
    { sourceId: systemSourceId, origin: 'system' },
  );

  for (let messageOrdinal = 0; messageOrdinal < input.messages.length; messageOrdinal += 1) {
    const message = input.messages[messageOrdinal];
    if (
      !message ||
      (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')
    ) {
      failure('INVALID_MODEL_CONTEXT', `Message ${messageOrdinal} has an unsupported role.`);
    }
    validateResolvedBeforeNextMessage(topology, message.role, messageOrdinal);

    if (message.role === 'user') {
      if (typeof message.content !== 'string') {
        failure(
          'INVALID_MODEL_CONTEXT',
          `User message ${messageOrdinal} content must be a string.`,
        );
      }
      turnOrdinal += 1;
      const sourceId = sourceIdForMessage(messageOrdinal, message.role, 0, 'user');
      add(
        {
          sourceId,
          turnOrdinal,
          kind: 'user',
          content: message.content,
        },
        {
          sourceId,
          origin: 'message',
          messageOrdinal,
          blockOrdinal: 0,
          role: 'user',
          blockType: 'user',
        },
      );
      continue;
    }

    if (turnOrdinal < 0) {
      failure(
        'INVALID_MODEL_CONTEXT',
        `Message ${messageOrdinal} appears before the first user turn.`,
      );
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      failure(
        'INVALID_MODEL_CONTEXT',
        `${message.role} message ${messageOrdinal} must contain at least one block.`,
      );
    }

    if (message.role === 'assistant') {
      for (let blockOrdinal = 0; blockOrdinal < message.content.length; blockOrdinal += 1) {
        const block = message.content[blockOrdinal];
        if (!block || typeof block !== 'object') {
          failure(
            'INVALID_MODEL_CONTEXT',
            `Assistant block ${messageOrdinal}/${blockOrdinal} is invalid.`,
          );
        }
        if (block.type === 'text' || block.type === 'thinking') {
          if (typeof block.text !== 'string') {
            failure(
              'INVALID_MODEL_CONTEXT',
              `Assistant ${block.type} ${messageOrdinal}/${blockOrdinal} must be a string.`,
            );
          }
          const sourceId = sourceIdForMessage(
            messageOrdinal,
            message.role,
            blockOrdinal,
            block.type,
          );
          add(
            {
              sourceId,
              turnOrdinal,
              kind: block.type === 'text' ? 'assistant_narrative' : 'thinking',
              content: block.text,
            },
            {
              sourceId,
              origin: 'message',
              messageOrdinal,
              blockOrdinal,
              role: 'assistant',
              blockType: block.type,
            },
          );
          continue;
        }
        if (block.type !== 'tool_call') {
          failure(
            'INVALID_MODEL_CONTEXT',
            `Assistant block ${messageOrdinal}/${blockOrdinal} has an unsupported type.`,
          );
        }
        const callId = requireNonEmptyString(
          block.callId,
          `Tool call ${messageOrdinal}/${blockOrdinal} id`,
        );
        const name = requireNonEmptyString(
          block.name,
          `Tool call ${messageOrdinal}/${blockOrdinal} name`,
        );
        if (
          !block.arguments ||
          typeof block.arguments !== 'object' ||
          Array.isArray(block.arguments) ||
          typeof block.rawArguments !== 'string'
        ) {
          failure(
            'INVALID_MODEL_CONTEXT',
            `Tool call ${messageOrdinal}/${blockOrdinal} arguments are invalid.`,
          );
        }
        canonicalJsonValue(
          block.arguments,
          `messages[${messageOrdinal}].content[${blockOrdinal}].arguments`,
        );
        const key = `${turnOrdinal}:${callId}`;
        if (topology.has(key)) {
          failure(
            'INVALID_TOOL_TOPOLOGY',
            `Tool call id "${callId}" is reused inside turn ${turnOrdinal}.`,
          );
        }
        const policyAccess = resolveAccess(input.resolveToolAccess, name);
        const access: AgentContextToolAccess = policyAccess ?? 'denied';
        const sourceId = sourceIdForMessage(messageOrdinal, message.role, blockOrdinal, block.type);
        const sourceRow = add(
          {
            sourceId,
            turnOrdinal,
            kind: 'tool_call',
            content: serializeToolBlock(
              block,
              `messages[${messageOrdinal}].content[${blockOrdinal}]`,
            ),
            callId,
            toolName: name,
            toolAccess: access,
          },
          {
            sourceId,
            origin: 'message',
            messageOrdinal,
            blockOrdinal,
            role: 'assistant',
            blockType: 'tool_call',
          },
        );
        topology.set(key, {
          callId,
          name,
          access,
          policyAccess,
          sourceRow,
          turnOrdinal,
          resolved: false,
        });
      }
      continue;
    }

    for (let blockOrdinal = 0; blockOrdinal < message.content.length; blockOrdinal += 1) {
      const result = message.content[blockOrdinal];
      if (!result || typeof result !== 'object') {
        failure(
          'INVALID_MODEL_CONTEXT',
          `Tool result ${messageOrdinal}/${blockOrdinal} is invalid.`,
        );
      }
      const callId = requireNonEmptyString(
        result.callId,
        `Tool result ${messageOrdinal}/${blockOrdinal} call id`,
      );
      const name = requireNonEmptyString(
        result.name,
        `Tool result ${messageOrdinal}/${blockOrdinal} name`,
      );
      if (
        typeof result.ok !== 'boolean' ||
        typeof result.content !== 'string' ||
        (result.source !== undefined && result.source !== 'runtime') ||
        (result.errorCode !== undefined && result.errorCode !== 'UNKNOWN_TOOL') ||
        Object.keys(result).some(
          (key) =>
            key !== 'callId' &&
            key !== 'name' &&
            key !== 'ok' &&
            key !== 'content' &&
            key !== 'source' &&
            key !== 'errorCode',
        )
      ) {
        failure(
          'INVALID_MODEL_CONTEXT',
          `Tool result ${messageOrdinal}/${blockOrdinal} payload is invalid.`,
        );
      }
      const key = `${turnOrdinal}:${callId}`;
      const call = topology.get(key);
      if (!call || call.resolved || call.name !== name) {
        failure(
          'INVALID_TOOL_TOPOLOGY',
          `Tool result "${key}" is orphaned, duplicated, or name-mismatched.`,
        );
      }
      const carriesDenialProvenance = result.source !== undefined || result.errorCode !== undefined;
      const isDenied = isCanonicalAgentRuntimeUnknownToolResult(result);
      if (carriesDenialProvenance && !isDenied) {
        failure(
          'UNKNOWN_TOOL_ACCESS',
          `Tool result "${key}" has forged or incomplete runtime-denial provenance.`,
        );
      }
      if (isDenied) {
        call.access = 'denied';
        call.sourceRow.toolAccess = 'denied';
      } else if (call.policyAccess === null) {
        failure(
          'UNKNOWN_TOOL_ACCESS',
          `Tool "${call.name}" has no policy-resolved access or canonical runtime denial.`,
        );
      } else {
        call.access = call.policyAccess;
        call.sourceRow.toolAccess = call.policyAccess;
      }
      call.resolved = true;
      const sourceId = sourceIdForMessage(
        messageOrdinal,
        message.role,
        blockOrdinal,
        'tool_result',
      );
      add(
        {
          sourceId,
          turnOrdinal,
          kind: 'tool_result',
          content: serializeToolBlock(
            result,
            `messages[${messageOrdinal}].content[${blockOrdinal}]`,
          ),
          callId,
          toolName: name,
          toolAccess: call.access,
        },
        {
          sourceId,
          origin: 'message',
          messageOrdinal,
          blockOrdinal,
          role: 'tool',
          blockType: 'tool_result',
        },
      );
    }
  }

  const dangling = unresolvedCalls(topology);
  if (dangling.length > 0) {
    failure(
      'INVALID_TOOL_TOPOLOGY',
      `Canonical history contains ${dangling.length} dangling tool call(s).`,
    );
  }

  for (const supplemental of input.supplementalRows ?? []) {
    if (
      !supplemental ||
      !SUPPLEMENTAL_KINDS.has(supplemental.kind) ||
      typeof supplemental.content !== 'string'
    ) {
      failure('INVALID_MODEL_CONTEXT', 'Supplemental context row is invalid.');
    }
    requireNonEmptyString(supplemental.sourceId, 'Supplemental source id');
    if (
      supplemental.kind === 'freshness' ||
      supplemental.kind === 'task_plan' ||
      supplemental.kind === 'task_constraints'
        ? supplemental.turnOrdinal !== null
        : supplemental.turnOrdinal === null ||
          !Number.isSafeInteger(supplemental.turnOrdinal) ||
          supplemental.turnOrdinal < 0 ||
          supplemental.turnOrdinal > turnOrdinal
    ) {
      failure(
        'INVALID_MODEL_CONTEXT',
        `Supplemental "${supplemental.sourceId}" has invalid turn ownership.`,
      );
    }
    add(
      {
        sourceId: supplemental.sourceId,
        turnOrdinal: supplemental.turnOrdinal,
        kind: supplemental.kind,
        content: supplemental.content,
      },
      {
        sourceId: supplemental.sourceId,
        origin: 'supplemental',
        noteKind: supplemental.kind,
      },
    );
  }

  return {
    sourceRows: sourceRows.map((row) => ({ ...row })),
    bindings: bindings.map((binding) => ({ ...binding })),
  };
}

function bindingMap(
  bindings: readonly AgentContextSourceBinding[],
): Map<string, AgentContextSourceBinding> {
  const output = new Map<string, AgentContextSourceBinding>();
  for (const binding of bindings) {
    if (!binding.sourceId || output.has(binding.sourceId)) {
      failure('INVALID_PROJECTION', `Duplicate or empty binding source id "${binding.sourceId}".`);
    }
    output.set(binding.sourceId, binding);
  }
  return output;
}

function appendCanonicalSource(
  output: WorkingProviderMessage[],
  segment: Extract<AgentContextProjectionSegment, { type: 'source' }>,
  binding: Extract<AgentContextSourceBinding, { origin: 'message' }>,
): void {
  const row = segment.row;
  const last = output[output.length - 1];
  if (binding.role === 'user') {
    if (row.kind !== 'user' || binding.blockType !== 'user') {
      failure(
        'INVALID_PROJECTION',
        `User binding "${row.sourceId}" does not match its source kind.`,
      );
    }
    output.push({
      type: 'model_message',
      sourceIds: [row.sourceId],
      message: { role: 'user', content: row.content },
      messageOrdinal: binding.messageOrdinal,
    });
    return;
  }

  if (binding.role === 'assistant') {
    let block: AgentAssistantContentBlock;
    if (binding.blockType === 'text' && row.kind === 'assistant_narrative') {
      block = { type: 'text', text: row.content };
    } else if (binding.blockType === 'thinking' && row.kind === 'thinking') {
      block = { type: 'thinking', text: row.content };
    } else if (binding.blockType === 'tool_call' && row.kind === 'tool_call') {
      const call = parseToolCall(row.content, `Source "${row.sourceId}"`);
      if (
        call.callId !== row.callId ||
        call.name !== row.toolName ||
        (row.toolAccess !== 'read' && row.toolAccess !== 'write' && row.toolAccess !== 'denied')
      ) {
        failure('INVALID_PROJECTION', `Tool call source "${row.sourceId}" metadata drifted.`);
      }
      block = call;
    } else {
      failure(
        'INVALID_PROJECTION',
        `Assistant binding "${row.sourceId}" does not match its source kind.`,
      );
    }
    const priorAssistant =
      last?.type === 'model_message' &&
      last.messageOrdinal === binding.messageOrdinal &&
      last.message.role === 'assistant'
        ? (last as WorkingAssistantProviderMessage)
        : null;
    if (priorAssistant) {
      priorAssistant.sourceIds.push(row.sourceId);
      priorAssistant.message.content.push(block);
    } else {
      output.push({
        type: 'model_message',
        sourceIds: [row.sourceId],
        message: { role: 'assistant', content: [block] },
        messageOrdinal: binding.messageOrdinal,
      });
    }
    return;
  }

  if (binding.blockType !== 'tool_result' || row.kind !== 'tool_result') {
    failure('INVALID_PROJECTION', `Tool binding "${row.sourceId}" does not match its source kind.`);
  }
  const result = parseToolResult(row.content, `Source "${row.sourceId}"`);
  if (
    result.callId !== row.callId ||
    result.name !== row.toolName ||
    (row.toolAccess !== 'read' && row.toolAccess !== 'write' && row.toolAccess !== 'denied')
  ) {
    failure('INVALID_PROJECTION', `Tool result source "${row.sourceId}" metadata drifted.`);
  }
  const priorTool =
    last?.type === 'model_message' &&
    last.messageOrdinal === binding.messageOrdinal &&
    last.message.role === 'tool'
      ? (last as WorkingToolProviderMessage)
      : null;
  if (priorTool) {
    priorTool.sourceIds.push(row.sourceId);
    priorTool.message.content.push(result);
  } else {
    output.push({
      type: 'model_message',
      sourceIds: [row.sourceId],
      message: { role: 'tool', content: [result] },
      messageOrdinal: binding.messageOrdinal,
    });
  }
}

function validateDirectProjectedToolTopology(
  segments: readonly AgentContextProjectionSegment[],
): void {
  const calls = new Map<string, AgentContextSourceRow>();
  const results = new Map<string, AgentContextSourceRow>();
  for (const segment of segments) {
    if (
      segment.type !== 'source' ||
      (segment.row.kind !== 'tool_call' && segment.row.kind !== 'tool_result')
    ) {
      continue;
    }
    const row = segment.row;
    const key = `${row.turnOrdinal}:${row.callId}`;
    const target = row.kind === 'tool_call' ? calls : results;
    if (target.has(key)) {
      failure('INVALID_PROJECTION', `Projected context duplicates ${row.kind} "${key}".`);
    }
    target.set(key, row);
  }
  for (const key of new Set([...calls.keys(), ...results.keys()])) {
    const call = calls.get(key);
    const result = results.get(key);
    if (
      !call ||
      !result ||
      call.ordinal >= result.ordinal ||
      call.toolName !== result.toolName ||
      call.toolAccess !== result.toolAccess
    ) {
      failure(
        'INVALID_PROJECTION',
        `Projected context contains a split or mismatched tool pair "${key}".`,
      );
    }
  }
}

/**
 * Restore a planner projection into explicit provider-neutral context.
 * Summaries and runtime facts stay first-class and therefore cannot become
 * forged tool results.
 */
export function projectAgentContextToProvider(input: {
  segments: readonly AgentContextProjectionSegment[];
  bindings: readonly AgentContextSourceBinding[];
}): AgentContextProviderProjection {
  validateDirectProjectedToolTopology(input.segments);
  const bindings = bindingMap(input.bindings);
  const output: WorkingProviderMessage[] = [];
  const covered = new Set<string>();
  let systemPrompt: string | null = null;

  for (const segment of input.segments) {
    if (segment.type === 'summary') {
      for (const sourceId of segment.sourceIds) {
        if (!bindings.has(sourceId) || covered.has(sourceId)) {
          failure(
            'INVALID_PROJECTION',
            `Summary "${segment.summaryId}" has unknown or duplicate coverage "${sourceId}".`,
          );
        }
        covered.add(sourceId);
      }
      output.push({
        type: 'context_summary',
        summaryId: segment.summaryId,
        sourceIds: [...segment.sourceIds],
        sourceHash: segment.sourceHash,
        content: segment.content,
      });
      continue;
    }

    const row = segment.row;
    const binding = bindings.get(row.sourceId);
    if (!binding || covered.has(row.sourceId)) {
      failure('INVALID_PROJECTION', `Projected source "${row.sourceId}" has no unique binding.`);
    }
    covered.add(row.sourceId);
    if (binding.origin === 'system') {
      if (row.kind !== 'system_policy' || systemPrompt !== null) {
        failure(
          'INVALID_PROJECTION',
          'Provider projection must contain exactly one system policy.',
        );
      }
      systemPrompt = row.content;
      continue;
    }
    if (binding.origin === 'supplemental') {
      if (row.kind !== binding.noteKind || !SUPPLEMENTAL_KINDS.has(binding.noteKind)) {
        failure('INVALID_PROJECTION', `Supplemental binding "${row.sourceId}" drifted.`);
      }
      output.push({
        type: 'context_note',
        noteKind: binding.noteKind,
        sourceId: row.sourceId,
        turnOrdinal: row.turnOrdinal,
        content: row.content,
      });
      continue;
    }
    appendCanonicalSource(output, segment, binding);
  }

  if (systemPrompt === null) {
    failure('INVALID_PROJECTION', 'Provider projection is missing its exact system policy.');
  }
  return {
    systemPrompt,
    messages: output.map((message) =>
      message.type === 'model_message'
        ? cloneJson({
            type: message.type,
            sourceIds: message.sourceIds,
            message: message.message,
          })
        : cloneJson(message),
    ),
  };
}

/**
 * Estimate the non-history part of one provider request. Callers should pass a
 * provider tokenizer when available and include any provider-specific framing
 * in `providerOverheadTokens`.
 */
export function estimateAgentContextFixedInputTokens(input: {
  tools: readonly AgentModelToolDefinition[];
  providerOverheadTokens: number;
  perToolOverheadTokens?: number;
  estimateTokens?: AgentContextTokenEstimator;
}): number {
  if (!Number.isSafeInteger(input.providerOverheadTokens) || input.providerOverheadTokens < 0) {
    failure('INVALID_MODEL_CONTEXT', 'Provider overhead must be a non-negative safe integer.');
  }
  const perToolOverheadTokens = input.perToolOverheadTokens ?? 8;
  if (!Number.isSafeInteger(perToolOverheadTokens) || perToolOverheadTokens < 0) {
    failure('INVALID_MODEL_CONTEXT', 'Per-tool overhead must be a non-negative safe integer.');
  }
  const estimator = input.estimateTokens ?? estimateAgentContextTextTokens;
  const names = new Set<string>();
  let total = input.providerOverheadTokens;
  for (const tool of input.tools) {
    requireNonEmptyString(tool.name, 'Tool definition name');
    if (names.has(tool.name)) {
      failure('INVALID_MODEL_CONTEXT', `Duplicate provider tool definition "${tool.name}".`);
    }
    names.add(tool.name);
    if (typeof tool.description !== 'string') {
      failure('INVALID_MODEL_CONTEXT', `Tool "${tool.name}" description must be a string.`);
    }
    const encoded = canonicalJson({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    const estimate = estimator(encoded);
    if (!Number.isSafeInteger(estimate) || estimate < 0) {
      failure('INVALID_MODEL_CONTEXT', 'Fixed-input token estimator returned an invalid value.');
    }
    total += estimate + perToolOverheadTokens;
    if (!Number.isSafeInteger(total)) {
      failure('INVALID_MODEL_CONTEXT', 'Fixed provider input token estimate overflowed.');
    }
  }
  return total;
}

function cloneBinding(binding: AgentContextSourceBinding): AgentContextSourceBinding {
  return { ...binding };
}

function cloneCheckpoint(checkpoint: AgentContextCheckpointV2): AgentContextCheckpointV2 {
  return cloneJson(checkpoint);
}

function envelopeBody(
  envelope: Omit<AgentContextProviderEnvelopeV2, 'integrity'> & {
    integrity: Omit<AgentContextProviderEnvelopeV2['integrity'], 'envelopeHash'>;
  },
): unknown {
  return envelope;
}

async function sourceManifest(
  rows: readonly AgentContextSourceRow[],
): Promise<AgentContextSourceManifestEntry[]> {
  return await Promise.all(
    [...rows]
      .sort(
        (left, right) =>
          left.ordinal - right.ordinal || left.sourceId.localeCompare(right.sourceId),
      )
      .map(async (row) => ({
        sourceId: row.sourceId,
        ordinal: row.ordinal,
        turnOrdinal: row.turnOrdinal,
        kind: row.kind,
        sourceHash: await hashAgentContextSourceRows([row]),
      })),
  );
}

function validateBindingsAgainstRows(
  rows: readonly AgentContextSourceRow[],
  bindings: readonly AgentContextSourceBinding[],
): void {
  const byId = bindingMap(bindings);
  if (rows.length !== bindings.length) {
    failure('INVALID_ENVELOPE', 'Canonical source and binding counts do not match.');
  }
  for (const row of rows) {
    const binding = byId.get(row.sourceId);
    if (!binding) {
      failure('INVALID_ENVELOPE', `Canonical source "${row.sourceId}" has no binding.`);
    }
    if (
      (binding.origin === 'system' && row.kind !== 'system_policy') ||
      (binding.origin === 'supplemental' && row.kind !== binding.noteKind) ||
      (binding.origin === 'message' &&
        ((binding.role === 'user' && row.kind !== 'user') ||
          (binding.role === 'assistant' &&
            binding.blockType === 'text' &&
            row.kind !== 'assistant_narrative') ||
          (binding.role === 'assistant' &&
            binding.blockType === 'thinking' &&
            row.kind !== 'thinking') ||
          (binding.role === 'assistant' &&
            binding.blockType === 'tool_call' &&
            row.kind !== 'tool_call') ||
          (binding.role === 'tool' && row.kind !== 'tool_result')))
    ) {
      failure('INVALID_ENVELOPE', `Canonical source "${row.sourceId}" binding kind drifted.`);
    }
  }
}

/** Create a self-hashed durable V2 envelope for the exact planned call. */
export async function createAgentContextProviderEnvelope(input: {
  bridge: AgentContextCanonicalBridge;
  plan: AgentContextPlan;
}): Promise<AgentContextProviderEnvelopeV2> {
  validateBindingsAgainstRows(input.bridge.sourceRows, input.bridge.bindings);
  const canonicalHash = await hashAgentContextSourceRows(input.bridge.sourceRows);
  if (
    input.plan.checkpoint.schemaVersion !== AGENT_CONTEXT_CHECKPOINT_VERSION ||
    input.plan.checkpoint.format !== AGENT_CONTEXT_CHECKPOINT_FORMAT ||
    input.plan.checkpoint.canonicalSources.sourceCount !== input.bridge.sourceRows.length ||
    input.plan.checkpoint.canonicalSources.sourceOrderHash !== canonicalHash ||
    canonicalJson(input.plan.checkpoint.projection.segments) !== canonicalJson(input.plan.segments)
  ) {
    failure('INVALID_ENVELOPE', 'Planner checkpoint does not match the canonical bridge or plan.');
  }

  const sourceBindings = input.bridge.bindings.map(cloneBinding);
  const providerContext = projectAgentContextToProvider({
    segments: input.plan.segments,
    bindings: sourceBindings,
  });
  const body = {
    schemaVersion: AGENT_CONTEXT_PROVIDER_ENVELOPE_VERSION,
    format: AGENT_CONTEXT_PROVIDER_ENVELOPE_FORMAT,
    plannerCheckpoint: cloneCheckpoint(input.plan.checkpoint),
    sourceBindings,
    sourceManifest: await sourceManifest(input.bridge.sourceRows),
    providerContext,
    integrity: {
      bindingHash: await sha256Canonical(sourceBindings),
      providerContextHash: await sha256Canonical(providerContext),
    },
  } satisfies Omit<AgentContextProviderEnvelopeV2, 'integrity'> & {
    integrity: Omit<AgentContextProviderEnvelopeV2['integrity'], 'envelopeHash'>;
  };
  return {
    ...body,
    integrity: {
      ...body.integrity,
      envelopeHash: await sha256Canonical(envelopeBody(body)),
    },
  };
}

function validateUniqueIds(ids: readonly string[], label: string): Set<string> {
  const output = new Set<string>();
  for (const id of ids) {
    if (!id || output.has(id)) {
      failure('INVALID_ENVELOPE', `${label} contains duplicate/empty ids.`);
    }
    output.add(id);
  }
  return output;
}

async function validateEnvelopeCoverage(envelope: AgentContextProviderEnvelopeV2): Promise<void> {
  const checkpoint = envelope.plannerCheckpoint;
  const manifestIds = validateUniqueIds(
    envelope.sourceManifest.map((entry) => entry.sourceId),
    'Source manifest',
  );
  const bindingIds = validateUniqueIds(
    envelope.sourceBindings.map((binding) => binding.sourceId),
    'Source bindings',
  );
  if (
    manifestIds.size !== checkpoint.canonicalSources.sourceCount ||
    bindingIds.size !== manifestIds.size ||
    [...manifestIds].some((sourceId) => !bindingIds.has(sourceId))
  ) {
    failure('INVALID_ENVELOPE', 'Source manifest, bindings, and checkpoint counts do not match.');
  }

  const ordinals = new Set<number>();
  const sourceHashById = new Map<string, string>();
  for (const entry of envelope.sourceManifest) {
    if (
      !Number.isSafeInteger(entry.ordinal) ||
      entry.ordinal < 0 ||
      ordinals.has(entry.ordinal) ||
      (entry.turnOrdinal !== null &&
        (!Number.isSafeInteger(entry.turnOrdinal) || entry.turnOrdinal < 0)) ||
      !SOURCE_KINDS.has(entry.kind) ||
      !entry.sourceHash.startsWith('sha256:')
    ) {
      failure('INVALID_ENVELOPE', 'Source manifest metadata is invalid.');
    }
    ordinals.add(entry.ordinal);
    sourceHashById.set(entry.sourceId, entry.sourceHash);
  }

  const represented = validateUniqueIds(
    checkpoint.coverage.representedSourceIds,
    'Represented coverage',
  );
  const discarded = validateUniqueIds(checkpoint.coverage.discardedSourceIds, 'Discarded coverage');
  if (
    [...represented].some((sourceId) => discarded.has(sourceId) || !manifestIds.has(sourceId)) ||
    [...discarded].some((sourceId) => !manifestIds.has(sourceId)) ||
    represented.size + discarded.size !== manifestIds.size
  ) {
    failure('INVALID_ENVELOPE', 'Represented/discarded coverage is not an exact source partition.');
  }

  const representation = new Map<string, { type: 'source' } | { type: 'summary'; id: string }>();
  for (const segment of checkpoint.projection.segments) {
    if (segment.type === 'source') {
      const sourceId = segment.row.sourceId;
      const actualHash = await hashAgentContextSourceRows([segment.row]);
      if (
        representation.has(sourceId) ||
        sourceHashById.get(sourceId) !== actualHash ||
        segment.sourceHash !== actualHash
      ) {
        failure('INVALID_ENVELOPE', `Projected source "${sourceId}" failed manifest verification.`);
      }
      representation.set(sourceId, { type: 'source' });
      continue;
    }
    if (
      segment.sourceIds.length === 0 ||
      segment.summaryHash !==
        (await sha256Canonical({
          summaryId: segment.summaryId,
          sourceIds: segment.sourceIds,
          content: segment.content,
        }))
    ) {
      failure('INVALID_ENVELOPE', `Summary "${segment.summaryId}" failed hash verification.`);
    }
    for (const sourceId of segment.sourceIds) {
      if (representation.has(sourceId) || !manifestIds.has(sourceId)) {
        failure(
          'INVALID_ENVELOPE',
          `Summary "${segment.summaryId}" has duplicate/unknown coverage.`,
        );
      }
      representation.set(sourceId, {
        type: 'summary',
        id: segment.summaryId,
      });
    }
  }
  if (
    [...represented].some((sourceId) => !representation.has(sourceId)) ||
    [...representation].some(([sourceId]) => !represented.has(sourceId))
  ) {
    failure('INVALID_ENVELOPE', 'Planner projection does not exactly represent declared coverage.');
  }

  const pinnedIds = validateUniqueIds(checkpoint.pinned.sourceIds, 'Pinned sources');
  const pinnedRows = checkpoint.projection.segments.flatMap((segment) =>
    segment.type === 'source' && pinnedIds.has(segment.row.sourceId) ? [segment.row] : [],
  );
  if (
    pinnedRows.length !== pinnedIds.size ||
    checkpoint.pinned.sourceHash !== (await hashAgentContextSourceRows(pinnedRows))
  ) {
    failure('INVALID_ENVELOPE', 'Pinned source bytes or hash were not preserved.');
  }

  const coverageHash = await sha256Canonical(
    checkpoint.coverage.representedSourceIds.map((sourceId) => ({
      sourceId,
      sourceHash: sourceHashById.get(sourceId),
      representation: representation.get(sourceId),
    })),
  );
  if (checkpoint.coverage.coverageHash !== coverageHash) {
    failure('INVALID_ENVELOPE', 'Planner coverage hash drifted.');
  }

  await validateConstraintRetention(checkpoint, envelope.sourceManifest);
}

async function validateConstraintRetention(
  checkpoint: AgentContextCheckpointV2,
  manifest: readonly AgentContextSourceManifestEntry[],
): Promise<void> {
  const ledger = checkpoint.constraintLedger;
  if (
    !ledger ||
    (ledger.mode !== 'legacy_all_user' && ledger.mode !== 'verified') ||
    !Array.isArray(ledger.entries)
  ) {
    failure('INVALID_ENVELOPE', 'Constraint ledger is missing or invalid.');
  }
  const manifestById = new Map(manifest.map((entry) => [entry.sourceId, entry] as const));
  const constraintIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const entry of ledger.entries) {
    const source = manifestById.get(entry.sourceId);
    if (
      !entry.constraintId ||
      constraintIds.has(entry.constraintId) ||
      !entry.sourceId ||
      sourceIds.has(entry.sourceId) ||
      !source ||
      source.kind !== 'user' ||
      source.sourceHash !== entry.sourceHash ||
      (entry.kind !== 'session_goal' &&
        entry.kind !== 'author_instruction' &&
        entry.kind !== 'author_veto' &&
        entry.kind !== 'author_fact' &&
        entry.kind !== 'legacy_user') ||
      (ledger.mode === 'verified' && entry.kind === 'legacy_user')
    ) {
      failure('INVALID_ENVELOPE', 'Constraint ledger provenance drifted.');
    }
    constraintIds.add(entry.constraintId);
    sourceIds.add(entry.sourceId);
  }
  if (ledger.ledgerHash !== (await sha256Canonical(ledger.entries))) {
    failure('INVALID_ENVELOPE', 'Constraint ledger hash drifted.');
  }

  const directlyProjected = new Map(
    checkpoint.projection.segments.flatMap((segment) =>
      segment.type === 'source'
        ? [[segment.row.sourceId, segment.row] as const]
        : [],
    ),
  );
  for (const sourceId of sourceIds) {
    if (!directlyProjected.has(sourceId)) {
      failure(
        'INVALID_ENVELOPE',
        `Critical constraint source "${sourceId}" was not retained byte-exact.`,
      );
    }
  }

  // Legacy V2 checkpoints predate this explicit witness. Their entries are
  // still validated above; every newly planned checkpoint must include it.
  if (!ledger.retentionWitness) return;
  const witnessedIds = validateUniqueIds(
    ledger.retentionWitness.sourceIds,
    'Constraint retention witness',
  );
  if (
    ledger.retentionWitness.status !== 'exact' ||
    witnessedIds.size !== sourceIds.size ||
    [...sourceIds].some((sourceId) => !witnessedIds.has(sourceId))
  ) {
    failure('INVALID_ENVELOPE', 'Constraint retention witness coverage drifted.');
  }
  const witnessedRows = ledger.retentionWitness.sourceIds.map((sourceId) => {
    const row = directlyProjected.get(sourceId);
    if (!row) {
      failure('INVALID_ENVELOPE', 'Constraint retention witness lost a direct source.');
    }
    return row;
  });
  if (
    ledger.retentionWitness.sourceHash !==
    (await hashAgentContextSourceRows(witnessedRows))
  ) {
    failure('INVALID_ENVELOPE', 'Constraint retention witness hash drifted.');
  }
}

function validateCheckpointBudget(checkpoint: AgentContextCheckpointV2): void {
  const budget = checkpoint.budget;
  const reservedOutputTokens = Math.max(budget.requestedOutputTokens, 4_096);
  const safetyMarginTokens = Math.ceil(budget.contextWindowTokens * 0.1);
  const usableInputBudgetTokens =
    budget.contextWindowTokens -
    reservedOutputTokens -
    safetyMarginTokens -
    budget.fixedInputTokens;
  if (
    !Number.isSafeInteger(budget.fixedInputTokens) ||
    budget.fixedInputTokens < 0 ||
    budget.reservedOutputTokens !== reservedOutputTokens ||
    budget.safetyMarginTokens !== safetyMarginTokens ||
    budget.usableInputBudgetTokens !== usableInputBudgetTokens ||
    usableInputBudgetTokens <= 0 ||
    budget.finalEstimatedTokens > usableInputBudgetTokens
  ) {
    failure('INVALID_ENVELOPE', 'Checkpoint no longer satisfies the strict provider input budget.');
  }
}

/**
 * Verify envelope hashes, source coverage, fixed-input budget, and provider
 * projection. Passing canonical rows upgrades verification from the durable
 * manifest to the current source-of-truth bytes.
 */
export async function verifyAgentContextProviderEnvelope(input: {
  envelope: AgentContextProviderEnvelopeV2;
  canonicalSourceRows?: readonly AgentContextSourceRow[];
}): Promise<void> {
  const { envelope } = input;
  if (
    !envelope ||
    envelope.schemaVersion !== AGENT_CONTEXT_PROVIDER_ENVELOPE_VERSION ||
    envelope.format !== AGENT_CONTEXT_PROVIDER_ENVELOPE_FORMAT ||
    envelope.plannerCheckpoint.schemaVersion !== AGENT_CONTEXT_CHECKPOINT_VERSION ||
    envelope.plannerCheckpoint.format !== AGENT_CONTEXT_CHECKPOINT_FORMAT
  ) {
    failure('INVALID_ENVELOPE', 'Unsupported provider context envelope.');
  }

  const body = {
    schemaVersion: envelope.schemaVersion,
    format: envelope.format,
    plannerCheckpoint: envelope.plannerCheckpoint,
    sourceBindings: envelope.sourceBindings,
    sourceManifest: envelope.sourceManifest,
    providerContext: envelope.providerContext,
    integrity: {
      bindingHash: envelope.integrity.bindingHash,
      providerContextHash: envelope.integrity.providerContextHash,
    },
  };
  if (
    envelope.integrity.envelopeHash !== (await sha256Canonical(envelopeBody(body))) ||
    envelope.integrity.bindingHash !== (await sha256Canonical(envelope.sourceBindings)) ||
    envelope.integrity.providerContextHash !== (await sha256Canonical(envelope.providerContext)) ||
    envelope.plannerCheckpoint.projection.contextHash !==
      (await sha256Canonical(envelope.plannerCheckpoint.projection.segments))
  ) {
    failure('INVALID_ENVELOPE', 'Provider context envelope hash drifted.');
  }

  validateCheckpointBudget(envelope.plannerCheckpoint);
  await validateEnvelopeCoverage(envelope);

  const rebuilt = projectAgentContextToProvider({
    segments: envelope.plannerCheckpoint.projection.segments,
    bindings: envelope.sourceBindings,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(envelope.providerContext)) {
    failure(
      'INVALID_ENVELOPE',
      'Stored provider context does not match the verified planner projection.',
    );
  }

  if (input.canonicalSourceRows) {
    validateBindingsAgainstRows(input.canonicalSourceRows, envelope.sourceBindings);
    if (
      input.canonicalSourceRows.length !== envelope.sourceManifest.length ||
      (await hashAgentContextSourceRows(input.canonicalSourceRows)) !==
        envelope.plannerCheckpoint.canonicalSources.sourceOrderHash
    ) {
      failure('INVALID_ENVELOPE', 'Canonical source rows no longer match the durable envelope.');
    }
    const actualManifest = await sourceManifest(input.canonicalSourceRows);
    if (canonicalJson(actualManifest) !== canonicalJson(envelope.sourceManifest)) {
      failure(
        'INVALID_ENVELOPE',
        'Canonical source manifest no longer matches the durable envelope.',
      );
    }
  }
}

/**
 * Full recovery path: verify against canonical source rows, then rebuild the
 * provider projection from the planner checkpoint rather than trusting the
 * duplicated stored projection.
 */
export async function rebuildAgentContextProviderProjection(input: {
  envelope: AgentContextProviderEnvelopeV2;
  canonicalSourceRows: readonly AgentContextSourceRow[];
}): Promise<AgentContextProviderProjection> {
  await verifyAgentContextProviderEnvelope(input);
  return projectAgentContextToProvider({
    segments: input.envelope.plannerCheckpoint.projection.segments,
    bindings: input.envelope.sourceBindings,
  });
}

/** One-call bridge + planner + durable-envelope composition. */
export async function planAgentModelContext(
  input: AgentModelContextPlanningInput,
): Promise<AgentModelContextPlanningResult> {
  const bridge = agentModelMessagesToContextSources(input);
  const durableWriteEvidence: AgentContextDurableWriteEvidence[] = [];
  for (const supplemental of input.supplementalRows ?? []) {
    for (const coverage of supplemental.durableWriteCoverage ?? []) {
      durableWriteEvidence.push({
        evidenceSourceId: supplemental.sourceId,
        turnOrdinal: coverage.turnOrdinal,
        callId: coverage.callId,
        toolName: coverage.toolName,
      });
    }
  }
  const result = await planAgentContext({
    ...input.planner,
    sourceRows: bridge.sourceRows,
    ...(durableWriteEvidence.length > 0 ? { durableWriteEvidence } : {}),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    bridge,
    plan: result.plan,
    envelope: await createAgentContextProviderEnvelope({
      bridge,
      plan: result.plan,
    }),
  };
}
