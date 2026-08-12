import { and, eq } from 'drizzle-orm';

import type {
  AgentRuntimeEntityWriteKind,
  AgentRuntimeEntityWriteSnapshot,
  AgentRuntimeEntityWriteTool,
  CreateAgentRuntimeEntityWriteReceipt,
  PersistedAgentRuntimeEntityWriteReceipt,
} from '../domain/agent-runtime-entity-write-receipt';
import { isDriftingDomainWriteToolName } from '../lib/agent/runtime/drifting-workspace-tool-contract';
import { getDb, type DbExecutor } from '../lib/db';
import { hashEntityWriteValue } from '../lib/agent/runtime/entity-write-revision';
import {
  AgentRuntimeEntityWriteReceiptTable,
  AgentRuntimeWriteEffectTable,
} from '../schema/drizzle';
import { canonicalAgentRuntimeJson } from './agent-runtime-persistence-repo';

export class AgentRuntimeEntityWriteReceiptError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ENTITY_WRITE_RECEIPT'
      | 'ENTITY_WRITE_RECEIPT_CONFLICT'
      | 'ENTITY_WRITE_RECEIPT_INTEGRITY',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeEntityWriteReceiptError';
  }
}

export interface AgentRuntimeEntityWriteReceiptRepository {
  persist(
    input: CreateAgentRuntimeEntityWriteReceipt,
  ): Promise<PersistedAgentRuntimeEntityWriteReceipt>;
  get(
    commandId: string,
    direction: 'forward' | 'inverse',
  ): Promise<PersistedAgentRuntimeEntityWriteReceipt | null>;
}

const TOOL_KIND: Record<
  AgentRuntimeEntityWriteTool,
  AgentRuntimeEntityWriteKind
> = {
  create_comment: 'comment',
  update_comment: 'comment',
  delete_comment: 'comment',
  set_comment_status: 'comment',
  set_comment_kind: 'comment',
  create_node: 'node',
  delete_node: 'node',
  create_element: 'element',
  delete_element: 'element',
  create_storyline: 'storyline',
  delete_storyline: 'storyline',
  create_category: 'category',
  update_category: 'category',
  delete_category: 'category',
  add_relation: 'relation',
  update_relation_kind: 'relation',
  remove_relation: 'relation',
  create_relation_type: 'relation_type',
  update_relation_type: 'relation_type',
  delete_relation_type: 'relation_type',
  set_storyline_membership: 'storyline_membership',
  remember: 'memory',
  update_memory: 'memory',
  forget: 'memory',
  update_element: 'element',
  update_storyline: 'storyline',
  update_project_facts: 'project',
};

const CREATE_TOOLS = new Set<AgentRuntimeEntityWriteTool>([
  'create_comment',
  'create_node',
  'create_element',
  'create_storyline',
  'create_category',
  'add_relation',
  'create_relation_type',
  'remember',
]);

const DELETE_TOOLS = new Set<AgentRuntimeEntityWriteTool>([
  'delete_comment',
  'delete_node',
  'delete_element',
  'delete_storyline',
  'delete_category',
  'remove_relation',
  'delete_relation_type',
]);

function effectOwnsReceiptTool(
  effect: { toolName: string; argumentsJson: string },
  toolName: AgentRuntimeEntityWriteTool,
): boolean {
  if (effect.toolName === toolName) return true;
  if (!isDriftingDomainWriteToolName(effect.toolName)) {
    return false;
  }
  const arguments_ = parseStoredJson(effect.argumentsJson, effect.toolName);
  if (!isRecord(arguments_)) return false;
  const command = arguments_.__workspaceCommand;
  return isRecord(command) && command.name === toolName;
}

function integrityError(receiptId: string, detail: string): never {
  throw new AgentRuntimeEntityWriteReceiptError(
    'ENTITY_WRITE_RECEIPT_INTEGRITY',
    `Entity write receipt ${receiptId} failed its immutable payload check: ${detail}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredJson(value: string, receiptId: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    integrityError(receiptId, 'persisted JSON is malformed');
  }
}

function parseSnapshot(
  value: unknown,
  receiptId: string,
  expectedKind: AgentRuntimeEntityWriteKind,
): AgentRuntimeEntityWriteSnapshot {
  if (
    !isRecord(value) ||
    value.kind !== expectedKind ||
    !isRecord(value.value) ||
    typeof value.value.id !== 'string' ||
    !value.value.id.trim() ||
    typeof value.value.updatedAt !== 'string' ||
    !value.value.updatedAt.trim()
  ) {
    integrityError(receiptId, `${expectedKind} snapshot has an invalid shape`);
  }
  const projectId =
    expectedKind === 'project'
      ? value.value.id
      : value.value.projectId;
  if (typeof projectId !== 'string' || !projectId.trim()) {
    integrityError(receiptId, `${expectedKind} snapshot has no project identity`);
  }
  switch (expectedKind) {
    case 'element':
      if (
        typeof value.value.name !== 'string' ||
        typeof value.value.summary !== 'string' ||
        typeof value.value.kvJson !== 'string' ||
        !Array.isArray(value.value.aliases)
      ) {
        integrityError(receiptId, 'element snapshot fields are invalid');
      }
      break;
    case 'node':
      if (
        typeof value.value.title !== 'string' ||
        (value.value.kind !== 'chapter' && value.value.kind !== 'drift') ||
        typeof value.value.summary !== 'string'
      ) {
        integrityError(receiptId, 'node snapshot fields are invalid');
      }
      break;
    case 'storyline':
      if (
        typeof value.value.name !== 'string' ||
        typeof value.value.summary !== 'string' ||
        typeof value.value.kvJson !== 'string'
      ) {
        integrityError(receiptId, 'storyline snapshot fields are invalid');
      }
      break;
    case 'project':
      if (
        typeof value.value.name !== 'string' ||
        typeof value.value.kvJson !== 'string'
      ) {
        integrityError(receiptId, 'project snapshot fields are invalid');
      }
      break;
    case 'comment':
      if (
        typeof value.value.bodyJson !== 'string' ||
        typeof value.value.kind !== 'string' ||
        typeof value.value.source !== 'string' ||
        typeof value.value.authorKind !== 'string'
      ) {
        integrityError(receiptId, 'comment snapshot fields are invalid');
      }
      break;
    case 'category':
      if (
        typeof value.value.name !== 'string' ||
        typeof value.value.contentJson !== 'string' ||
        typeof value.value.elementTemplateJson !== 'string' ||
        typeof value.value.elementTemplateKvJson !== 'string'
      ) {
        integrityError(receiptId, 'category snapshot fields are invalid');
      }
      break;
    case 'relation':
      if (
        typeof value.value.fromKind !== 'string' ||
        typeof value.value.fromId !== 'string' ||
        typeof value.value.toKind !== 'string' ||
        typeof value.value.toId !== 'string'
      ) {
        integrityError(receiptId, 'relation snapshot fields are invalid');
      }
      break;
    case 'relation_type':
      if (
        typeof value.value.name !== 'string' ||
        typeof value.value.orientation !== 'string' ||
        typeof value.value.sourceRole !== 'string' ||
        typeof value.value.targetRole !== 'string' ||
        !Array.isArray(value.value.sourceKinds) ||
        !Array.isArray(value.value.targetKinds)
      ) {
        integrityError(receiptId, 'relation type snapshot fields are invalid');
      }
      break;
    case 'storyline_membership':
      if (
        !Array.isArray(value.value.links) ||
        !value.value.links.every(
          (link) =>
            isRecord(link) &&
            typeof link.nodeId === 'string' &&
            Boolean(link.nodeId) &&
            typeof link.storylineId === 'string' &&
            Boolean(link.storylineId) &&
            typeof link.isPrimary === 'boolean',
        )
      ) {
        integrityError(receiptId, 'storyline membership snapshot fields are invalid');
      }
      break;
    case 'memory':
      if (
        typeof value.value.kind !== 'string' ||
        typeof value.value.body !== 'string' ||
        typeof value.value.source !== 'string' ||
        typeof value.value.status !== 'string' ||
        typeof value.value.createdAt !== 'string'
      ) {
        integrityError(receiptId, 'memory snapshot fields are invalid');
      }
      break;
  }
  return value as AgentRuntimeEntityWriteSnapshot;
}

function toDomain(
  row: typeof AgentRuntimeEntityWriteReceiptTable.$inferSelect,
): PersistedAgentRuntimeEntityWriteReceipt {
  const entityKind =
    row.entityKind as PersistedAgentRuntimeEntityWriteReceipt['entityKind'];
  return {
    id: row.id,
    effectId: row.effectId,
    commandId: row.commandId,
    direction:
      row.direction as PersistedAgentRuntimeEntityWriteReceipt['direction'],
    projectId: row.projectId,
    sessionId: row.sessionId,
    toolName:
      row.toolName as PersistedAgentRuntimeEntityWriteReceipt['toolName'],
    entityKind,
    entityId: row.entityId,
    expectedRevision: row.expectedRevision ?? null,
    resultRevision: row.resultRevision ?? null,
    preimage:
      row.preimageJson === null
        ? null
        : parseSnapshot(
            parseStoredJson(row.preimageJson, row.id),
            row.id,
            entityKind,
          ),
    preimageHash: row.preimageHash ?? null,
    postimage:
      row.postimageJson === null
        ? null
        : parseSnapshot(
            parseStoredJson(row.postimageJson, row.id),
            row.id,
            entityKind,
          ),
    postimageHash: row.postimageHash ?? null,
    createdAt: row.createdAt,
  };
}

function sameReceipt(
  left: PersistedAgentRuntimeEntityWriteReceipt,
  right: CreateAgentRuntimeEntityWriteReceipt,
): boolean {
  return (
    left.id === right.id &&
    left.effectId === right.effectId &&
    left.commandId === right.commandId &&
    left.direction === right.direction &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.toolName === right.toolName &&
    left.entityKind === right.entityKind &&
    left.entityId === right.entityId &&
    left.expectedRevision === right.expectedRevision &&
    left.resultRevision === right.resultRevision &&
    left.preimageHash === right.preimageHash &&
    left.postimageHash === right.postimageHash &&
    canonicalAgentRuntimeJson(left.preimage) ===
      canonicalAgentRuntimeJson(right.preimage) &&
    canonicalAgentRuntimeJson(left.postimage) ===
      canonicalAgentRuntimeJson(right.postimage) &&
    left.createdAt === right.createdAt
  );
}

export function createAgentRuntimeEntityWriteReceiptRepository(
  dbOverride?: DbExecutor,
): AgentRuntimeEntityWriteReceiptRepository {
  const db = () => dbOverride ?? getDb();

  const getRaw = async (
    commandId: string,
    direction: 'forward' | 'inverse',
  ): Promise<PersistedAgentRuntimeEntityWriteReceipt | null> => {
    const rows = await db()
      .select()
      .from(AgentRuntimeEntityWriteReceiptTable)
      .where(
        and(
          eq(AgentRuntimeEntityWriteReceiptTable.commandId, commandId),
          eq(AgentRuntimeEntityWriteReceiptTable.direction, direction),
        ),
      )
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const validate = async (
    receipt: PersistedAgentRuntimeEntityWriteReceipt,
  ): Promise<void> => {
    const effects = await db()
      .select({
        id: AgentRuntimeWriteEffectTable.id,
        projectId: AgentRuntimeWriteEffectTable.projectId,
        sessionId: AgentRuntimeWriteEffectTable.sessionId,
        toolName: AgentRuntimeWriteEffectTable.toolName,
        argumentsJson: AgentRuntimeWriteEffectTable.argumentsJson,
        idempotencyKey: AgentRuntimeWriteEffectTable.idempotencyKey,
      })
      .from(AgentRuntimeWriteEffectTable)
      .where(eq(AgentRuntimeWriteEffectTable.id, receipt.effectId))
      .limit(1);
    const effect = effects[0];
    const expectedId = `agent-entity-write-receipt:${receipt.effectId}:${receipt.direction}`;
    const expectedCommandId = `agent-entity-write:${effect?.idempotencyKey ?? ''}`;
    if (
      !effect ||
      receipt.id !== expectedId ||
      receipt.commandId !== expectedCommandId ||
      effect.projectId !== receipt.projectId ||
      effect.sessionId !== receipt.sessionId ||
      !effectOwnsReceiptTool(effect, receipt.toolName) ||
      TOOL_KIND[receipt.toolName] !== receipt.entityKind
    ) {
      integrityError(receipt.id, 'receipt provenance is inconsistent');
    }
    const snapshots = [
      ['preimage', receipt.preimage, receipt.preimageHash],
      ['postimage', receipt.postimage, receipt.postimageHash],
    ] as const;
    for (const [label, snapshot, hash] of snapshots) {
      if ((snapshot === null) !== (hash === null)) {
        integrityError(receipt.id, `${label} hash pairing is invalid`);
      }
      if (
        snapshot &&
        (snapshot.kind !== receipt.entityKind ||
          snapshot.value.id !== receipt.entityId ||
          (receipt.entityKind === 'project'
            ? snapshot.value.id !== receipt.projectId
            : (snapshot.value as { projectId?: string }).projectId !==
              receipt.projectId) ||
          (await hashEntityWriteValue(snapshot)) !== hash)
      ) {
        integrityError(receipt.id, `${label} does not match the target`);
      }
    }
    if (
      (receipt.postimage === null) !== (receipt.resultRevision === null) ||
      (receipt.postimage &&
        receipt.resultRevision !== receipt.postimage.value.updatedAt)
    ) {
      integrityError(receipt.id, 'result revision does not match postimage');
    }
    if (receipt.direction === 'forward') {
      if (!receipt.expectedRevision) {
        integrityError(receipt.id, 'forward receipt has no expected state');
      }
      if (CREATE_TOOLS.has(receipt.toolName)) {
        if (receipt.preimage !== null || receipt.postimage === null) {
          integrityError(receipt.id, 'create receipt has invalid before/after state');
        }
      } else if (DELETE_TOOLS.has(receipt.toolName)) {
        if (receipt.preimage === null || receipt.postimage !== null) {
          integrityError(receipt.id, 'delete receipt has invalid before/after state');
        }
      } else if (receipt.preimage === null || receipt.postimage === null) {
        integrityError(receipt.id, 'update receipt has invalid before/after state');
      }
    }
    if (receipt.direction === 'inverse') {
      const forward = await getRaw(receipt.commandId, 'forward');
      if (
        !forward ||
        forward.effectId !== receipt.effectId ||
        forward.resultRevision !== receipt.expectedRevision ||
        canonicalAgentRuntimeJson(forward.preimage) !==
          canonicalAgentRuntimeJson(receipt.preimage)
      ) {
        integrityError(receipt.id, 'inverse is not paired to its forward');
      }
    }
  };

  const get: AgentRuntimeEntityWriteReceiptRepository['get'] = async (
    commandId,
    direction,
  ) => {
    const receipt = await getRaw(commandId, direction);
    if (!receipt) return null;
    await validate(receipt);
    return receipt;
  };

  return {
    get,

    async persist(input) {
      if (
        !Object.prototype.hasOwnProperty.call(TOOL_KIND, input.toolName) ||
        TOOL_KIND[input.toolName] !== input.entityKind ||
        (input.direction !== 'forward' && input.direction !== 'inverse')
      ) {
        throw new AgentRuntimeEntityWriteReceiptError(
          'INVALID_ENTITY_WRITE_RECEIPT',
          'Entity write receipt has an unsupported tool, kind, or direction.',
        );
      }
      await validate(input);
      const existing = await get(input.commandId, input.direction);
      if (existing) {
        if (sameReceipt(existing, input)) return existing;
        throw new AgentRuntimeEntityWriteReceiptError(
          'ENTITY_WRITE_RECEIPT_CONFLICT',
          `Entity write command ${input.commandId}:${input.direction} already has a different receipt.`,
        );
      }
      await db().insert(AgentRuntimeEntityWriteReceiptTable).values({
        id: input.id,
        effectId: input.effectId,
        commandId: input.commandId,
        direction: input.direction,
        projectId: input.projectId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        entityKind: input.entityKind,
        entityId: input.entityId,
        expectedRevision: input.expectedRevision,
        resultRevision: input.resultRevision,
        preimageJson:
          input.preimage === null
            ? null
            : canonicalAgentRuntimeJson(input.preimage),
        preimageHash: input.preimageHash,
        postimageJson:
          input.postimage === null
            ? null
            : canonicalAgentRuntimeJson(input.postimage),
        postimageHash: input.postimageHash,
        createdAt: input.createdAt,
      });
      const inserted = await get(input.commandId, input.direction);
      if (!inserted || !sameReceipt(inserted, input)) {
        throw new AgentRuntimeEntityWriteReceiptError(
          'ENTITY_WRITE_RECEIPT_INTEGRITY',
          `Entity write receipt ${input.id} was not persisted exactly.`,
        );
      }
      return inserted;
    },
  };
}
