import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sha256Bytes } from '../protocol/canonical-cbor';
import type { AgentChatMessage } from '../../domain/agent-conversation';
import type { AgentModelMessage } from '../../lib/agent/runtime/types';
import type { AgentContextSummaryCandidate } from '../../lib/agent/runtime/context-planner';

export class ChatProtocolError extends Error {}

export const AGENT_CHAT_PROTOCOL = 'drifting.agent-chat.v1' as const;
export const AGENT_CHAT_CHUNK_CHARS = 64 * 1024;
export const AGENT_CHAT_MAX_OBJECT_BYTES = 1024 * 1024;
export const AGENT_CHAT_MAX_PAYLOAD_CHARS = 64 * 1024 * 1024;
const id = Type.String({ minLength: 1, maxLength: 300 });
const nullableId = Type.Union([id, Type.Null()]);
const timestamp = Type.String({ minLength: 20, maxLength: 32, pattern: '^\\d{4}-\\d{2}-\\d{2}T' });
const base = { id, projectId: id };
const branchSchema = Type.Object(
  {
    ...base,
    kind: Type.Literal('branch'),
    branchId: id,
    rootId: id,
    parentBranchId: nullableId,
    forkTurnId: nullableId,
    title: Type.String({ maxLength: 4096 }),
    clock: Type.String({ pattern: '^[0-9]{16}:[0-9a-f-]{36}$' }),
    deletedAt: Type.Union([timestamp, Type.Null()]),
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  { additionalProperties: false },
);
const turnSchema = Type.Object(
  {
    ...base,
    kind: Type.Literal('turn'),
    branchId: id,
    parentTurnId: nullableId,
    outcome: Type.Union(
      ['completed', 'failed', 'aborted', 'interrupted', 'archive'].map((s) => Type.Literal(s)),
    ),
    payloadIds: Type.Array(id, { minItems: 1, maxItems: 2048 }),
    createdAt: timestamp,
  },
  { additionalProperties: false },
);
const blobSchema = Type.Object(
  {
    ...base,
    kind: Type.Literal('blob'),
    text: Type.String({ maxLength: AGENT_CHAT_CHUNK_CHARS }),
  },
  { additionalProperties: false },
);
export const AGENT_CHAT_OBJECT_SCHEMA = Type.Union([branchSchema, turnSchema, blobSchema]);
export type ChatBranchObject = Static<typeof branchSchema>;
export type ChatTurnObject = Static<typeof turnSchema>;
export type ChatBlobObject = Static<typeof blobSchema>;
export type ChatObject = ChatBranchObject | ChatTurnObject | ChatBlobObject;
export interface ChatArtifact {
  ref: string;
  toolName: string;
  callId: string;
  payloadIds: string[];
  arguments?: Record<string, unknown>;
}
export interface ChatTurnPayload {
  messages: AgentModelMessage[];
  display: AgentChatMessage[];
  artifacts: ChatArtifact[];
  summaries: AgentContextSummaryCandidate[];
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  throw new ChatProtocolError('Agent chat contains non-portable data');
}
export async function hashText(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}
export async function hashObject(object: ChatObject): Promise<string> {
  return hashText(canonicalJson(object));
}
export function validateObject(value: unknown): ChatObject {
  if (!Value.Check(AGENT_CHAT_OBJECT_SCHEMA, value))
    throw new ChatProtocolError('Invalid Agent chat object');
  if (
    value.kind === 'branch' &&
    (value.parentBranchId === value.branchId ||
      (value.parentBranchId === null) !== (value.forkTurnId === null))
  ) {
    throw new ChatProtocolError('Invalid Agent chat ancestry');
  }
  if (value.kind !== 'blob' && !Number.isFinite(Date.parse(value.createdAt)))
    throw new ChatProtocolError('Invalid Agent chat timestamp');
  if (
    value.kind === 'branch' &&
    (!Number.isFinite(Date.parse(value.updatedAt)) ||
      (value.deletedAt !== null && !Number.isFinite(Date.parse(value.deletedAt))))
  )
    throw new ChatProtocolError('Invalid Agent chat timestamp');
  if (value.kind === 'turn' && value.id === value.parentTurnId)
    throw new ChatProtocolError('Cyclic Agent chat turn');
  return value;
}
export async function chunkText(projectId: string, text: string): Promise<ChatBlobObject[]> {
  if (text.length > AGENT_CHAT_MAX_PAYLOAD_CHARS)
    throw new ChatProtocolError('Agent chat payload exceeds the bounded history limit');
  const result: ChatBlobObject[] = [];
  for (let at = 0; at < text.length || at === 0; at += AGENT_CHAT_CHUNK_CHARS) {
    const part = text.slice(at, at + AGENT_CHAT_CHUNK_CHARS);
    const digest = await hashText(canonicalJson({ projectId, text: part }));
    result.push({ id: `b:${digest.slice(7)}`, projectId, kind: 'blob', text: part });
  }
  return result;
}
export function encodeChatWire(
  object: ChatObject,
  projectSyncId: string,
  generationId: string,
): Uint8Array {
  validateObject(object);
  const bytes = new TextEncoder().encode(
    canonicalJson({ protocol: AGENT_CHAT_PROTOCOL, projectSyncId, generationId, object }),
  );
  if (bytes.byteLength > AGENT_CHAT_MAX_OBJECT_BYTES)
    throw new ChatProtocolError('Agent chat object exceeds wire limit');
  return bytes;
}
export function decodeChatWire(
  bytes: Uint8Array,
  expected: { projectId: string; projectSyncId: string; generationId: string },
): ChatObject {
  if (bytes.byteLength > AGENT_CHAT_MAX_OBJECT_BYTES)
    throw new ChatProtocolError('Agent chat object exceeds wire limit');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object')
    throw new ChatProtocolError('Invalid Agent chat envelope');
  const wire = value as Record<string, unknown>;
  if (
    Object.keys(wire).sort().join(',') !== 'generationId,object,projectSyncId,protocol' ||
    wire.protocol !== AGENT_CHAT_PROTOCOL ||
    wire.projectSyncId !== expected.projectSyncId ||
    wire.generationId !== expected.generationId
  )
    throw new ChatProtocolError('Agent chat identity or version mismatch');
  const object = validateObject(wire.object);
  if (object.projectId !== expected.projectId)
    throw new ChatProtocolError('Agent chat escaped its project');
  return object;
}
