import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type {
  AgentRuntimeRecoverySnapshot,
  AgentRuntimeSessionStatus,
  AgentRuntimeToolCallStatus,
  AgentRuntimeTurnStatus,
  PersistedAgentRuntimeCheckpoint,
  PersistedAgentRuntimeEvent,
  PersistedAgentRuntimeMessage,
} from '../../../domain/agent-runtime-persistence';
import {
  replayAgentRuntimeJournal,
} from './reducer';
import type {
  AgentAssistantContentBlock,
  AgentModelMessage,
  AgentRuntimeEvent,
  AgentRuntimeJournalEntry,
  AgentRuntimeRoute,
  AgentRuntimeState,
  AgentRuntimeUsage,
  AgentToolResultBlock,
} from './types';
import { AGENT_RUNTIME_SCHEMA_VERSION } from './types';

export type AgentRuntimeRecoveryCorruptionCode =
  | 'CHECKPOINT_HASH_MISMATCH'
  | 'DUPLICATE_ID'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_REPLAY_INVALID'
  | 'EVENT_SEQUENCE_INVALID'
  | 'FOREIGN_REFERENCE'
  | 'HASH_UNAVAILABLE'
  | 'INVALID_CHECKPOINT'
  | 'INVALID_MESSAGE'
  | 'INVALID_ROUTE'
  | 'INVALID_SESSION'
  | 'INVALID_TOOL_CALL'
  | 'INVALID_TURN'
  | 'ORDER_INVALID'
  | 'STALE_RECOVERY_PLAN'
  | 'TURN_STATUS_CONFLICT';

export class AgentRuntimeRecoveryCorruptionError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: AgentRuntimeRecoveryCorruptionCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentRuntimeRecoveryCorruptionError';
    this.cause = cause;
  }
}

export type AgentRuntimeRecoveryRepair =
  | {
      type: 'synthesized_interrupted_tool_result';
      turnId: string | null;
      callId: string;
      name: string;
    }
  | {
      type: 'dropped_orphan_tool_result';
      turnId: string | null;
      callId: string;
      name: string;
    };

export interface AgentRuntimeStatusTransition<
  T extends AgentRuntimeSessionStatus | AgentRuntimeTurnStatus | AgentRuntimeToolCallStatus | string,
> {
  id: string;
  from: T;
  to: T;
  reason: 'journal_terminal' | 'process_interrupted';
}

export interface AgentRuntimeRecoveryPlan {
  session: AgentRuntimeStatusTransition<AgentRuntimeSessionStatus> | null;
  turns: AgentRuntimeStatusTransition<AgentRuntimeTurnStatus>[];
  messages: AgentRuntimeStatusTransition<string>[];
  toolCalls: AgentRuntimeStatusTransition<AgentRuntimeToolCallStatus>[];
}

export interface RecoveredAgentRuntimeTurn {
  turnId: string;
  ordinal: number;
  persistedStatus: AgentRuntimeTurnStatus;
  recoveredStatus: AgentRuntimeTurnStatus;
  journalState: AgentRuntimeState | null;
}

export interface AgentRuntimeRecoveryResult {
  providerHistory: AgentModelMessage[];
  transcript: AgentChatMessage[];
  turns: RecoveredAgentRuntimeTurn[];
  repairs: AgentRuntimeRecoveryRepair[];
  plan: AgentRuntimeRecoveryPlan;
  checkpointId: string | null;
}

const INTERRUPTED_TOOL_RESULT =
  'Tool execution was interrupted before a durable result was recorded.';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function corruption(
  code: AgentRuntimeRecoveryCorruptionCode,
  message: string,
  cause?: unknown,
): never {
  throw new AgentRuntimeRecoveryCorruptionError(
    code,
    message,
    cause,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertIsoTimestamp(
  value: unknown,
  path: string,
  code: AgentRuntimeRecoveryCorruptionCode,
): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    corruption(code, `${path} must be an ISO timestamp.`);
  }
}

function toCanonicalJsonValue(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      corruption('INVALID_CHECKPOINT', `${path} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    corruption('INVALID_CHECKPOINT', `${path} contains unsupported ${typeof value}.`);
  }
  if (seen.has(value)) {
    corruption('INVALID_CHECKPOINT', `${path} contains a cycle.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        toCanonicalJsonValue(item, `${path}[${index}]`, seen),
      );
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = toCanonicalJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        seen,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function canonicalRecoveryJson(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value, 'checkpoint.context'));
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash contract shared by checkpoint writers and recovery readers.
 *
 * The `sha256:` prefix keeps the durable field algorithm-explicit so a future
 * schema can add another digest without silently reinterpreting old rows.
 */
export async function hashAgentRuntimeCheckpointContext(
  context: readonly AgentModelMessage[],
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    corruption(
      'HASH_UNAVAILABLE',
      'Web Crypto SHA-256 is unavailable; Agent recovery cannot verify checkpoints.',
    );
  }
  const encoded = new TextEncoder().encode(canonicalRecoveryJson(context));
  const digest = await subtle.digest('SHA-256', encoded);
  return `sha256:${bytesToHex(digest)}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalRecoveryJson(left) === canonicalRecoveryJson(right);
}

function parseAssistantBlock(
  value: unknown,
  path: string,
): AgentAssistantContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    corruption('INVALID_MESSAGE', `${path} is not an assistant content block.`);
  }
  if (value.type === 'text' || value.type === 'thinking') {
    if (typeof value.text !== 'string') {
      corruption('INVALID_MESSAGE', `${path}.text must be a string.`);
    }
    return { type: value.type, text: value.text };
  }
  if (value.type !== 'tool_call') {
    corruption('INVALID_MESSAGE', `${path}.type is unsupported.`);
  }
  if (!isNonEmptyString(value.callId) || !isNonEmptyString(value.name)) {
    corruption('INVALID_MESSAGE', `${path} has an invalid tool identity.`);
  }
  if (!isRecord(value.arguments) || typeof value.rawArguments !== 'string') {
    corruption('INVALID_MESSAGE', `${path} has invalid tool arguments.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value.rawArguments) as unknown;
  } catch (error) {
    corruption('INVALID_MESSAGE', `${path}.rawArguments is not JSON.`, error);
  }
  if (!isRecord(raw) || !sameJson(raw, value.arguments)) {
    corruption(
      'INVALID_MESSAGE',
      `${path}.rawArguments does not match normalized arguments.`,
    );
  }
  return {
    type: 'tool_call',
    callId: value.callId,
    name: value.name,
    arguments: toCanonicalJsonValue(
      value.arguments,
      `${path}.arguments`,
    ) as Record<string, unknown>,
    rawArguments: value.rawArguments,
  };
}

function parseToolResult(value: unknown, path: string): AgentToolResultBlock {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.callId) ||
    !isNonEmptyString(value.name) ||
    typeof value.ok !== 'boolean' ||
    typeof value.content !== 'string'
  ) {
    corruption('INVALID_MESSAGE', `${path} is not a canonical tool result.`);
  }
  return {
    callId: value.callId,
    name: value.name,
    ok: value.ok,
    content: value.content,
  };
}

function parseModelMessageContent(
  role: PersistedAgentRuntimeMessage['role'],
  content: unknown,
  path: string,
): AgentModelMessage | null {
  if (role === 'system') {
    if (typeof content !== 'string') {
      corruption('INVALID_MESSAGE', `${path} system content must be a string.`);
    }
    return null;
  }
  if (role === 'user') {
    if (typeof content !== 'string') {
      corruption('INVALID_MESSAGE', `${path} user content must be a string.`);
    }
    return { role: 'user', content };
  }
  if (!Array.isArray(content)) {
    corruption('INVALID_MESSAGE', `${path} ${role} content must be an array.`);
  }
  if (role === 'assistant') {
    return {
      role: 'assistant',
      content: content.map((block, index) =>
        parseAssistantBlock(block, `${path}[${index}]`),
      ),
    };
  }
  return {
    role: 'tool',
    content: content.map((result, index) =>
      parseToolResult(result, `${path}[${index}]`),
    ),
  };
}

function parseCheckpointContext(
  checkpoint: PersistedAgentRuntimeCheckpoint,
): AgentModelMessage[] {
  if (!Array.isArray(checkpoint.context)) {
    corruption(
      'INVALID_CHECKPOINT',
      `Checkpoint "${checkpoint.id}" context must be an AgentModelMessage array.`,
    );
  }
  return checkpoint.context.map((value, index) => {
    if (!isRecord(value) || typeof value.role !== 'string') {
      corruption(
        'INVALID_CHECKPOINT',
        `Checkpoint "${checkpoint.id}" message ${index} is invalid.`,
      );
    }
    if (
      value.role !== 'user' &&
      value.role !== 'assistant' &&
      value.role !== 'tool'
    ) {
      corruption(
        'INVALID_CHECKPOINT',
        `Checkpoint "${checkpoint.id}" message ${index} has an unsupported role.`,
      );
    }
    const parsed = parseModelMessageContent(
      value.role,
      value.content,
      `checkpoint[${checkpoint.id}].context[${index}].content`,
    );
    if (!parsed) {
      corruption(
        'INVALID_CHECKPOINT',
        `Checkpoint "${checkpoint.id}" contains a system message.`,
      );
    }
    return parsed;
  });
}

interface ScopedModelMessage {
  turnId: string | null;
  message: AgentModelMessage;
}

interface RepairResult {
  messages: ScopedModelMessage[];
  repairs: AgentRuntimeRecoveryRepair[];
}

function repairToolPairs(input: readonly ScopedModelMessage[]): RepairResult {
  const messages: ScopedModelMessage[] = [];
  const repairs: AgentRuntimeRecoveryRepair[] = [];
  const pending = new Map<
    string,
    { turnId: string | null; name: string }
  >();

  const closePending = (): void => {
    if (pending.size === 0) return;
    const byTurn = new Map<string | null, AgentToolResultBlock[]>();
    for (const [callId, call] of pending) {
      const results = byTurn.get(call.turnId) ?? [];
      results.push({
        callId,
        name: call.name,
        ok: false,
        content: INTERRUPTED_TOOL_RESULT,
      });
      byTurn.set(call.turnId, results);
      repairs.push({
        type: 'synthesized_interrupted_tool_result',
        turnId: call.turnId,
        callId,
        name: call.name,
      });
    }
    for (const [turnId, content] of byTurn) {
      messages.push({ turnId, message: { role: 'tool', content } });
    }
    pending.clear();
  };

  for (const item of input) {
    const message = item.message;
    if (message.role === 'user' || message.role === 'assistant') {
      closePending();
    }
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool_call') continue;
        if (pending.has(block.callId)) {
          corruption(
            'INVALID_MESSAGE',
            `Duplicate unresolved tool call "${block.callId}" in provider history.`,
          );
        }
        pending.set(block.callId, { turnId: item.turnId, name: block.name });
      }
      messages.push(item);
      continue;
    }
    if (message.role === 'tool') {
      const content: AgentToolResultBlock[] = [];
      for (const result of message.content) {
        const call = pending.get(result.callId);
        if (!call) {
          repairs.push({
            type: 'dropped_orphan_tool_result',
            turnId: item.turnId,
            callId: result.callId,
            name: result.name,
          });
          continue;
        }
        if (call.name !== result.name || call.turnId !== item.turnId) {
          corruption(
            'INVALID_MESSAGE',
            `Tool result "${result.callId}" does not match its canonical call.`,
          );
        }
        pending.delete(result.callId);
        content.push(result);
      }
      if (content.length > 0) {
        messages.push({ ...item, message: { role: 'tool', content } });
      }
      continue;
    }
    messages.push(item);
  }
  closePending();
  return { messages, repairs };
}

function uniqueRepairs(
  repairs: readonly AgentRuntimeRecoveryRepair[],
): AgentRuntimeRecoveryRepair[] {
  const seen = new Set<string>();
  return repairs.filter((repair) => {
    const key = [
      repair.type,
      repair.turnId ?? '',
      repair.callId,
      repair.name,
    ].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortAndValidateMessageRows(
  rows: readonly PersistedAgentRuntimeMessage[],
  requireContiguous: boolean,
): PersistedAgentRuntimeMessage[] {
  const sorted = [...rows].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  );
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const row of sorted) {
    if (!isNonEmptyString(row.id) || ids.has(row.id)) {
      corruption('DUPLICATE_ID', `Duplicate or empty Agent message id "${row.id}".`);
    }
    ids.add(row.id);
    if (!isNonNegativeInteger(row.ordinal) || ordinals.has(row.ordinal)) {
      corruption(
        'ORDER_INVALID',
        `Agent message "${row.id}" has duplicate or invalid ordinal ${row.ordinal}.`,
      );
    }
    ordinals.add(row.ordinal);
  }
  if (requireContiguous) {
    for (let index = 0; index < sorted.length; index += 1) {
      if (sorted[index]?.ordinal !== index) {
        corruption(
          'ORDER_INVALID',
          `Agent messages expected ordinal ${index}, received ${sorted[index]?.ordinal}.`,
        );
      }
    }
  }
  return sorted;
}

function extractCompleteScopedMessages(
  rows: readonly PersistedAgentRuntimeMessage[],
): RepairResult {
  const scoped = sortAndValidateMessageRows(rows, false)
    .filter((row) => row.status === 'complete')
    .map((row): ScopedModelMessage | null => {
      const message = parseModelMessageContent(
        row.role,
        row.content,
        `message[${row.id}].content`,
      );
      return message ? { turnId: row.turnId, message } : null;
    })
    .filter((item): item is ScopedModelMessage => item !== null);
  return repairToolPairs(scoped);
}

function persistedRoute(snapshot: AgentRuntimeRecoverySnapshot): AgentRuntimeRoute {
  const session = snapshot.session;
  if (!isNonEmptyString(session.projectId)) {
    corruption('INVALID_ROUTE', 'Agent runtime session has no projectId.');
  }
  if (session.routeKind === 'chat') {
    if (
      !isNonEmptyString(session.conversationId) ||
      session.goalRunId !== null ||
      session.chapterId !== null
    ) {
      corruption('INVALID_ROUTE', 'Chat Agent session has inconsistent route fields.');
    }
    return {
      kind: 'chat',
      projectId: session.projectId,
      conversationId: session.conversationId,
    };
  }
  if (session.routeKind !== 'goal' || session.conversationId !== null) {
    corruption('INVALID_ROUTE', 'Agent runtime session has an unsupported route.');
  }
  return {
    kind: 'goal',
    projectId: session.projectId,
    ...(session.goalRunId ? { goalRunId: session.goalRunId } : {}),
    ...(session.chapterId ? { chapterId: session.chapterId } : {}),
  };
}

function parseUsage(value: unknown, path: string): AgentRuntimeUsage {
  if (!isRecord(value)) {
    corruption('EVENT_PAYLOAD_INVALID', `${path} must be a usage object.`);
  }
  const fields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const;
  for (const field of fields) {
    if (!isNonNegativeInteger(value[field])) {
      corruption('EVENT_PAYLOAD_INVALID', `${path}.${field} is invalid.`);
    }
  }
  if (
    typeof value.costUsd !== 'number' ||
    !Number.isFinite(value.costUsd) ||
    value.costUsd < 0
  ) {
    corruption('EVENT_PAYLOAD_INVALID', `${path}.costUsd is invalid.`);
  }
  return {
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    cacheReadTokens: value.cacheReadTokens as number,
    cacheWriteTokens: value.cacheWriteTokens as number,
    costUsd: value.costUsd,
  };
}

function parseRuntimeEvent(value: unknown, path: string): AgentRuntimeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    corruption('EVENT_PAYLOAD_INVALID', `${path} is not a runtime event.`);
  }
  switch (value.type) {
    case 'turn_started':
      if (typeof value.prompt !== 'string') {
        corruption('EVENT_PAYLOAD_INVALID', `${path}.prompt is invalid.`);
      }
      return { type: 'turn_started', prompt: value.prompt };

    case 'model_iteration_started':
      if (!isPositiveInteger(value.iteration) || !isNonEmptyString(value.driverId)) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has an invalid model iteration.`);
      }
      return {
        type: 'model_iteration_started',
        iteration: value.iteration,
        driverId: value.driverId,
      };

    case 'text_delta':
    case 'thinking_delta':
      if (!isPositiveInteger(value.iteration) || typeof value.text !== 'string') {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has an invalid text delta.`);
      }
      return { type: value.type, iteration: value.iteration, text: value.text };

    case 'tool_call_started':
      if (
        !isPositiveInteger(value.iteration) ||
        !isNonEmptyString(value.callId) ||
        !isNonEmptyString(value.name)
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has an invalid tool call.`);
      }
      return {
        type: 'tool_call_started',
        iteration: value.iteration,
        callId: value.callId,
        name: value.name,
      };

    case 'tool_args_delta':
      if (
        !isPositiveInteger(value.iteration) ||
        !isNonEmptyString(value.callId) ||
        typeof value.delta !== 'string'
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has invalid tool arguments.`);
      }
      return {
        type: 'tool_args_delta',
        iteration: value.iteration,
        callId: value.callId,
        delta: value.delta,
      };

    case 'tool_call_ready':
      if (
        !isPositiveInteger(value.iteration) ||
        !isNonEmptyString(value.callId) ||
        !isNonEmptyString(value.name) ||
        !isRecord(value.arguments) ||
        typeof value.rawArguments !== 'string'
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has an invalid ready tool call.`);
      }
      try {
        const parsed = JSON.parse(value.rawArguments) as unknown;
        if (!isRecord(parsed) || !sameJson(parsed, value.arguments)) {
          corruption(
            'EVENT_PAYLOAD_INVALID',
            `${path}.rawArguments does not match normalized arguments.`,
          );
        }
      } catch (error) {
        if (error instanceof AgentRuntimeRecoveryCorruptionError) throw error;
        corruption('EVENT_PAYLOAD_INVALID', `${path}.rawArguments is not JSON.`, error);
      }
      return {
        type: 'tool_call_ready',
        iteration: value.iteration,
        callId: value.callId,
        name: value.name,
        arguments: toCanonicalJsonValue(
          value.arguments,
          `${path}.arguments`,
        ) as Record<string, unknown>,
        rawArguments: value.rawArguments,
      };

    case 'tool_execution_started':
      if (
        !isNonEmptyString(value.callId) ||
        !isNonEmptyString(value.name) ||
        (value.access !== 'read' && value.access !== 'write')
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has invalid tool execution data.`);
      }
      return {
        type: 'tool_execution_started',
        callId: value.callId,
        name: value.name,
        access: value.access,
      };

    case 'tool_result':
      if (
        !isNonEmptyString(value.callId) ||
        !isNonEmptyString(value.name) ||
        typeof value.ok !== 'boolean' ||
        typeof value.content !== 'string' ||
        (value.source !== 'executor' && value.source !== 'runtime') ||
        (value.errorCode !== undefined && typeof value.errorCode !== 'string')
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has an invalid tool result.`);
      }
      return {
        type: 'tool_result',
        callId: value.callId,
        name: value.name,
        ok: value.ok,
        content: value.content,
        source: value.source,
        ...(value.errorCode ? { errorCode: value.errorCode } : {}),
      };

    case 'model_usage':
      if (!isPositiveInteger(value.iteration)) {
        corruption('EVENT_PAYLOAD_INVALID', `${path}.iteration is invalid.`);
      }
      return {
        type: 'model_usage',
        iteration: value.iteration,
        usage: parseUsage(value.usage, `${path}.usage`),
      };

    case 'model_iteration_completed': {
      const reasons = ['end_turn', 'tool_use', 'max_tokens', 'content_filter', 'unknown'];
      if (
        !isPositiveInteger(value.iteration) ||
        typeof value.stopReason !== 'string' ||
        !reasons.includes(value.stopReason)
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has an invalid stop reason.`);
      }
      return {
        type: 'model_iteration_completed',
        iteration: value.iteration,
        stopReason: value.stopReason as Extract<
          AgentRuntimeEvent,
          { type: 'model_iteration_completed' }
        >['stopReason'],
      };
    }

    case 'turn_finished': {
      const outcomes = ['completed', 'failed', 'aborted', 'budget_exceeded'];
      if (
        typeof value.outcome !== 'string' ||
        !outcomes.includes(value.outcome) ||
        !isNonNegativeInteger(value.modelIterations) ||
        typeof value.durationMs !== 'number' ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0 ||
        (value.failureCode !== undefined && typeof value.failureCode !== 'string') ||
        (value.message !== undefined && typeof value.message !== 'string')
      ) {
        corruption('EVENT_PAYLOAD_INVALID', `${path} has invalid terminal data.`);
      }
      return {
        type: 'turn_finished',
        outcome: value.outcome as Extract<
          AgentRuntimeEvent,
          { type: 'turn_finished' }
        >['outcome'],
        ...(value.failureCode
          ? {
              failureCode: value.failureCode as Extract<
                AgentRuntimeEvent,
                { type: 'turn_finished' }
              >['failureCode'],
            }
          : {}),
        ...(value.message ? { message: value.message } : {}),
        usage: parseUsage(value.usage, `${path}.usage`),
        modelIterations: value.modelIterations,
        durationMs: value.durationMs,
      };
    }

    default:
      corruption('EVENT_PAYLOAD_INVALID', `${path}.type "${value.type}" is unsupported.`);
  }
}

function sameRoute(left: AgentRuntimeRoute, right: AgentRuntimeRoute): boolean {
  return sameJson(left, right);
}

function parseStoredRoute(value: unknown, path: string): AgentRuntimeRoute {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    corruption('EVENT_PAYLOAD_INVALID', `${path} is not a runtime route.`);
  }
  if (value.kind === 'chat') {
    if (
      !isNonEmptyString(value.projectId) ||
      (value.conversationId !== undefined &&
        !isNonEmptyString(value.conversationId))
    ) {
      corruption('EVENT_PAYLOAD_INVALID', `${path} has invalid chat fields.`);
    }
    return {
      kind: 'chat',
      projectId: value.projectId,
      ...(value.conversationId
        ? { conversationId: value.conversationId }
        : {}),
    };
  }
  if (value.kind === 'goal') {
    if (
      !isNonEmptyString(value.projectId) ||
      (value.goalRunId !== undefined && !isNonEmptyString(value.goalRunId)) ||
      (value.chapterId !== undefined && !isNonEmptyString(value.chapterId))
    ) {
      corruption('EVENT_PAYLOAD_INVALID', `${path} has invalid goal fields.`);
    }
    return {
      kind: 'goal',
      projectId: value.projectId,
      ...(value.goalRunId ? { goalRunId: value.goalRunId } : {}),
      ...(value.chapterId ? { chapterId: value.chapterId } : {}),
    };
  }
  corruption('EVENT_PAYLOAD_INVALID', `${path}.kind is unsupported.`);
}

function parsePersistedEvent(
  row: PersistedAgentRuntimeEvent,
  route: AgentRuntimeRoute,
): AgentRuntimeJournalEntry {
  if (
    !isRecord(row.payload) ||
    !('route' in row.payload) ||
    !('event' in row.payload)
  ) {
    corruption(
      'EVENT_PAYLOAD_INVALID',
      `Event "${row.eventId}" payload must contain route and event.`,
    );
  }
  const storedRoute = parseStoredRoute(
    row.payload.route,
    `event[${row.eventId}].payload.route`,
  );
  if (!sameRoute(storedRoute, route)) {
    corruption(
      'EVENT_PAYLOAD_INVALID',
      `Event "${row.eventId}" route does not match its session.`,
    );
  }
  const event = parseRuntimeEvent(
    row.payload.event,
    `event[${row.eventId}].payload.event`,
  );
  if (row.eventType !== event.type) {
    corruption(
      'EVENT_PAYLOAD_INVALID',
      `Event "${row.eventId}" type column does not match its payload.`,
    );
  }
  return {
    schemaVersion: row.schemaVersion as typeof AGENT_RUNTIME_SCHEMA_VERSION,
    sessionId: row.sessionId,
    turnId: row.turnId,
    route,
    seq: row.seq,
    eventId: row.eventId,
    wallTimeMs: row.wallTimeMs,
    event,
  };
}

function terminalTurnStatus(state: AgentRuntimeState): AgentRuntimeTurnStatus | null {
  const outcome = state.terminal?.outcome;
  if (!outcome) return null;
  if (outcome === 'completed') return 'completed';
  if (outcome === 'aborted') return 'aborted';
  return 'failed';
}

function buildTranscript(
  turns: readonly RecoveredAgentRuntimeTurn[],
  rows: readonly PersistedAgentRuntimeMessage[],
): { transcript: AgentChatMessage[]; repairs: AgentRuntimeRecoveryRepair[] } {
  const transcript: AgentChatMessage[] = [];
  const repairs: AgentRuntimeRecoveryRepair[] = [];

  for (const recovered of turns) {
    const turnRows = rows.filter((row) => row.turnId === recovered.turnId);
    const visibleRows = turnRows.filter(
      (row) =>
        row.status === 'complete' ||
        (row.role === 'user' && row.status === 'accepted'),
    );
    const scoped = visibleRows
      .map((row): ScopedModelMessage | null => {
        const message = parseModelMessageContent(
          row.role,
          row.content,
          `message[${row.id}].content`,
        );
        return message ? { turnId: row.turnId, message } : null;
      })
      .filter((item): item is ScopedModelMessage => item !== null);
    const repaired = repairToolPairs(scoped);
    repairs.push(...repaired.repairs);
    const toolIndexes = new Map<string, number>();

    for (const item of repaired.messages) {
      const message = item.message;
      if (message.role === 'user') {
        transcript.push({ kind: 'user', text: message.content });
        continue;
      }
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            transcript.push({ kind: 'assistant', text: block.text });
          } else if (block.type === 'thinking' && block.text) {
            transcript.push({ kind: 'thinking', text: block.text });
          } else if (block.type === 'tool_call') {
            toolIndexes.set(block.callId, transcript.length);
            transcript.push({
              kind: 'tool',
              id: block.callId,
              name: block.name,
              input: block.arguments,
              status: 'running',
            });
          }
        }
        continue;
      }
      for (const result of message.content) {
        const index = toolIndexes.get(result.callId);
        if (index === undefined) continue;
        const tool = transcript[index];
        if (tool?.kind !== 'tool') continue;
        transcript[index] = {
          ...tool,
          status: result.ok ? 'ok' : 'error',
          result: result.content,
        };
      }
    }

    const journalState = recovered.journalState;
    const terminal = journalState?.terminal;
    if (!terminal) continue;
    const hasUsage =
      terminal.usage.inputTokens > 0 ||
      terminal.usage.outputTokens > 0 ||
      terminal.usage.costUsd > 0;
    if (hasUsage) {
      transcript.push({
        kind: 'usage',
        inputTokens: terminal.usage.inputTokens,
        outputTokens: terminal.usage.outputTokens,
        cacheReadTokens: terminal.usage.cacheReadTokens,
        cacheCreationTokens: terminal.usage.cacheWriteTokens,
        costUsd: terminal.usage.costUsd,
        turns: terminal.modelIterations,
        durationMs: terminal.durationMs,
        durationApiMs: terminal.durationMs,
        ...(journalState.endedAtMs === null
          ? {}
          : { at: new Date(journalState.endedAtMs).toISOString() }),
      });
    }
    if (
      terminal.outcome !== 'completed' &&
      terminal.outcome !== 'aborted'
    ) {
      transcript.push({
        kind: 'error',
        text: terminal.message ?? `Agent turn ${terminal.outcome}`,
      });
    }
  }

  return { transcript, repairs };
}

function validateSession(snapshot: AgentRuntimeRecoverySnapshot): AgentRuntimeRoute {
  const session = snapshot.session;
  const statuses: readonly AgentRuntimeSessionStatus[] = [
    'pending',
    'idle',
    'running',
    'recovering',
    'interrupted',
    'closed',
    'failed',
    'aborted',
  ];
  if (
    !isNonEmptyString(session.id) ||
    !isNonEmptyString(session.provider) ||
    !isNonNegativeInteger(session.providerEpoch) ||
    !statuses.includes(session.status)
  ) {
    corruption('INVALID_SESSION', 'Agent runtime session identity is invalid.');
  }
  assertIsoTimestamp(session.createdAt, 'session.createdAt', 'INVALID_SESSION');
  assertIsoTimestamp(session.updatedAt, 'session.updatedAt', 'INVALID_SESSION');
  if (session.endedAt !== null) {
    assertIsoTimestamp(session.endedAt, 'session.endedAt', 'INVALID_SESSION');
  }
  return persistedRoute(snapshot);
}

function validateTurns(snapshot: AgentRuntimeRecoverySnapshot) {
  const statuses: readonly AgentRuntimeTurnStatus[] = [
    'accepted',
    'running',
    'recovering',
    'completed',
    'interrupted',
    'failed',
    'aborted',
  ];
  const sorted = [...snapshot.turns].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  );
  const ids = new Set<string>();
  for (let index = 0; index < sorted.length; index += 1) {
    const turn = sorted[index];
    if (!isNonEmptyString(turn.id) || ids.has(turn.id)) {
      corruption('DUPLICATE_ID', `Duplicate or empty Agent turn id "${turn.id}".`);
    }
    ids.add(turn.id);
    if (turn.sessionId !== snapshot.session.id) {
      corruption('FOREIGN_REFERENCE', `Turn "${turn.id}" belongs to another session.`);
    }
    if (turn.ordinal !== index || !statuses.includes(turn.status)) {
      corruption(
        'ORDER_INVALID',
        `Agent turns expected ordinal ${index}, received ${turn.ordinal}.`,
      );
    }
    assertIsoTimestamp(turn.acceptedAt, `turn[${turn.id}].acceptedAt`, 'INVALID_TURN');
    assertIsoTimestamp(turn.updatedAt, `turn[${turn.id}].updatedAt`, 'INVALID_TURN');
    if (turn.startedAt !== null) {
      assertIsoTimestamp(turn.startedAt, `turn[${turn.id}].startedAt`, 'INVALID_TURN');
    }
    if (turn.endedAt !== null) {
      assertIsoTimestamp(turn.endedAt, `turn[${turn.id}].endedAt`, 'INVALID_TURN');
    }
  }
  return { sorted, ids };
}

function validateMessages(
  snapshot: AgentRuntimeRecoverySnapshot,
  turnIds: ReadonlySet<string>,
): PersistedAgentRuntimeMessage[] {
  const roles: readonly PersistedAgentRuntimeMessage['role'][] = [
    'system',
    'user',
    'assistant',
    'tool',
  ];
  const statuses: readonly PersistedAgentRuntimeMessage['status'][] = [
    'accepted',
    'streaming',
    'complete',
    'interrupted',
    'failed',
  ];
  const sorted = sortAndValidateMessageRows(snapshot.messages, true);
  const byId = new Map(sorted.map((message) => [message.id, message]));
  for (const row of sorted) {
    if (row.sessionId !== snapshot.session.id) {
      corruption('FOREIGN_REFERENCE', `Message "${row.id}" belongs to another session.`);
    }
    if (row.turnId !== null && !turnIds.has(row.turnId)) {
      corruption('FOREIGN_REFERENCE', `Message "${row.id}" references an unknown turn.`);
    }
    if (!roles.includes(row.role) || !statuses.includes(row.status)) {
      corruption('INVALID_MESSAGE', `Message "${row.id}" has an invalid role or status.`);
    }
    assertIsoTimestamp(row.createdAt, `message[${row.id}].createdAt`, 'INVALID_MESSAGE');
    if (row.completedAt !== null) {
      assertIsoTimestamp(
        row.completedAt,
        `message[${row.id}].completedAt`,
        'INVALID_MESSAGE',
      );
    }
    if (
      row.status === 'complete' ||
      (row.role === 'user' && row.status === 'accepted')
    ) {
      parseModelMessageContent(row.role, row.content, `message[${row.id}].content`);
    }
  }
  for (const turn of snapshot.turns) {
    if (!turn.promptMessageId) {
      corruption('INVALID_TURN', `Turn "${turn.id}" has no prompt message.`);
    }
    const prompt = byId.get(turn.promptMessageId);
    if (
      !prompt ||
      prompt.turnId !== turn.id ||
      prompt.role !== 'user' ||
      (prompt.status !== 'accepted' && prompt.status !== 'complete') ||
      typeof prompt.content !== 'string'
    ) {
      corruption('INVALID_TURN', `Turn "${turn.id}" has an invalid prompt message.`);
    }
  }
  return sorted;
}

function replayTurns(
  snapshot: AgentRuntimeRecoverySnapshot,
  route: AgentRuntimeRoute,
): {
  turns: RecoveredAgentRuntimeTurn[];
  turnTransitions: AgentRuntimeStatusTransition<AgentRuntimeTurnStatus>[];
} {
  const eventsByTurn = new Map<string, PersistedAgentRuntimeEvent[]>();
  for (const event of snapshot.events) {
    if (event.sessionId !== snapshot.session.id) {
      corruption('FOREIGN_REFERENCE', `Event "${event.eventId}" belongs to another session.`);
    }
    assertIsoTimestamp(
      event.createdAt,
      `event[${event.eventId}].createdAt`,
      'EVENT_PAYLOAD_INVALID',
    );
    const rows = eventsByTurn.get(event.turnId) ?? [];
    rows.push(event);
    eventsByTurn.set(event.turnId, rows);
  }

  const turns: RecoveredAgentRuntimeTurn[] = [];
  const turnTransitions: AgentRuntimeStatusTransition<AgentRuntimeTurnStatus>[] = [];
  for (const turn of [...snapshot.turns].sort((left, right) => left.ordinal - right.ordinal)) {
    const rows = [...(eventsByTurn.get(turn.id) ?? [])].sort(
      (left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId),
    );
    let journalState: AgentRuntimeState | null = null;
    if (rows.length > 0) {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const expectedSeq = index + 1;
        const expectedId = `${turn.id}:${String(expectedSeq).padStart(8, '0')}`;
        if (
          row.turnId !== turn.id ||
          row.seq !== expectedSeq ||
          row.eventId !== expectedId ||
          row.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION ||
          !isNonNegativeInteger(row.wallTimeMs)
        ) {
          corruption(
            'EVENT_SEQUENCE_INVALID',
            `Turn "${turn.id}" has a non-contiguous or unsupported journal at seq ${row.seq}.`,
          );
        }
      }
      const entries = rows.map((row) => parsePersistedEvent(row, route));
      const terminalCount = entries.filter(
        (entry) => entry.event.type === 'turn_finished',
      ).length;
      if (terminalCount > 1) {
        corruption(
          'EVENT_SEQUENCE_INVALID',
          `Turn "${turn.id}" has more than one terminal event.`,
        );
      }
      try {
        journalState = replayAgentRuntimeJournal(entries);
      } catch (error) {
        corruption(
          'EVENT_REPLAY_INVALID',
          `Turn "${turn.id}" journal failed strict replay.`,
          error,
        );
      }
      const prompt = snapshot.messages.find((message) => message.id === turn.promptMessageId);
      if (
        journalState.prompt !== null &&
        typeof prompt?.content === 'string' &&
        journalState.prompt !== prompt.content
      ) {
        corruption(
          'EVENT_REPLAY_INVALID',
          `Turn "${turn.id}" journal prompt does not match its durable prompt.`,
        );
      }
    }

    const terminalStatus = journalState ? terminalTurnStatus(journalState) : null;
    let recoveredStatus = turn.status;
    if (terminalStatus) {
      const persistedTerminal =
        turn.status === 'completed' ||
        turn.status === 'failed' ||
        turn.status === 'aborted';
      if (persistedTerminal && turn.status !== terminalStatus) {
        corruption(
          'TURN_STATUS_CONFLICT',
          `Turn "${turn.id}" status conflicts with its terminal journal.`,
        );
      }
      // The immutable terminal event is appended before the canonical
      // turn/message/checkpoint commit. A non-terminal row therefore means the
      // process died inside that window: without the missing atomic commit we
      // must not infer that partial message rows are canonical.
      recoveredStatus = persistedTerminal ? terminalStatus : 'interrupted';
      if (turn.status !== recoveredStatus) {
        turnTransitions.push({
          id: turn.id,
          from: turn.status,
          to: recoveredStatus,
          reason: 'process_interrupted',
        });
      }
    } else {
      if (
        turn.status === 'completed' ||
        turn.status === 'failed' ||
        turn.status === 'aborted'
      ) {
        corruption(
          'TURN_STATUS_CONFLICT',
          `Terminal turn "${turn.id}" has no terminal journal event.`,
        );
      }
      recoveredStatus = 'interrupted';
      if (turn.status !== 'interrupted') {
        turnTransitions.push({
          id: turn.id,
          from: turn.status,
          to: 'interrupted',
          reason: 'process_interrupted',
        });
      }
    }
    turns.push({
      turnId: turn.id,
      ordinal: turn.ordinal,
      persistedStatus: turn.status,
      recoveredStatus,
      journalState,
    });
  }

  for (const turnId of eventsByTurn.keys()) {
    if (!snapshot.turns.some((turn) => turn.id === turnId)) {
      corruption('FOREIGN_REFERENCE', `Journal references unknown turn "${turnId}".`);
    }
  }
  return { turns, turnTransitions };
}

function validateToolCalls(
  snapshot: AgentRuntimeRecoverySnapshot,
  recoveredTurns: readonly RecoveredAgentRuntimeTurn[],
): AgentRuntimeStatusTransition<AgentRuntimeToolCallStatus>[] {
  const ids = new Set<string>();
  const callKeys = new Set<string>();
  const turnIds = new Set(recoveredTurns.map((turn) => turn.turnId));
  const interruptedTurns = new Set(
    recoveredTurns
      .filter((turn) => turn.recoveredStatus === 'interrupted')
      .map((turn) => turn.turnId),
  );
  const transitions: AgentRuntimeStatusTransition<AgentRuntimeToolCallStatus>[] = [];

  for (const call of snapshot.toolCalls) {
    const callKey = `${call.turnId}\u0000${call.callId}`;
    if (
      !isNonEmptyString(call.id) ||
      ids.has(call.id) ||
      !isNonEmptyString(call.callId) ||
      !isNonEmptyString(call.name) ||
      callKeys.has(callKey) ||
      (call.access !== 'read' && call.access !== 'write') ||
      ![
        'requested',
        'running',
        'completed',
        'failed',
        'interrupted',
        'uncertain',
      ].includes(call.status)
    ) {
      corruption('DUPLICATE_ID', `Agent tool-call projection "${call.id}" is duplicated.`);
    }
    ids.add(call.id);
    callKeys.add(callKey);
    if (call.sessionId !== snapshot.session.id || !turnIds.has(call.turnId)) {
      corruption('FOREIGN_REFERENCE', `Tool call "${call.id}" has a foreign owner.`);
    }
    if (!isNonEmptyString(call.idempotencyKey)) {
      corruption('INVALID_TOOL_CALL', `Tool call "${call.id}" has no idempotency key.`);
    }
    if (!interruptedTurns.has(call.turnId)) continue;
    if (call.status !== 'requested' && call.status !== 'running') continue;
    const next =
      call.status === 'running' && call.access === 'write'
        ? 'uncertain'
        : 'interrupted';
    transitions.push({
      id: call.id,
      from: call.status,
      to: next,
      reason: 'process_interrupted',
    });
  }
  return transitions;
}

async function validateCheckpoints(
  snapshot: AgentRuntimeRecoverySnapshot,
  completeRows: readonly PersistedAgentRuntimeMessage[],
  turnOrdinalById: ReadonlyMap<string, number>,
): Promise<{
  checkpoint: PersistedAgentRuntimeCheckpoint | null;
  context: AgentModelMessage[];
}> {
  const ids = new Set<string>();
  const parsed = await Promise.all(
    snapshot.checkpoints.map(async (checkpoint) => {
      if (!isNonEmptyString(checkpoint.id) || ids.has(checkpoint.id)) {
        corruption('DUPLICATE_ID', `Duplicate or empty checkpoint id "${checkpoint.id}".`);
      }
      ids.add(checkpoint.id);
      if (
        checkpoint.sessionId !== snapshot.session.id ||
        !Number.isSafeInteger(checkpoint.throughTurnOrdinal) ||
        checkpoint.throughTurnOrdinal < -1 ||
        !isNonNegativeInteger(checkpoint.messageCount)
      ) {
        corruption('INVALID_CHECKPOINT', `Checkpoint "${checkpoint.id}" metadata is invalid.`);
      }
      assertIsoTimestamp(
        checkpoint.createdAt,
        `checkpoint[${checkpoint.id}].createdAt`,
        'INVALID_CHECKPOINT',
      );
      if (
        checkpoint.throughTurnOrdinal >= snapshot.turns.length &&
        checkpoint.throughTurnOrdinal !== -1
      ) {
        corruption(
          'INVALID_CHECKPOINT',
          `Checkpoint "${checkpoint.id}" points past the session turn range.`,
        );
      }
      const context = parseCheckpointContext(checkpoint);
      if (context.length !== checkpoint.messageCount) {
        corruption(
          'INVALID_CHECKPOINT',
          `Checkpoint "${checkpoint.id}" messageCount does not match its context.`,
        );
      }
      const actualHash = await hashAgentRuntimeCheckpointContext(context);
      if (checkpoint.contextHash !== actualHash) {
        corruption(
          'CHECKPOINT_HASH_MISMATCH',
          `Checkpoint "${checkpoint.id}" failed SHA-256 verification.`,
        );
      }

      const throughRows = completeRows.filter((row) => {
        if (row.turnId === null) return false;
        const ordinal = turnOrdinalById.get(row.turnId);
        return ordinal !== undefined && ordinal <= checkpoint.throughTurnOrdinal;
      });
      const throughMessages = throughRows
        .map((row) =>
          parseModelMessageContent(
            row.role,
            row.content,
            `message[${row.id}].content`,
          ),
        )
        .filter((message): message is AgentModelMessage => message !== null);
      if (!sameJson(throughMessages, context)) {
        corruption(
          'INVALID_CHECKPOINT',
          `Checkpoint "${checkpoint.id}" does not match canonical message rows.`,
        );
      }
      return { checkpoint, context };
    }),
  );

  parsed.sort(
    (left, right) =>
      right.checkpoint.throughTurnOrdinal - left.checkpoint.throughTurnOrdinal ||
      right.checkpoint.createdAt.localeCompare(left.checkpoint.createdAt) ||
      right.checkpoint.id.localeCompare(left.checkpoint.id),
  );
  return parsed[0] ?? { checkpoint: null, context: [] };
}

function buildRecoveryPlan(
  snapshot: AgentRuntimeRecoverySnapshot,
  turns: readonly RecoveredAgentRuntimeTurn[],
  turnTransitions: AgentRuntimeStatusTransition<AgentRuntimeTurnStatus>[],
  toolCalls: AgentRuntimeStatusTransition<AgentRuntimeToolCallStatus>[],
): AgentRuntimeRecoveryPlan {
  const interruptedTurnIds = new Set(
    turns
      .filter((turn) => turn.recoveredStatus === 'interrupted')
      .map((turn) => turn.turnId),
  );
  const messages: AgentRuntimeStatusTransition<string>[] = snapshot.messages
    .filter(
      (message) =>
        message.turnId !== null &&
        interruptedTurnIds.has(message.turnId) &&
        message.status === 'streaming',
    )
    .map((message) => ({
      id: message.id,
      from: message.status,
      to: 'interrupted',
      reason: 'process_interrupted',
    }));

  let session: AgentRuntimeRecoveryPlan['session'] = null;
  const hasInterruptedTurn = interruptedTurnIds.size > 0;
  if (hasInterruptedTurn) {
    if (
      snapshot.session.status === 'closed' ||
      snapshot.session.status === 'failed' ||
      snapshot.session.status === 'aborted'
    ) {
      corruption(
        'TURN_STATUS_CONFLICT',
        'A terminal Agent session contains an interrupted turn.',
      );
    }
    if (snapshot.session.status !== 'interrupted') {
      session = {
        id: snapshot.session.id,
        from: snapshot.session.status,
        to: 'interrupted',
        reason: 'process_interrupted',
      };
    }
  } else if (
    snapshot.session.status === 'pending' ||
    snapshot.session.status === 'running' ||
    snapshot.session.status === 'recovering'
  ) {
    session = {
      id: snapshot.session.id,
      from: snapshot.session.status,
      to: 'idle',
      reason: 'journal_terminal',
    };
  }

  return { session, turns: turnTransitions, messages, toolCalls };
}

/**
 * Strict, provider-neutral crash recovery.
 *
 * Corrupt snapshots throw before any recovery plan is returned. Callers should
 * apply the returned transitions transactionally with compare-and-set on
 * `from`, then hydrate the UI and provider from the returned projections.
 */
export async function recoverAgentRuntimeSnapshot(
  snapshot: AgentRuntimeRecoverySnapshot,
): Promise<AgentRuntimeRecoveryResult> {
  const route = validateSession(snapshot);
  const { sorted: turns, ids: turnIds } = validateTurns(snapshot);
  const messages = validateMessages(snapshot, turnIds);
  const replayed = replayTurns(snapshot, route);
  const turnOrdinalById = new Map(turns.map((turn) => [turn.id, turn.ordinal]));
  const completedTurnIds = new Set(
    replayed.turns
      .filter((turn) => turn.recoveredStatus === 'completed')
      .map((turn) => turn.turnId),
  );
  const completeRows = messages.filter(
    (message) =>
      message.status === 'complete' &&
      message.turnId !== null &&
      completedTurnIds.has(message.turnId),
  );
  const checkpoint = await validateCheckpoints(
    snapshot,
    completeRows,
    turnOrdinalById,
  );

  const deltaRows = checkpoint.checkpoint
    ? completeRows.filter((row) => {
        if (row.turnId === null) return false;
        const ordinal = turnOrdinalById.get(row.turnId);
        return (
          ordinal !== undefined &&
          ordinal > checkpoint.checkpoint!.throughTurnOrdinal
        );
      })
    : completeRows;
  const delta = extractCompleteScopedMessages(deltaRows);
  const checkpointScope = checkpoint.context.map(
    (message): ScopedModelMessage => ({ turnId: null, message }),
  );
  const combined = repairToolPairs([
    ...checkpointScope,
    ...delta.messages,
  ]);
  const transcript = buildTranscript(replayed.turns, messages);
  const toolCallTransitions = validateToolCalls(snapshot, replayed.turns);
  const plan = buildRecoveryPlan(
    snapshot,
    replayed.turns,
    replayed.turnTransitions,
    toolCallTransitions,
  );

  return {
    providerHistory: combined.messages.map((item) => item.message),
    transcript: transcript.transcript,
    turns: replayed.turns,
    repairs: uniqueRepairs([
      ...delta.repairs,
      ...combined.repairs,
      ...transcript.repairs,
    ]),
    plan,
    checkpointId: checkpoint.checkpoint?.id ?? null,
  };
}

function applyTransition<T extends { id: string; status: string }>(
  rows: readonly T[],
  transitions: readonly AgentRuntimeStatusTransition<string>[],
): T[] {
  const byId = new Map<string, AgentRuntimeStatusTransition<string>>();
  for (const transition of transitions) {
    if (byId.has(transition.id)) {
      corruption(
        'STALE_RECOVERY_PLAN',
        `Recovery plan repeats target "${transition.id}".`,
      );
    }
    byId.set(transition.id, transition);
  }
  const matched = new Set<string>();
  const output = rows.map((row) => {
    const transition = byId.get(row.id);
    if (!transition) return row;
    matched.add(row.id);
    if (row.status === transition.to) return row;
    if (row.status !== transition.from) {
      corruption(
        'STALE_RECOVERY_PLAN',
        `Recovery target "${row.id}" changed from "${transition.from}" to "${row.status}".`,
      );
    }
    return { ...row, status: transition.to };
  });
  for (const id of byId.keys()) {
    if (!matched.has(id)) {
      corruption('STALE_RECOVERY_PLAN', `Recovery target "${id}" no longer exists.`);
    }
  }
  return output;
}

/**
 * Pure test/in-memory materializer for the compare-and-set recovery plan.
 * Applying the same plan twice is harmless.
 */
export function applyAgentRuntimeRecoveryPlan(
  snapshot: AgentRuntimeRecoverySnapshot,
  plan: AgentRuntimeRecoveryPlan,
): AgentRuntimeRecoverySnapshot {
  let session = snapshot.session;
  if (plan.session) {
    if (
      session.status !== plan.session.from &&
      session.status !== plan.session.to
    ) {
      corruption(
        'STALE_RECOVERY_PLAN',
        `Recovery session changed from "${plan.session.from}" to "${session.status}".`,
      );
    }
    session =
      session.status === plan.session.to
        ? session
        : { ...session, status: plan.session.to };
  }
  return {
    ...snapshot,
    session,
    turns: applyTransition(
      snapshot.turns,
      plan.turns as AgentRuntimeStatusTransition<string>[],
    ) as AgentRuntimeRecoverySnapshot['turns'],
    messages: applyTransition(
      snapshot.messages,
      plan.messages,
    ) as AgentRuntimeRecoverySnapshot['messages'],
    toolCalls: applyTransition(
      snapshot.toolCalls,
      plan.toolCalls as AgentRuntimeStatusTransition<string>[],
    ) as AgentRuntimeRecoverySnapshot['toolCalls'],
  };
}
