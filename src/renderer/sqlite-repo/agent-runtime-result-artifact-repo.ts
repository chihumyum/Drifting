import { and, eq, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';

import type {
  AgentRuntimeResultArtifactGcResult,
  AgentRuntimeResultArtifactPage,
  CollectAgentRuntimeResultArtifacts,
  PersistAgentRuntimeResultArtifact,
  PersistedAgentRuntimeResultArtifact,
  ReadAgentRuntimeResultArtifact,
  ReadAgentRuntimeResultArtifactPage,
} from '../domain/agent-runtime-result-artifact';
import { getDb, type DbExecutor } from '../lib/db';
import { AgentConversationTable, AgentRuntimeSessionTable, AgentRuntimeResultArtifactTable, AgentRuntimeResultBlobTable } from '../schema/drizzle';
import { canonicalAgentRuntimeJson } from './agent-runtime-persistence-repo';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class AgentRuntimeResultArtifactError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ARTIFACT'
      | 'ARTIFACT_TOO_LARGE'
      | 'ARTIFACT_PROVENANCE_CONFLICT'
      | 'ARTIFACT_CONTENT_INTEGRITY',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeResultArtifactError';
  }
}

export interface PersistAgentRuntimeResultArtifactResult {
  outcome: 'inserted' | 'duplicate';
  artifact: PersistedAgentRuntimeResultArtifact;
  evictedRefs: string[];
}

export interface AgentRuntimeResultArtifactRepository {
  persist(
    input: PersistAgentRuntimeResultArtifact,
  ): Promise<PersistAgentRuntimeResultArtifactResult>;
  get(input: ReadAgentRuntimeResultArtifact): Promise<PersistedAgentRuntimeResultArtifact | null>;
  readPage(
    input: ReadAgentRuntimeResultArtifactPage,
  ): Promise<AgentRuntimeResultArtifactPage | null>;
  collectGarbage(
    input: CollectAgentRuntimeResultArtifacts,
  ): Promise<AgentRuntimeResultArtifactGcResult>;
}

function fail(code: AgentRuntimeResultArtifactError['code'], message: string): never {
  throw new AgentRuntimeResultArtifactError(code, message);
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_ARTIFACT', `${path} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('INVALID_ARTIFACT', `${path} must be a positive safe integer.`);
  }
  return value;
}

function normalizeBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  fail('ARTIFACT_CONTENT_INTEGRITY', 'Agent result content is not a supported SQLite blob.');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    fail(
      'ARTIFACT_CONTENT_INTEGRITY',
      'Web Crypto SHA-256 is unavailable; Agent result content cannot be verified.',
    );
  }
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('ARTIFACT_CONTENT_INTEGRITY', 'Agent result content is not valid UTF-8.');
  }
}

function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('ARTIFACT_CONTENT_INTEGRITY', 'Agent result source arguments are not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('ARTIFACT_CONTENT_INTEGRITY', 'Agent result source arguments are not a JSON object.');
  }
  if (canonicalAgentRuntimeJson(parsed) !== value) {
    fail('ARTIFACT_CONTENT_INTEGRITY', 'Agent result source arguments are not canonical JSON.');
  }
  return parsed as Record<string, unknown>;
}

type ArtifactRow = {
  ref: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  toolAccess: string;
  idempotencyKey: string;
  argumentsJson: string;
  contentHash: string;
  contentBlob: unknown;
  byteCount: number;
  charCount: number;
  createdAt: string;
};

async function verifyArtifactRow(row: ArtifactRow): Promise<PersistedAgentRuntimeResultArtifact> {
  if (
    row.toolAccess !== 'read' ||
    !SHA256_PATTERN.test(row.contentHash) ||
    !Number.isSafeInteger(row.byteCount) ||
    row.byteCount <= 0 ||
    !Number.isSafeInteger(row.charCount) ||
    row.charCount <= 0
  ) {
    fail('ARTIFACT_CONTENT_INTEGRITY', `Agent result "${row.ref}" has invalid durable metadata.`);
  }
  const bytes = normalizeBlob(row.contentBlob);
  if (bytes.byteLength !== row.byteCount || (await sha256(bytes)) !== row.contentHash) {
    fail(
      'ARTIFACT_CONTENT_INTEGRITY',
      `Agent result "${row.ref}" failed content hash verification.`,
    );
  }
  const serialized = decodeUtf8(bytes);
  if ([...serialized].length !== row.charCount) {
    fail('ARTIFACT_CONTENT_INTEGRITY', `Agent result "${row.ref}" character count drifted.`);
  }
  return {
    ref: row.ref,
    projectId: row.projectId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolCallId: row.toolCallId,
    callId: row.callId,
    toolName: row.toolName,
    idempotencyKey: row.idempotencyKey,
    arguments: parseArguments(row.argumentsJson),
    contentHash: row.contentHash,
    byteCount: row.byteCount,
    charCount: row.charCount,
    serialized,
    createdAt: row.createdAt,
  };
}

async function selectArtifact(
  db: DbExecutor,
  input: ReadAgentRuntimeResultArtifact,
): Promise<ArtifactRow | null> {
  const rows = await db
    .select({
      ref: AgentRuntimeResultArtifactTable.ref,
      projectId: AgentRuntimeResultArtifactTable.projectId,
      sessionId: AgentRuntimeResultArtifactTable.sessionId,
      turnId: AgentRuntimeResultArtifactTable.turnId,
      toolCallId: AgentRuntimeResultArtifactTable.toolCallId,
      callId: AgentRuntimeResultArtifactTable.callId,
      toolName: AgentRuntimeResultArtifactTable.toolName,
      toolAccess: AgentRuntimeResultArtifactTable.toolAccess,
      idempotencyKey: AgentRuntimeResultArtifactTable.idempotencyKey,
      argumentsJson: AgentRuntimeResultArtifactTable.argumentsJson,
      contentHash: AgentRuntimeResultArtifactTable.contentHash,
      contentBlob: AgentRuntimeResultBlobTable.contentBlob,
      byteCount: AgentRuntimeResultBlobTable.byteCount,
      charCount: AgentRuntimeResultBlobTable.charCount,
      createdAt: AgentRuntimeResultArtifactTable.createdAt,
    })
    .from(AgentRuntimeResultArtifactTable)
    .innerJoin(
      AgentRuntimeResultBlobTable,
      eq(AgentRuntimeResultArtifactTable.contentHash, AgentRuntimeResultBlobTable.contentHash),
    )
    .where(
      and(
        eq(AgentRuntimeResultArtifactTable.ref, input.ref),
        eq(AgentRuntimeResultArtifactTable.projectId, input.projectId),
        eq(AgentRuntimeResultArtifactTable.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function assertArtifactProvenance(
  artifact: PersistedAgentRuntimeResultArtifact,
  input: PersistAgentRuntimeResultArtifact,
  contentHash: string,
  argumentsJson: string,
): void {
  if (
    artifact.ref !== input.ref ||
    artifact.projectId !== input.projectId ||
    artifact.sessionId !== input.sessionId ||
    artifact.turnId !== input.turnId ||
    artifact.toolCallId !== input.toolCallId ||
    artifact.callId !== input.callId ||
    artifact.toolName !== input.toolName ||
    artifact.idempotencyKey !== input.idempotencyKey ||
    artifact.contentHash !== contentHash ||
    canonicalAgentRuntimeJson(artifact.arguments) !== argumentsJson ||
    artifact.serialized !== input.serialized
  ) {
    fail(
      'ARTIFACT_PROVENANCE_CONFLICT',
      `Agent result "${input.ref}" conflicts with durable provenance.`,
    );
  }
}

function validatePersistInput(input: PersistAgentRuntimeResultArtifact): void {
  requireNonEmpty(input.ref, 'ref');
  requireNonEmpty(input.projectId, 'projectId');
  requireNonEmpty(input.sessionId, 'sessionId');
  requireNonEmpty(input.turnId, 'turnId');
  requireNonEmpty(input.toolCallId, 'toolCallId');
  requireNonEmpty(input.callId, 'callId');
  requireNonEmpty(input.toolName, 'toolName');
  requireNonEmpty(input.idempotencyKey, 'idempotencyKey');
  requireNonEmpty(input.createdAt, 'createdAt');
  if (typeof input.serialized !== 'string' || input.serialized.length === 0) {
    fail('INVALID_ARTIFACT', 'serialized must be a non-empty string.');
  }
  if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    fail('INVALID_ARTIFACT', 'arguments must be a JSON object.');
  }
  requirePositiveSafeInteger(input.quota.maxArtifactsPerSession, 'quota.maxArtifactsPerSession');
  requirePositiveSafeInteger(input.quota.maxBytesPerSession, 'quota.maxBytesPerSession');
}

async function assertNewArtifactWithinQuota(
  tx: DbExecutor,
  input: PersistAgentRuntimeResultArtifact,
  newByteCount: number,
): Promise<void> {
  const rows = await tx
    .select({
      byteCount: AgentRuntimeResultBlobTable.byteCount,
    })
    .from(AgentRuntimeResultArtifactTable)
    .innerJoin(
      AgentRuntimeResultBlobTable,
      eq(AgentRuntimeResultArtifactTable.contentHash, AgentRuntimeResultBlobTable.contentHash),
    )
    .where(
      and(
        eq(AgentRuntimeResultArtifactTable.projectId, input.projectId),
        eq(AgentRuntimeResultArtifactTable.sessionId, input.sessionId),
      ),
    );

  const nextCount = rows.length + 1;
  const nextBytes =
    rows.reduce((sum, row) => sum + row.byteCount, 0) + newByteCount;
  if (
    nextCount > input.quota.maxArtifactsPerSession ||
    nextBytes > input.quota.maxBytesPerSession
  ) {
    fail(
      'ARTIFACT_TOO_LARGE',
      `Agent result "${input.ref}" cannot fit its session quota without invalidating an existing result reference.`,
    );
  }
}

export function createAgentRuntimeResultArtifactRepository(
  dbOverride?: DbExecutor,
): AgentRuntimeResultArtifactRepository {
  const database = () => dbOverride ?? getDb();

  return {
    async persist(
      input: PersistAgentRuntimeResultArtifact,
    ): Promise<PersistAgentRuntimeResultArtifactResult> {
      validatePersistInput(input);
      const contentBytes = new TextEncoder().encode(input.serialized);
      if (contentBytes.byteLength > input.quota.maxBytesPerSession) {
        fail(
          'ARTIFACT_TOO_LARGE',
          `Agent result "${input.ref}" is ${contentBytes.byteLength} bytes, above its ${input.quota.maxBytesPerSession}-byte session quota.`,
        );
      }
      const contentHash = await sha256(contentBytes);
      const charCount = [...input.serialized].length;
      const argumentsJson = canonicalAgentRuntimeJson(input.arguments);

      return database().transaction(
        async (tx) => {
          const before = await selectArtifact(tx, input);
          if (before) {
            const artifact = await verifyArtifactRow(before);
            assertArtifactProvenance(artifact, input, contentHash, argumentsJson);
            return { outcome: 'duplicate', artifact, evictedRefs: [] };
          }

          await assertNewArtifactWithinQuota(
            tx,
            input,
            contentBytes.byteLength,
          );

          await tx
            .insert(AgentRuntimeResultBlobTable)
            .values({
              contentHash,
              contentBlob: contentBytes,
              byteCount: contentBytes.byteLength,
              charCount,
              createdAt: input.createdAt,
            })
            .onConflictDoNothing();

          const blobRows = await tx
            .select({
              contentHash: AgentRuntimeResultBlobTable.contentHash,
              contentBlob: AgentRuntimeResultBlobTable.contentBlob,
              byteCount: AgentRuntimeResultBlobTable.byteCount,
              charCount: AgentRuntimeResultBlobTable.charCount,
            })
            .from(AgentRuntimeResultBlobTable)
            .where(eq(AgentRuntimeResultBlobTable.contentHash, contentHash))
            .limit(1);
          const blob = blobRows[0];
          if (!blob) {
            fail(
              'ARTIFACT_CONTENT_INTEGRITY',
              `Agent result blob "${contentHash}" was not persisted.`,
            );
          }
          const persistedBytes = normalizeBlob(blob.contentBlob);
          if (
            blob.contentHash !== contentHash ||
            blob.byteCount !== contentBytes.byteLength ||
            blob.charCount !== charCount ||
            (await sha256(persistedBytes)) !== contentHash ||
            persistedBytes.byteLength !== contentBytes.byteLength ||
            !persistedBytes.every((byte, index) => byte === contentBytes[index])
          ) {
            fail(
              'ARTIFACT_CONTENT_INTEGRITY',
              `Agent result blob "${contentHash}" conflicts with existing bytes.`,
            );
          }

          await tx
            .insert(AgentRuntimeResultArtifactTable)
            .values({
              ref: input.ref,
              projectId: input.projectId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolCallId: input.toolCallId,
              callId: input.callId,
              toolName: input.toolName,
              toolAccess: 'read',
              idempotencyKey: input.idempotencyKey,
              argumentsJson,
              contentHash,
              createdAt: input.createdAt,
            })
            .onConflictDoNothing();

          const inserted = await selectArtifact(tx, input);
          if (!inserted) {
            fail(
              'ARTIFACT_PROVENANCE_CONFLICT',
              `Agent tool call "${input.toolCallId}" already owns another result reference.`,
            );
          }
          const artifact = await verifyArtifactRow(inserted);
          assertArtifactProvenance(artifact, input, contentHash, argumentsJson);
          return { outcome: 'inserted', artifact, evictedRefs: [] };
        },
        { behavior: 'immediate' },
      );
    },

    async get(
      input: ReadAgentRuntimeResultArtifact,
    ): Promise<PersistedAgentRuntimeResultArtifact | null> {
      requireNonEmpty(input.ref, 'ref');
      requireNonEmpty(input.projectId, 'projectId');
      requireNonEmpty(input.sessionId, 'sessionId');
      const row = await selectArtifact(database(), input);
      if (row) return verifyArtifactRow(row);
      const { readImportedChatArtifact } = await import('../sync/agent-chat/imported-history');
      return readImportedChatArtifact(database() as import('../lib/db').DbClient, input);
    },

    async readPage(
      input: ReadAgentRuntimeResultArtifactPage,
    ): Promise<AgentRuntimeResultArtifactPage | null> {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        fail('INVALID_ARTIFACT', 'offset must be a non-negative safe integer.');
      }
      requirePositiveSafeInteger(input.limit, 'limit');
      const row = await selectArtifact(database(), input);
      const artifact = row ? await verifyArtifactRow(row) : await (await import('../sync/agent-chat/imported-history')).readImportedChatArtifact(database() as import('../lib/db').DbClient, input);
      if (!artifact) return null;
      if (input.offset > artifact.charCount) {
        fail(
          'INVALID_ARTIFACT',
          `offset ${input.offset} exceeds Agent result "${input.ref}" length ${artifact.charCount}.`,
        );
      }
      const content = [...artifact.serialized]
        .slice(input.offset, input.offset + input.limit)
        .join('');
      const nextOffset = Math.min(artifact.charCount, input.offset + [...content].length);
      return {
        ref: artifact.ref,
        projectId: artifact.projectId,
        sessionId: artifact.sessionId,
        turnId: artifact.turnId,
        toolCallId: artifact.toolCallId,
        callId: artifact.callId,
        toolName: artifact.toolName,
        idempotencyKey: artifact.idempotencyKey,
        arguments: artifact.arguments,
        contentHash: artifact.contentHash,
        byteCount: artifact.byteCount,
        charCount: artifact.charCount,
        createdAt: artifact.createdAt,
        offset: input.offset,
        nextOffset,
        truncated: nextOffset < artifact.charCount,
        content,
      };
    },

    async collectGarbage(
      input: CollectAgentRuntimeResultArtifacts,
    ): Promise<AgentRuntimeResultArtifactGcResult> {
      requireNonEmpty(input.expiresBefore, 'expiresBefore');
      const expiresAt = new Date(input.expiresBefore);
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.toISOString() !== input.expiresBefore
      ) {
        fail(
          'INVALID_ARTIFACT',
          'expiresBefore must be a canonical UTC ISO timestamp.',
        );
      }
      if (input.sessionId && !input.projectId) {
        fail('INVALID_ARTIFACT', 'sessionId garbage collection must also bind projectId.');
      }
      return database().transaction(
        async (tx) => {
          const scope = and(
            // A live chat may still be waiting for its first portable export.
            notExists(tx.select({ id: AgentConversationTable.id }).from(AgentConversationTable).innerJoin(AgentRuntimeSessionTable, eq(AgentRuntimeSessionTable.conversationId, AgentConversationTable.id)).where(and(eq(AgentRuntimeSessionTable.id, AgentRuntimeResultArtifactTable.sessionId), isNull(AgentConversationTable.deletedAt)))),
            lt(
              AgentRuntimeResultArtifactTable.createdAt,
              expiresAt.toISOString(),
            ),
            ...(input.projectId
              ? [eq(AgentRuntimeResultArtifactTable.projectId, input.projectId)]
              : []),
            ...(input.sessionId
              ? [eq(AgentRuntimeResultArtifactTable.sessionId, input.sessionId)]
              : []),
          );
          const refs = await tx
            .select({ ref: AgentRuntimeResultArtifactTable.ref })
            .from(AgentRuntimeResultArtifactTable)
            .where(scope);
          const beforeBlobRows = await tx
            .select({
              count: sql<number>`count(*)`,
            })
            .from(AgentRuntimeResultBlobTable);
          if (refs.length > 0) {
            await tx.delete(AgentRuntimeResultArtifactTable).where(
              inArray(
                AgentRuntimeResultArtifactTable.ref,
                refs.map((row) => row.ref),
              ),
            );
          }
          const afterBlobRows = await tx
            .select({
              count: sql<number>`count(*)`,
            })
            .from(AgentRuntimeResultBlobTable);
          return {
            deletedArtifacts: refs.length,
            deletedBlobs:
              Number(beforeBlobRows[0]?.count ?? 0) - Number(afterBlobRows[0]?.count ?? 0),
          };
        },
        { behavior: 'immediate' },
      );
    },
  };
}
